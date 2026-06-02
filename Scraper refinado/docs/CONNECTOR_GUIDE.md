# Connector Guide — Official

Cómo construir un connector nuevo para VapeCatalogScraper. Lee esto antes de añadir un distribuidor.

---

## 1. Overview

Pipeline: **Phase 1 (list) → Phase 2 (enrich) → Phase 3 (match)**.

- **Phase 1** — `src/crawler.ts:42-194`. Recorre categorías con Playwright, pagina, recoge `{ name, url }` por producto.
- **Phase 2** — `src/crawler.ts:215-340`. Workers concurrentes hacen HTTP+Cheerio sobre cada URL, llaman `enrichProductFromHtml($, url)` → `EnrichmentResult`. Luego `expandVariants()` genera una fila por combinación.
- **Phase 3** — `src/matcher.ts`. Solo si hay >1 distribuidor en el run. Empareja base products (TF-IDF coseno) y variantes (Jaccard) entre distribuidores.

Tu connector vive en `src/connectors/<slug>.ts` y se registra en `src/index.ts`.

---

## 2. Interface contract

Fuente: `src/connectors/connector.ts:17-33`.

```typescript
interface Connector {
  name: string;                    // Display name, e.g. "Vaperalia"
  baseUrl: string;                 // Sin trailing slash
  enrichInline?: boolean;          // true → enrichment durante Phase 1 (Playwright)
  delayMs?: number;                // Override del delay inter-producto

  getCategorySeeds(categoryIds?: string[]): Promise<CategorySeed[]>;

  listProductsFromCategory(
    page: Page,                     // página YA navegada por el crawler — NO llames goto()
    categoryUrl: string
  ): Promise<CategoryResult>;       // { products: [{name, url}], nextPageUrl: string|null }

  enrichProductFromHtml(
    $: CheerioAPI,                  // HTML ya parseado
    productUrl: string
  ): EnrichmentResult | Promise<EnrichmentResult>;
  //   sync si enrichInline=true, async si no
}
```

Tipos relacionados (`src/types.ts:28-43`):

```typescript
interface EnrichmentResult {
  variants: Record<string, string[]>;          // dim → valores ("color" → ["Red","Blue"])
  variantUrlSegments?: Record<string, Record<string, string>>;
  variantReferenceValues?: Record<string, Record<string, string>>;
  fullName?: string;
  brand?: string;
  brandCandidates?: string[];
  commercialBrand?: string;
  reference?: string;
  category?: string;
  breadcrumbPath?: string[];
  priceTaxExcluded?: number;
  description?: string;
  metaDescription?: string;
}
```

`CategorySeed.urls?` permite múltiples URLs de entrada para una misma categoría lógica (ej: Vaperalia "Pod System" tiene 5 sub-URLs colapsadas).

---

## 3. Decisión Phase 2 vs inline (`enrichInline`)

Árbol de decisión:

```
¿El sitio responde a fetch HTTP plano con el HTML completo?
├── Sí  → enrichInline NO se setea. enrichProductFromHtml es async.
│         Phase 2 hace fetch+Cheerio en paralelo. Más rápido.
│         Ejemplos: Vaperalia (PrestaShop), NuevasTendencias (WooCommerce).
│
└── No → enrichInline = true. enrichProductFromHtml es SYNC.
          Phase 1 abre segunda tab Playwright por producto (misma sesión, cookies).
          Necesario cuando hay Cloudflare, JS-heavy rendering, o anti-bot.
          También fija delayMs (ej: 600ms) para no rate-limit.
          Ejemplo: Eciglogistica (`src/connectors/eciglogistica.ts:27`).
```

Branch en crawler: `src/crawler.ts:127-171` (inline) vs Phase 2 worker pool.

---

## 4. Platform recipes

### 4.1 PrestaShop — referencia: `src/connectors/vaperalia.ts`

