claude# VapeCatalogScraper

CLI en TypeScript que crawlea catálogos de distribuidoras de vape (Vaperalia, Eciglogistica, NuevasTendencias, KMLS y Budsvape), extrae productos con sus variantes, y exporta a CSV/JSON.

Proyecto hermano de [VapeItReorder](../VapeItReorder/) — genera las URLs de producto que VapeItReorder necesita en su tabla `PRODUCTO_DISTRIBUIDORA`.

## Tech Stack

- TypeScript, Node.js (ES2022, NodeNext modules)
- Playwright (Chromium, headless) — navegación de categorías + inline enrichment
- Cheerio — extracción de variantes (Cheerio sobre HTML)
- Commander (CLI)
- csv-stringify (exportación CSV)

## Estructura del proyecto

```
VapeCatalogScraper/
├── src/
│   ├── index.ts                  # Entry point y CLI
│   ├── types.ts                  # Tipos: Product, CrawlResult
│   ├── crawler.ts                # Motor de crawl: Phase 1 (Playwright, inline opcional) + Phase 2 (HTTP+Cheerio)
│   ├── url-utils.ts              # canonicalizeUrl() — normaliza URLs
│   ├── exporter.ts               # Exporta a output/output.csv y output/output.json
│   └── connectors/
│       ├── connector.ts          # Interface Connector
│       ├── vaperalia.ts          # Conector Vaperalia (PrestaShop)
│       ├── eciglogistica.ts      # Conector Eciglogistica (inline enrichment)
│       ├── nuevastendencias.ts   # Conector NuevasTendencias (WooCommerce)
│       ├── kmls.ts               # Conector KMLS (PrestaShop B2B)
│       └── budsvape.ts           # Conector Budsvape (PrestaShop B2B)
├── output/                       # CSV y JSON generados
├── debug/                        # HTML de muestra (con --debug)
├── dist/                         # JS compilado
├── package.json
├── tsconfig.json
└── .gitignore
```

## Conectores

| Conector | Base URL | Plataforma | Paginación | Enriquecimiento |
|---|---|---|---|---|
| Vaperalia | `https://vaperalia.es` | PrestaShop | `?page=N` o `a.next` | Phase 2 (HTTP+Cheerio) |
| Eciglogistica | `https://nueva.eciglogistica.com` | Custom | `/pagina/N` | Inline (Phase 1, 2 tabs, anti-Cloudflare) |
| NuevasTendencias | `https://nuevas-tendencias.com` | WordPress/WooCommerce | `<link rel="next">` | Phase 2 (HTTP+Cheerio) |
| KMLS | `https://kmls.fr` | PrestaShop (B2B) | `<link rel="next">` | Phase 2 (HTTP+Cheerio) |
| Budsvape | `https://budsvape-distribution.com` | PrestaShop (B2B) | `<link rel="next">` | Phase 2 (HTTP+Cheerio) |

## Cómo funciona

### Phase 1 — Listados de categorías (Playwright)

Navega las páginas de categoría con un tab secuencial, extrae nombre+URL de cada producto, y sigue paginación automáticamente. Incluye deduplicación por URL canonicalizada, detección de loops de paginación, y máximo 100 páginas por categoría.

### Enriquecimiento de variantes

Cada conector implementa `scrapeProductVariantsFromHtml()` (Cheerio) para extraer variantes (sabor, nicotina, color, tamaño…) y genera el **producto cartesiano** de todas las combinaciones.

Hay dos modos de enriquecimiento, configurables por conector:

**Modo inline** (`enrichInline = true`, usado por Eciglogistica):
- Abre una segunda tab Playwright durante Phase 1
- Por cada producto descubierto, navega la segunda tab a su URL y extrae variantes con Cheerio
- Usa la misma sesión del browser (mismas cookies), evitando bloqueos de Cloudflare u otros WAFs
- Phase 2 se salta completamente

**Modo HTTP** (usado por Vaperalia):
- Phase 2 separada: fetch HTTP nativo con workers concurrentes
- Más rápido para sitios sin protección anti-bot

#### Extracción de variantes por conector

**Vaperalia (PrestaShop)** — busca dentro de `fieldset.attribute_fieldset`:
1. Radio buttons: `.attribute_list ul li span` (ej. nicotina, tamaño)
2. Select dropdowns: `select option` dentro del fieldset
3. Color swatches: `a.color_pick[title]` (ej. colores de dispositivos)

Si no hay fieldsets, busca selects sueltos en `.product-actions`, `#attributes` o `.product_attributes`.

**Eciglogistica** — busca `select.select-attribute-product`:
1. Label: `p.color-title` en el `div.row` padre (vía `.closest()`)
2. Valores: atributo `data-value` de cada `<option>` (fallback a texto), filtrando placeholders

Fallback: grupos genéricos `.product-option`, `.form-group:has(select)`, `.product-attribute`.

#### Expansión de variantes

Las variantes crudas (`Record<string, string[]>`) se expanden como producto cartesiano. Ejemplo: `{ "Sabor": ["Menta", "Fresa"], "Nicotina": ["3mg", "6mg"] }` → 4 filas, cada una con sufijo en el nombre (`"Producto - Menta / 3mg"`).

## Instalación

```bash
git clone <repo-url>
cd VapeCatalogScraper
npm install
npx playwright install chromium
```

## Uso

```bash
# Compilar
npm run build

# Crawl completo (todas las distribuidoras)
npm start

# Solo una distribuidora
npm start -- --connector vaperalia
npm start -- --connector eciglogistica

# Limitar cantidad de productos (útil para testing)
npm start -- --limit 20

# Ajustar concurrencia de Phase 2 HTTP (default: 5)
npm start -- --concurrency 10

# Guardar HTML de muestra en debug/
npm start -- --debug

# Combinado
npm start -- --connector vaperalia --limit 50 --debug
```

## Output

Los resultados se generan en `output/`:

- **output.json** — Array de objetos `{ distributor, name, url, variants }`
- **output.csv** — Columnas `distributor,name,url,variants`

Cada producto se expande en N filas (una por combinación de variantes). El campo `name` incluye el sufijo de variante (ej. `"Producto X - 10mg / Menta"`). Si un producto no tiene variantes, se genera una sola fila con `variants: {}`.
