// ---------------------------------------------------------------------------
// Synthetic SKU builder for Eciglogistica products
// Constructs a reference body that can be compared against Vaperalia's
// productReference to match products across distributors.
// ---------------------------------------------------------------------------

const HARDWARE_CATEGORIES = new Set([
  "MODS Y KITS",
  "POD SYSTEMS",
  "COILS",
  "ACCESORIOS",
  "ATOMIZADORES",
  "DESECHABLE",
  "PREFILLED POD",
  "BATERIAS Y CARGADORES",
  "NGP",
  "DIY",
]);

/**
 * Determine the single-letter hardware prefix from Eciglogistica's gtag category.
 */
function getHardwarePrefix(title: string, category: string): string {
  if (category === "COILS") return "R";
  if (category === "DESECHABLE") return "D";
  if (category === "BATERIAS Y CARGADORES") return "B";
  if (category === "ATOMIZADORES") return "C";
  if (category === "DIY") return "W";

  if (category === "ACCESORIOS") {
    if (
      /\b(tank|pod\s+replacement|atomiz|rda|rta|rdta|cartridge|clearomiz|depósito)\b/i.test(
        title
      )
    ) {
      return "C";
    }
    return "A";
  }

  // MODS Y KITS: default to K (M- is rare and Vaperalia-specific)
  return "K";
}

/**
 * Extract the product body from an Eciglogistica title.
 * Removes brand, type words, specs, and converts to dot-separated uppercase.
 */
function extractHardwareBody(
  title: string,
  brand: string,
  category: string
): string {
  let body = title;

  // Remove brand name
  const brandPattern = brand.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  body = body.replace(new RegExp(brandPattern, "i"), "").trim();

  // Remove type words — but keep "Tank" for C- (atomizer) category
  const isKit = ["MODS Y KITS", "POD SYSTEMS", "NGP", "PREFILLED POD"].includes(
    category
  );
  body = body.replace(/\b(kit|pod kit|starter kit|mod)\b/gi, "");
  if (isKit) {
    body = body.replace(/\btank\b/gi, "");
  }
  body = body.replace(/\b(replacement|refill|empty|disposable|desechable)\b/gi, "");
  body = body.replace(/\b(coil|coils|mesh coil)\b/gi, "");
  body = body.replace(/\b(battery|bateria|batería)\b/gi, "");
  body = body.replace(/\b(pod)\b/gi, "");

  // Remove specs
  body = body.replace(/\b\d+\s*ml\b/gi, "");
  body = body.replace(/\b\d+\s*mah\b/gi, "");
  body = body.replace(/\b\d+\s*w\b/gi, "");
  body = body.replace(/\b\d+\s*ohm\b/gi, "");
  body = body.replace(/\b\d+\s*puffs?\b/gi, "");

  // Handle pack counts: "Pack 5" or "(Pack 5)" -> P{n} suffix
  let packSuffix = "";
  const packMatch = body.match(/\(?pack\s*(\d+)\)?/i);
  if (packMatch) {
    packSuffix = `.P${packMatch[1]}`;
    body = body.replace(/\(?pack\s*\d+\)?/gi, "");
  }

  // Remove tank/component after "+" in kit titles
  if (isKit) {
    body = body.replace(/\s*\+\s*.+$/, "");
  }

  // Clean and convert to dot-separated uppercase
  body = body
    .replace(/[-_]/g, " ")
    .replace(/[()[\]{}]/g, "")
    .replace(/[+&/\\;:!?'",.]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, ".");

  body += packSuffix;

  // Remove leading/trailing dots
  body = body.replace(/^\.+|\.+$/g, "");

  return body;
}

/**
 * Build a synthetic reference for an Eciglogistica product.
 * Returns the full synthetic reference (PREFIX-BODY) or null if not possible.
 */
export function buildSyntheticReference(
  title: string,
  brand: string,
  category: string
): string | null {
  if (!title || !brand || !category) return null;
  if (!HARDWARE_CATEGORIES.has(category)) return null;

  const prefix = getHardwarePrefix(title, category);
  const body = extractHardwareBody(title, brand, category);

  if (!body) return null;
  return `${prefix}-${body}`;
}

/**
 * Extract just the body portion from a Vaperalia reference.
 * E.g., "K-GTX.ONE.PRO" -> "GTX.ONE.PRO"
 *       "M-VINCI.SPARK.220" -> "VINCI.SPARK.220"
 */
export function extractReferenceBody(reference: string): string | null {
  const match = reference.match(/^[A-Z]{1,2}-(.+)$/);
  return match ? match[1] : null;
}

/**
 * Check if a Vaperalia reference is for a hardware product (single-letter prefix).
 */
export function isHardwareReference(reference: string): boolean {
  return /^[KMCRBADW]-/.test(reference);
}