| Campo | Selector / técnica | Línea |
|---|---|---|
| Listing cards | `.product-container` con `h5 a` o `.product-name a` interno | `vaperalia.ts:103-129` |
| Listing fallback | `ul.product_list li a[href*='.html']` | `vaperalia.ts:133` |
| Pagination | `a.next, a[rel="next"]` o parsear "X - Y de Z" + `?page=N` | `vaperalia.ts:327-363` |
| Full name | `<h1>` (listing names vienen truncados — siempre coger del detail) | `vaperalia.ts:162` |
| Reference | inline JS: `productReference = 'ABC123'` | `vaperalia.ts:167-171` |
| Brand | `H1.split(" - ").pop()` | `vaperalia.ts:174-180` |
| Variants | `fieldset.attribute_fieldset` → radio spans, select options, color swatches | `vaperalia.ts:201-251` |
| Variant URL segments | inline JS `attributesCombinations = [...]` | `vaperalia.ts:366-401` |
| Variant ref mapping | AJAX `/index.php?controller=product&ajax=1&action=getCombinations` | `vaperalia.ts:422-483` |
| Price | inline JS: `productPriceTaxExcluded = X.XX` | `vaperalia.ts:291-297` |
| Breadcrumb | `.miga-pan a:not(.home), .breadcrumb li a` | `vaperalia.ts:185` |
| Description | `[itemprop='description'], #description` | `vaperalia.ts:300-305` |

### 4.2 WooCommerce/Woodmart — referencia: `src/connectors/nuevastendencias.ts`

| Campo | Selector / técnica | Línea |
|---|---|---|
| Listing cards | `.product-grid-item a.product-image-link` | `nuevastendencias.ts:63` |
| Listing name | `img[alt]` o URL slug | `nuevastendencias.ts:72-75` |
| Pagination | `<link rel="next" href="...">` en `<head>` | `nuevastendencias.ts:85-87` |
| Full name | `h1.product_title` → `h1` → `og:title` → `<title>` | `nuevastendencias.ts:94-99` |
| Brand / SKU / price | JSON-LD `@type=Product` dentro de `@graph` (Yoast SEO) | `nuevastendencias.ts:106-156` |
| Brand fallback 1 | `.woocommerce-product-attributes-item` con label "marca" | `nuevastendencias.ts:159-172` |
| Brand fallback 2 | regex `" de [Brand]"` al final del name | `nuevastendencias.ts:175-179` |
| Brand fallback 3 | token all-caps al final (excluye CBD, HHC, etc.) | `nuevastendencias.ts:183-189` |
| Brand fallback 4 | tercer nivel del breadcrumb | `nuevastendencias.ts:199-201` |
| Price | `offers[].priceSpecification[].price` o `lowPrice` (AggregateOffer) | `nuevastendencias.ts:126-151` |
| Breadcrumb | `nav.woocommerce-breadcrumb a.breadcrumb-link` | `nuevastendencias.ts:193` |
| Description | `.woocommerce-product-details__short-description, #tab-description` | `nuevastendencias.ts:209-215` |

Gotcha: productos WooCommerce de este catálogo no traen variantes → `variants: {}`.

### 4.3 Custom — referencia: `src/connectors/eciglogistica.ts`

Heurística cuando no es plataforma conocida. Orden de búsqueda:

1. JSON-LD `application/ld+json` `@type=Product` (igual que WooCommerce).
2. gtag analytics inline JS — `"brand": "..."`, `"category": "..."`, `"price": "..."`. Línea: `eciglogistica.ts:80-86, 191-196`.
3. `<h1>` para nombre.
4. Visible labels: `Ref.:`, `Marca:`, etc. con regex. Línea: `eciglogistica.ts:117-122` (reference), `90-96` (brand).
5. og:title / meta description como último recurso.

Listing en sitios custom — busca el `<div>` repetido que contenga `<a>` + nombre. Pagination — busca `<a>` con texto "→" o número de página. Verifica que el href apunta a página mayor que la actual (`eciglogistica.ts:209-233`).

---

## 5. Field extraction patterns

### Name
- **Listing names suelen estar truncados** (Vaperalia es el caso paradigmático). Captura `fullName` desde `<h1>` en `enrichProductFromHtml`. Crítico porque `expandVariants()` añade sufijos al `fullName` para cada combinación.

### Brand
Cascada típica:
1. JSON-LD `brand.name` (Schema.org).
2. Analytics inline (gtag, dataLayer).
3. Atributos visibles (`<p class="grey-texts">Marca:`, tabla `.woocommerce-product-attributes-item`).
4. Heurística sobre el name (sufijo " - Brand", token all-caps final).
5. Breadcrumb (último o penúltimo nivel).

`brandCandidates[]` mantiene todos los candidatos en orden de confianza para que el matcher pueda fallback-ear.

### Reference (SKU)
- Real cuando el sitio lo expone (PrestaShop `productReference`, JSON-LD `sku`, texto "Ref.: ...").
- **Sintética** si no hay y el producto es hardware. Usa `buildSyntheticReference(name, brand, category)` de `src/sku-builder.ts:115-128`. Genera `K-VUSI.TANK.PRO` (kits), `R-...` (coils), etc. Solo aplica si `category` está en `HARDWARE_CATEGORIES` (`sku-builder.ts:7-18`). El connector NO lo construye — lo añade el crawler luego.

