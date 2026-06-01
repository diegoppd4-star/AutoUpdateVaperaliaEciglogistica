import { createHash } from "node:crypto";
import { Product } from "./types.js";
import { extractReferenceBody, isHardwareReference } from "./sku-builder.js";

export interface MatchResult {
  products: Product[];
  matchedPairs: number;
  unmatchedCount: number;
}

// ---------------------------------------------------------------------------
// Normalization helpers
// ---------------------------------------------------------------------------

function normalizeBrand(brand: string): string {
  return brand
    .toLowerCase()
    .replace(
      /\b(e-?liquids?|nic\s*salts?|salts?|vapes?|labs?|liquids?|flavou?rs?)\b/g,
      ""
    )
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeNameForMatching(name: string, brandCandidates?: string[]): string {
  let n = name.toLowerCase();
  // Remove specs with units (these vary between distributors)
  n = n.replace(/\b\d+\s*ml\b/g, "");
  n = n.replace(/\b\d+\s*mah\b/g, "");
  n = n.replace(/\b\d+\s*w\b/g, "");
  n = n.replace(/\b\d+\s*puffs?\b/g, "");
  n = n.replace(/\b\d+\s*mg\b/g, "");
  n = n.replace(/\b\d+\s*ohm\b/g, "");
  n = n.replace(/\(\d+\s*pcs\)/g, "");
  n = n.replace(/\(pack\s*\d+\)/gi, "");
  // Remove all brand aliases (already used for blocking, adds noise to similarity)
  for (const b of brandCandidates ?? []) {
    const escaped = b.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    n = n.replace(new RegExp(`\\b${escaped}\\b`, "g"), "");
  }
  // Remove generic product-type words (EN + ES) that differ between distributors
  n = n.replace(
    /\b(kit|pod|pods|mod|mods|coil|coils|replacement|empty|drip\s*tip|glass|case|starter|vape|resistencias?|dep[oó]sitos?|pyrex|boquillas?|algod[oó]n|accesorios?)\b/g,
    ""
  );
  // Remove Spanish noise words
  n = n.replace(/\b(para|con|de|del|las?|los?|una?|el|y)\b/g, "");
  // Normalize punctuation
  n = n.replace(/[+&/\\()\[\]{}.;:!?'"_,]/g, " ");
  n = n.replace(/\s*-\s*/g, " ");
  n = n.replace(/\s+/g, " ").trim();
  return n;
}

function tokenize(name: string): string[] {
  // Keep all tokens: single letters (s, g, x) are model identifiers after noise removal
  return name.split(" ").filter((t) => t.length > 0);
}

function generateSku(brand: string | undefined, normalizedName: string): string {
  const prefix = brand
    ? brand
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
    : "unknown";
  const hash = createHash("sha256")
    .update(normalizedName)
    .digest("hex")
    .slice(0, 8);
  return `${prefix}-${hash}`.toUpperCase();
}

// ---------------------------------------------------------------------------
// Profile: represents a unique base product (by URL) for matching
// ---------------------------------------------------------------------------

interface Profile {
  url: string;
  baseName: string;
  normalizedName: string;
  tokens: string[];
  tfidf: Map<string, number>;
  brand?: string;
  normalizedBrand?: string;
  brandCandidates?: string[];
  normalizedBrandCandidates?: string[];
  reference?: string;
  syntheticReference?: string;
  distributor: string;
}

// ---------------------------------------------------------------------------
// TF-IDF
// ---------------------------------------------------------------------------

function computeIdf(
  profiles: Profile[]
): Map<string, number> {
  const docFreq = new Map<string, number>();
  for (const p of profiles) {
    const unique = new Set(p.tokens);
    for (const t of unique) {
      docFreq.set(t, (docFreq.get(t) ?? 0) + 1);
    }
  }
  const N = profiles.length;
  const idf = new Map<string, number>();
  for (const [token, df] of docFreq) {
    idf.set(token, Math.log(N / df));
  }
  return idf;
}

function computeTfidf(
  tokens: string[],
  idf: Map<string, number>
): Map<string, number> {
  const tf = new Map<string, number>();
  for (const t of tokens) {
    tf.set(t, (tf.get(t) ?? 0) + 1);
  }
  const result = new Map<string, number>();
  for (const [t, count] of tf) {
    result.set(t, count * (idf.get(t) ?? 0));
  }
  return result;
}

function cosineSimilarity(
  a: Map<string, number>,
  b: Map<string, number>
): number {
  let dot = 0;
  for (const [token, wa] of a) {
    const wb = b.get(token);
    if (wb !== undefined) dot += wa * wb;
  }
  if (dot === 0) return 0;

  let magA = 0;
  for (const v of a.values()) magA += v * v;
  let magB = 0;
  for (const v of b.values()) magB += v * v;

  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

// ---------------------------------------------------------------------------
// Variant matching helpers
// ---------------------------------------------------------------------------

function getVariantSignature(product: Product): string {
  if (!product.variants || Object.keys(product.variants).length === 0) return "";
  return Object.entries(product.variants)
    .map(([k, v]) => [k.toLowerCase().trim(), v.toLowerCase().trim()] as const)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([, v]) => v)
    .join(" ")
    // Strip spec-like values that differ between distributors
    .replace(/\b\d+\s*(ml|mah|w|ohm|mg|puffs?|pcs)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function variantSimilarity(a: string, b: string): number {
  if (a === b) return 1.0;
  if (!a || !b) return 0;

  const tokensA = new Set(a.split(/\s+/).filter((t) => t.length > 0));
  const tokensB = new Set(b.split(/\s+/).filter((t) => t.length > 0));
  if (tokensA.size === 0 || tokensB.size === 0) return 0;

  let intersection = 0;
  for (const t of tokensA) {
    if (tokensB.has(t)) intersection++;
  }
  if (intersection === 0) return 0;

  // Use the larger of Jaccard and containment score.
  // Containment handles "black" vs "polar black" (1/1 = 1.0 containment)
  const jaccard =
    intersection / new Set([...tokensA, ...tokensB]).size;
  const smaller = Math.min(tokensA.size, tokensB.size);
  const containment = intersection / smaller;

  // Blend: containment-weighted when one side is a subset of the other
  return Math.max(jaccard, containment * 0.85);
}

function slugifyVariant(product: Product): string {
  if (!product.variants || Object.keys(product.variants).length === 0) return "";
  return Object.entries(product.variants)
    .sort(([a], [b]) => a.toLowerCase().localeCompare(b.toLowerCase()))
    .map(([, v]) => v)
    .join("-")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

// ---------------------------------------------------------------------------
// Main matching function
// ---------------------------------------------------------------------------

function findBrandCandidates(
  normCandidates: string[] | undefined,
  ecigByBrand: Map<string, number[]>
): Set<number> | null {
  if (!normCandidates?.length) return null;

  const candidates = new Set<number>();
  for (const brand of normCandidates) {
    // Exact match
    if (ecigByBrand.has(brand)) {
      for (const i of ecigByBrand.get(brand)!) candidates.add(i);
    }
    // Substring containment: "dinner lady sweets" matches "dinner lady"
    for (const [ecigBrand, indices] of ecigByBrand) {
      if (
        (brand.length > 2 && ecigBrand.includes(brand)) ||
        (ecigBrand.length > 2 && brand.includes(ecigBrand))
      ) {
        for (const i of indices) candidates.add(i);
      }
    }
  }

  return candidates.size > 0 ? candidates : null;
}

const MATCH_THRESHOLD = 0.45;
const VARIANT_MATCH_THRESHOLD = 0.6;

export function matchProducts(allProducts: Product[]): MatchResult {
  // 1. Deduplicate by URL → get unique base products
  const byUrl = new Map<string, Product>();
  for (const p of allProducts) {
    if (!byUrl.has(p.url)) {
      byUrl.set(p.url, p);
    }
  }

  // 2. Build profiles
  const profiles: Profile[] = [];
  for (const [url, p] of byUrl) {
    // Extract base name (strip variant suffix added by expandVariants)
    let baseName = p.name;
    const variants = p.variants;
    if (variants && Object.keys(variants).length > 0) {
      const suffix = Object.values(variants).join(" / ");
      if (baseName.endsWith(" - " + suffix)) {
        baseName = baseName.slice(0, -(suffix.length + 3));
      }
    }

    const normalizedBrand = p.brand ? normalizeBrand(p.brand) : undefined;
    const normalizedBrandCandidates = p.brandCandidates?.map(normalizeBrand);
    const normalizedName = normalizeNameForMatching(baseName, p.brandCandidates);
    const tokens = tokenize(normalizedName);

    profiles.push({
      url,
      baseName,
      normalizedName,
      tokens,
      tfidf: new Map(), // computed below
      brand: p.brand,
      normalizedBrand,
      brandCandidates: p.brandCandidates,
      normalizedBrandCandidates,
      reference: p.reference,
      syntheticReference: p.syntheticReference,
      distributor: p.distributor,
    });
  }

  // 3. Compute TF-IDF
  const idf = computeIdf(profiles);
  for (const p of profiles) {
    p.tfidf = computeTfidf(p.tokens, idf);
  }

  // 4. Separate by distributor
  const vapProfiles = profiles.filter((p) => p.distributor === "Vaperalia");
  const ecigProfiles = profiles.filter((p) => p.distributor === "Eciglogistica");

  console.log(
    `[Matcher] Profiles — Vaperalia: ${vapProfiles.length}, Eciglogistica: ${ecigProfiles.length}`
  );

  // 4b. Body-match pre-pass: match hardware products by synthetic reference body
  const bodyMatches: Array<{ vap: Profile; ecig: Profile; score: number }> = [];
  const bodyMatchedVapUrls = new Set<string>();
  const bodyMatchedEcigUrls = new Set<string>();

  // Build index: Vaperalia reference body -> profile index
  const vapBodyIndex = new Map<string, number>();
  for (let vi = 0; vi < vapProfiles.length; vi++) {
    const vp = vapProfiles[vi];
    if (!vp.reference || !isHardwareReference(vp.reference)) continue;
    const body = extractReferenceBody(vp.reference);
    if (body) vapBodyIndex.set(body, vi);
  }

  // Match Eciglogistica syntheticReference bodies against Vaperalia
  for (let ei = 0; ei < ecigProfiles.length; ei++) {
    const ep = ecigProfiles[ei];
    if (!ep.syntheticReference) continue;
    const body = extractReferenceBody(ep.syntheticReference);
    if (!body) continue;

    const vi = vapBodyIndex.get(body);
    if (vi === undefined) continue;

    const vp = vapProfiles[vi];

    // Verify brands match (loose) — any candidate overlap counts
    const vCands = vp.normalizedBrandCandidates ?? (vp.normalizedBrand ? [vp.normalizedBrand] : []);
    const eCands = ep.normalizedBrandCandidates ?? (ep.normalizedBrand ? [ep.normalizedBrand] : []);
    if (vCands.length > 0 && eCands.length > 0) {
      const brandsMatch = vCands.some((v) =>
        eCands.some(
          (e) =>
            v === e ||
            (v.length > 2 && e.includes(v)) ||
            (e.length > 2 && v.includes(e))
        )
      );
      if (!brandsMatch) continue;
    }

    bodyMatches.push({ vap: vp, ecig: ep, score: 1.0 });
    bodyMatchedVapUrls.add(vp.url);
    bodyMatchedEcigUrls.add(ep.url);
  }

  console.log(
    `[Matcher] Body pre-pass: ${bodyMatches.length} hardware matches by synthetic reference`
  );

  // 5. Build inverted index on ecig profiles for blocking
  const ecigIndex = new Map<string, number[]>();
  for (let i = 0; i < ecigProfiles.length; i++) {
    for (const token of new Set(ecigProfiles[i].tokens)) {
      let list = ecigIndex.get(token);
      if (!list) {
        list = [];
        ecigIndex.set(token, list);
      }
      list.push(i);
    }
  }

  // 6. Group ecig profiles by normalized brand for brand-based blocking
  // Index ALL brand candidates so aliases resolve to the same products
  const ecigByBrand = new Map<string, number[]>();
  for (let i = 0; i < ecigProfiles.length; i++) {
    const nbs = ecigProfiles[i].normalizedBrandCandidates
      ?? (ecigProfiles[i].normalizedBrand ? [ecigProfiles[i].normalizedBrand!] : []);
    for (const nb of nbs) {
      let list = ecigByBrand.get(nb);
      if (!list) {
        list = [];
        ecigByBrand.set(nb, list);
      }
      list.push(i);
    }
  }

  // 7. Find matches
  const rawMatches: Array<{ vapIdx: number; ecigIdx: number; score: number }> =
    [];
  let comparisons = 0;
  let skippedNoBrand = 0;

  for (let vi = 0; vi < vapProfiles.length; vi++) {
    const vp = vapProfiles[vi];

    // Skip products already matched by body pre-pass
    if (bodyMatchedVapUrls.has(vp.url)) continue;

    // Get candidates: prefer brand-based blocking, fallback to token-based
    let candidateIndices: Set<number>;

    // Brand-based blocking: any candidate alias overlap
    const normCands = vp.normalizedBrandCandidates ?? (vp.normalizedBrand ? [vp.normalizedBrand] : undefined);
    const brandCandidates = findBrandCandidates(normCands, ecigByBrand);
    if (brandCandidates) {
      // Exclude ecig products already matched by body pre-pass
      candidateIndices = new Set<number>();
      for (const ei of brandCandidates) {
        if (!bodyMatchedEcigUrls.has(ecigProfiles[ei].url)) {
          candidateIndices.add(ei);
        }
      }
    } else {
      // No brand match → skip (don't match across different/unknown brands)
      candidateIndices = new Set<number>();
      skippedNoBrand++;
    }

    let bestScore = 0;
    let bestEcigIdx = -1;

    for (const ei of candidateIndices) {
      const ep = ecigProfiles[ei];
      const score = cosineSimilarity(vp.tfidf, ep.tfidf);
      comparisons++;
      if (score > bestScore) {
        bestScore = score;
        bestEcigIdx = ei;
      }
    }

    if (bestScore >= MATCH_THRESHOLD && bestEcigIdx >= 0) {
      rawMatches.push({ vapIdx: vi, ecigIdx: bestEcigIdx, score: bestScore });
    }
  }

  console.log(
    `[Matcher] Comparisons: ${comparisons.toLocaleString()}, raw matches: ${rawMatches.length}, skipped (no brand match): ${skippedNoBrand}`
  );

  // 8. Greedy 1:1 assignment (best scores first)
  rawMatches.sort((a, b) => b.score - a.score);
  const usedVap = new Set<number>();
  const usedEcig = new Set<number>();
  const finalMatches: Array<{ vap: Profile; ecig: Profile; score: number }> =
    [];

  for (const { vapIdx, ecigIdx, score } of rawMatches) {
    if (usedVap.has(vapIdx) || usedEcig.has(ecigIdx)) continue;
    usedVap.add(vapIdx);
    usedEcig.add(ecigIdx);
    finalMatches.push({
      vap: vapProfiles[vapIdx],
      ecig: ecigProfiles[ecigIdx],
      score,
    });
  }

  // Combine body matches (pre-pass) with TF-IDF matches
  const allFinalMatches = [...bodyMatches, ...finalMatches];

  console.log(
    `[Matcher] Final 1:1 base matches: ${allFinalMatches.length} (${bodyMatches.length} body + ${finalMatches.length} TF-IDF)`
  );

  // 9. Variant-level matching and SKU assignment

  // Group all product rows by URL
  const productsByUrl = new Map<string, Product[]>();
  for (const p of allProducts) {
    if (!productsByUrl.has(p.url)) productsByUrl.set(p.url, []);
    productsByUrl.get(p.url)!.push(p);
  }

  let variantMatchCount = 0;
  let variantUnmatchedCount = 0;
  const processedUrls = new Set<string>();
  const sampleVariantMatches: string[] = [];

  // Process matched base product pairs → match variants within each pair
  for (const { vap, ecig } of allFinalMatches) {
    const baseSku =
      vap.reference || generateSku(vap.brand, vap.normalizedName);

    const vapRows = productsByUrl.get(vap.url) || [];
    const ecigRows = productsByUrl.get(ecig.url) || [];
    processedUrls.add(vap.url);
    processedUrls.add(ecig.url);

    // Products without variants → base SKU only
    const vapHasVariants = vapRows.some(
      (r) => r.variants && Object.keys(r.variants).length > 0
    );
    const ecigHasVariants = ecigRows.some(
      (r) => r.variants && Object.keys(r.variants).length > 0
    );

    if (!vapHasVariants && !ecigHasVariants) {
      for (const r of vapRows) r.sku = baseSku;
      for (const r of ecigRows) r.sku = baseSku;
      variantMatchCount++;
      continue;
    }

    // Build variant similarity matrix
    const pairs: Array<{ vi: number; ei: number; score: number }> = [];
    for (let vi = 0; vi < vapRows.length; vi++) {
      const vSig = getVariantSignature(vapRows[vi]);
      for (let ei = 0; ei < ecigRows.length; ei++) {
        const eSig = getVariantSignature(ecigRows[ei]);
        const score = variantSimilarity(vSig, eSig);
        if (score >= VARIANT_MATCH_THRESHOLD) {
          pairs.push({ vi, ei, score });
        }
      }
    }

    // Greedy 1:1 variant assignment
    pairs.sort((a, b) => b.score - a.score);
    const usedV = new Set<number>();
    const usedE = new Set<number>();

    for (const { vi, ei } of pairs) {
      if (usedV.has(vi) || usedE.has(ei)) continue;
      usedV.add(vi);
      usedE.add(ei);

      const suffix =
        slugifyVariant(vapRows[vi]) || slugifyVariant(ecigRows[ei]);
      const variantSku = suffix ? `${baseSku}-${suffix}` : baseSku;
      vapRows[vi].sku = variantSku;
      ecigRows[ei].sku = variantSku;
      variantMatchCount++;

      if (sampleVariantMatches.length < 5) {
        const vName = Object.values(vapRows[vi].variants || {}).join("/");
        const eName = Object.values(ecigRows[ei].variants || {}).join("/");
        sampleVariantMatches.push(
          `  "${vap.baseName}" [${vName}] ↔ [${eName}] → ${variantSku}`
        );
      }
    }

    // Unmatched variants → own SKU (same base, different suffix)
    for (let vi = 0; vi < vapRows.length; vi++) {
      if (!usedV.has(vi)) {
        const suffix = slugifyVariant(vapRows[vi]);
        vapRows[vi].sku = suffix ? `${baseSku}-${suffix}` : baseSku;
        variantUnmatchedCount++;
      }
    }
    for (let ei = 0; ei < ecigRows.length; ei++) {
      if (!usedE.has(ei)) {
        const suffix = slugifyVariant(ecigRows[ei]);
        ecigRows[ei].sku = suffix ? `${baseSku}-${suffix}` : baseSku;
        variantUnmatchedCount++;
      }
    }
  }

  // Process unmatched base products (only in one distributor)
  for (const p of profiles) {
    if (processedUrls.has(p.url)) continue;
    processedUrls.add(p.url);

    const baseSku = p.reference || generateSku(p.brand, p.normalizedName);
    const rows = productsByUrl.get(p.url) || [];
    for (const row of rows) {
      const suffix = slugifyVariant(row);
      row.sku = suffix ? `${baseSku}-${suffix}` : baseSku;
    }
  }

  // 10. Propagate brand, brandCandidates, commercialBrand, and breadcrumbPath to all product rows
  const brandByUrl = new Map<string, string>();
  const brandCandsByUrl = new Map<string, string[]>();
  const commercialBrandByUrl = new Map<string, string>();
  const breadcrumbByUrl = new Map<string, string[]>();
  for (const product of byUrl.values()) {
    if (product.brand) brandByUrl.set(product.url, product.brand);
    if (product.brandCandidates?.length) brandCandsByUrl.set(product.url, product.brandCandidates);
    if (product.commercialBrand) commercialBrandByUrl.set(product.url, product.commercialBrand);
    if (product.breadcrumbPath?.length) breadcrumbByUrl.set(product.url, product.breadcrumbPath);
  }
  for (const product of allProducts) {
    if (!product.brand) {
      const brand = brandByUrl.get(product.url);
      if (brand) product.brand = brand;
    }
    if (!product.brandCandidates?.length) {
      const cands = brandCandsByUrl.get(product.url);
      if (cands) product.brandCandidates = cands;
    }
    if (!product.commercialBrand) {
      const cb = commercialBrandByUrl.get(product.url);
      if (cb) product.commercialBrand = cb;
    }
    if (!product.breadcrumbPath?.length) {
      const bp = breadcrumbByUrl.get(product.url);
      if (bp) product.breadcrumbPath = bp;
    }
  }

  console.log(
    `[Matcher] Variant matches: ${variantMatchCount} cross-distributor, ${variantUnmatchedCount} unmatched`
  );
  if (sampleVariantMatches.length > 0) {
    console.log(`[Matcher] Sample variant matches:`);
    for (const s of sampleVariantMatches) console.log(s);
  }

  return {
    products: allProducts,
    matchedPairs: variantMatchCount,
    unmatchedCount: variantUnmatchedCount,
  };
}