### Price
Schema.org JSON-LD es lo más fiable cuando existe. Para AggregateOffer (productos con variantes que tienen rango de precio), usa `lowPrice`. Para Offer simple, `priceSpecification[0].price` o `price` directo.

### Variants
Patrones a buscar (en orden):
1. **Select** con `<option>` etiquetadas. Filtrar placeholders: regex `^(seleccione|elige|--|\.\.\.|escoge|choose|select)`.
2. **Radio buttons** dentro de `fieldset` o `.attribute_list`.
3. **Color swatches** — `a.color_pick[title]`, `input[type='radio'][title]`.
4. **Atributos data-** — `option[data-value]`, `option[data-id]`.

El label de cada dimensión sale del `<label for=...>`, hermano previo, o atributo `name="group[X]"`. Siempre strip ":" final.

Si el sitio devuelve combinaciones via AJAX (ej: Vaperalia `getCombinations`), construye `variantReferenceValues` mapeando cada valor de variante a su sufijo de SKU. Esto permite que el matcher reconozca el mismo color a través de distribuidores.

---

## 6. Variant expansion

`expandVariants()` en `src/crawler.ts:353-419`. Cartesian product de todas las dimensiones:

```
variants = { color: ["Red","Blue"], nicotine: ["3mg","6mg"] }
→ 4 filas: Red/3mg, Red/6mg, Blue/3mg, Blue/6mg
```

Cada fila clona el Product base y:
- Sufija el `name` con `"DIM1 value / DIM2 value / ..."`.
- Setea `variants: { color: "Red", nicotine: "3mg" }`.
- Si `variantUrlSegments` existe, intenta construir URL específica de la variante (`crawler.ts:405-419`).
- Si `variantReferenceValues` existe, llena `derived.matchedReferenceColor` (`crawler.ts:393-403`).

Si `variants` es vacío, sale una sola fila con `variants: {}`.

---

## 7. Registration

`src/index.ts:42-51`. Patrón:

```typescript
// 1. Import al inicio del archivo
import { MyNewConnector } from "./connectors/mynewconnector.js";

// 2. If-block en el array
if (connectorName === "all" || connectorName === "mynewslug") {
  connectors.push(new MyNewConnector());
}

// 3. Actualizar descripción del flag --connector (línea 26-29)
"Run only one connector: vaperalia | eciglogistica | nuevastendencias | mynewslug | all"
```

Imports SIEMPRE con extensión `.js` (ES modules + NodeNext). Sin excepción.

---

## 8. Testing workflow

```bash
npm run build                                              # tsc, debe compilar limpio
npm start -- --connector mynewslug --limit 10 --debug      # smoke test
                                                            # --debug guarda HTML en debug/
ls output/mynewslug.json                                   # revisar resultados
cat output/categories/mynewslug__<categoryId>.json         # por categoría
npm run check                                              # validación de 30 muestras random
```

Qué inspeccionar en `output/mynewslug.json`:
- ¿Cada producto tiene `name`, `url`, `priceTaxExcluded`, `brand`?
- ¿`reference` está poblado cuando existe en el site?
- ¿Las variantes se expanden correctamente (filas separadas con sufijos en `name`)?
- ¿`breadcrumbPath` tiene sentido?

Si algún campo viene vacío en >20% de productos, revisar selectores con `--debug` + inspección del HTML guardado en `debug/`.

---

## Apéndice A — Identity contract (brand/commercialBrand/productLine)

Regla crítica: **preserva todas las señales de identidad visibles separadas**. No colapses en un solo `brand` prematuramente.

| Campo | Qué guardar | Ejemplo |
|---|---|---|
| `brand` | Marca primaria / manufacturer | `Aromes et liquides` |
| `commercialBrand` | Sub-marca / marca comercial cuando difiere | `A&L` |
| `brandCandidates[]` | Todos los aliases visibles, ordenados por confianza | `["Aromes et liquides", "A&L"]` |
| `productLine` | Colección/línea, NUNCA brand | `Ultimate Sweet Edition` |
| `derived.matchedReferenceColor` | Valor derivado por el matcher, NO scrapeado | `GRAPHITE BLACK` (mapeado desde "Black") |

### No promociones product lines a brand
Términos como `Ultimate Sweet Edition`, `Hidden Potion`, `Dessert Bar`, `King Bar`, `Iconic` son líneas, no brands. Guárdalos en `productLine` o en `brandCandidates` (no como `brand` único).

### Scraped vs derived
Solo escribe en campos crudos (`variants.Color`, `brand`, etc.) lo que **literalmente está en el HTML**. Si el matcher luego mapea `Black` (Vaperalia simplificado) → `GRAPHITE BLACK` (Eciglogistica comercial), eso va en `derived.matchedReferenceColor` — NO en `variants.Color` de Vaperalia.

Ejemplo: Xros 4 Nano en Vaperalia expone `Black`/`Silver` en DOM. Eciglogistica expone `GRAPHITE BLACK`/`TITANIUM SILVER`. El connector de Vaperalia NO debe escribir `GRAPHITE BLACK` aunque lo haya inferido — eso es derivado.

### Multi-brand HTML típico (Eciglogistica)
```html
<p class="grey-texts">Marca:
  <a href="/aromes-et-liquides">Aromes et liquides</a>,
  <a href="/a-amp-l">A&L</a>
</p>
```
Lee TODOS los `<a>` dentro del `<p>` con "Marca:". Mantén orden visible. `brand` = primero, `commercialBrand` = segundo (si difiere), todos van en `brandCandidates`.

---

## Apéndice B — Phase 3 (matcher) — para qué sirve tu output

Tu connector alimenta el matcher. Entender cómo matchea ayuda a producir output útil.

`src/matcher.ts:matchProducts()` — 10 pasos:

1. **Deduplicate by URL → Profiles** — una entrada por URL única (no por variante).
2. **Name normalization** (`normalizeNameForMatching`) — quita unidades (`ml`, `mah`, `w`, `mg`, `ohm`, `puffs`), todos los `brandCandidates[]`, palabras genéricas (`kit`, `pod`, `mod`, etc.), ruido en español (`para`, `con`, `de`).
3. **Brand normalization** — quita sufijos liquid-type (`e-liquids`, `nic salts`, `salts`, `vapes`, `labs`, `liquids`, `flavours`).
4. **TF-IDF** sobre nombres normalizados de TODOS los profiles. **Tokens de un solo carácter se preservan si son dígitos** — `"5"` en "Xros 5 Mini" es load-bearing.
5. **Body-match pre-pass** (hardware only) — compara `productReference` de Vaperalia contra `syntheticReference` de Ecig. Si los bodies coinciden (`XROS.5.MINI`) y hay intersección de brand candidates → match score 1.0.
6. **Brand-based blocking** — solo compara productos cuyos `brandCandidates` se intersecten. Sin overlap → SKIP (no compara). Esta es la fuente principal de "skipped (no brand match)".
7. **TF-IDF cosine similarity** dentro del bucket de brand. Threshold `MATCH_THRESHOLD = 0.45`.
8. **Greedy 1:1 assignment** — score descendente, cada profile usado una vez.
9. **Variant matching** dentro de cada par base matched — Jaccard / containment sobre `variants` normalizadas. Threshold `VARIANT_MATCH_THRESHOLD = 0.6`. SKU final: `${baseSku}-${slug(variant)}`.
10. **Brand propagation** — propaga `brand`/`brandCandidates` a todas las filas de variantes (porque `expandVariants` solo las pone en la primera).

### SKU format
```
K-XROS.5.MINI-BLACK
│ └──────────┘└────┘
│   body      variant slug
└── prefix (K=kits, R=coils, D=disposables, ...)
```
Base = Vaperalia `productReference` si existe; si no, `generateSku(brand, normalizedName)` (hash). Por eso `reference` de Vaperalia/Ecig es **load-bearing** para el SKU.

### Qué debe producir tu connector para que el matcher funcione

| Necesidad del matcher | Qué pones en tu output |
|---|---|
| Brand blocking efectivo | `brandCandidates[]` con TODOS los aliases visibles, no solo el principal |
| Body match (hardware) | `reference` extraído cuando exista; `category` correcto para que `buildSyntheticReference` aplique |
| Name TF-IDF útil | `fullName` completo (no truncado), con números de modelo intactos |
| Variant matching | `variants` con labels consistentes (`Color`, `Ohm`, `Capacidad`) — no inventes nombres |

---

## Apéndice C — Tuning knobs

| Constante | Archivo | Valor por defecto |
|---|---|---|
| `MATCH_THRESHOLD` | `src/matcher.ts` | `0.45` |
| `VARIANT_MATCH_THRESHOLD` | `src/matcher.ts` | `0.6` |
| Brand substring min length | `src/matcher.ts` `findBrandCandidates()` | `> 2` chars |
| `DELAY_MS` (Phase 1 inter-product) | `src/crawler.ts` | `1000ms` |
| `PHASE2_DELAY_MS` (Phase 2 worker delay) | `src/crawler.ts` | `300ms` |
| `MAX_RETRIES` | `src/crawler.ts` | `3` |
| `MAX_PAGES_PER_CATEGORY` | `src/crawler.ts` | `100` |
| `SAVE_INTERVAL` | `src/crawler.ts` | `200` productos |
| Concurrencia Phase 2 | CLI `--concurrency` | `5` |

Connector puede sobreescribir `DELAY_MS` con `delayMs` propio (Eciglogistica usa `600`).

---

## Apéndice D — QA checklist post-cambios

Después de modificar un connector, antes de un crawl completo:

1. `npm run check` o crawl con `--limit 30` por distribuidor, persiste debug JSON con: `url`, `fullName`, `brand`, `brandCandidates`, `commercialBrand`, `productLine`, `breadcrumbPath`, `reference`, `variants`, `priceTaxExcluded`, primeros 300 chars de `description`.
2. Para productos con multi-brand visible (ej: Ecig `Marca: A, B`): verifica que **todos** los anchors aparecen en `brandCandidates`.
3. Para sub-brands en Vaperalia (`A&L Hidden Potion`): verifica que el parent brand (`A&L`) también está en `brandCandidates` si el breadcrumb lo expone.
4. **NINGÚN valor scrapeado** debe contener valores derivados/matcheados ausentes del HTML real.
5. Líquidos: descripciones preservan `Formato`, `Capacidad de bote`, `Sabor`, `Nicotina`, `VG/PG`.
6. Hardware: descripciones preservan `Ohm`, `Capacidad`, `mAh`, `W`, `Pack`, `Compatible con`.
7. **No confíes en `output/output.json` antiguo** — re-crawl ambos distribuidores tras añadir campos nuevos.

---

## Apéndice E — Common failure modes

| Síntoma | Causa probable | Dónde mirar |
|---|---|---|
| `skipped (no brand match): N` alto | Brands de un distribuidor no aparecen en `ecigByBrand` del otro | Revisa `brandCandidates` en ambos lados; ver normalización |
| Match count bajo | Threshold muy alto, o blocking demasiado agresivo | Bajar `MATCH_THRESHOLD`, inspeccionar `normalizedName` |
| Base SKU incorrecto | `reference` no extraído, cae a hash | Revisar `productReference` JS var en página |
| Variant rows sin `brand` | Propagación matcher.ts no corre | Solo corre tras matching; runs single-connector la saltan |
| Sub-brand pierde parent brand al matchear | Antiguos `preserved products` sin `brandCandidates` | Re-crawl para regenerar campo |
| `expandVariants` da 1 fila por producto | No se extrajeron variantes | Revisar selectores select/radio/swatch del connector |
| Navigation loop warning | `nextPageUrl` no cambia entre páginas | Lógica `findNextPage()` del connector |
| Ecig product solo tiene parent brand (falta sub) | Connector solo guardó analytics `brand`, ignoró `<a>` de `Marca:` | Revisar `brandCandidates`, `commercialBrand`, `breadcrumbPath` |
| Product line aparece como brand | Términos de línea promovidos a `brand` | Mover a `productLine`, mantener manufacturer en `brandCandidates` |
| Vaperalia muestra `Reference Color` no presente en HTML | Valor derivado escrito como variant cruda | Mover a `derived.matchedReferenceColor` |

---

## Apéndice F — Anti-bot (solo si aplica)

Cuándo se necesita:
- El HTML contiene markers de Cloudflare: `cf-ray`, `Checking your browser`, `challenge-platform`, `cf_chl_`.
- Sitio responde 403/503 a fetch HTTP plano pero funciona en navegador.
- Comportamiento errático: a veces 200, a veces challenge.

Mitigaciones (en orden de menor a mayor coste):

1. **User-Agent realista** — Chrome 120 sobre macOS funciona. Ya configurado en crawler.
2. **`enrichInline = true`** — fuerza Playwright durante enrichment. Reusa sesión y cookies de Phase 1.
3. **`delayMs`** — sube delay inter-producto. 600ms suele ir bien; 1000ms+ si rate-limit persiste.
4. **Concurrencia baja** — `--concurrency 1` desde CLI si Phase 2 (no-inline) sigue siendo viable.

Eciglogistica usa estrategia 2+3. No hemos necesitado ir más allá.
