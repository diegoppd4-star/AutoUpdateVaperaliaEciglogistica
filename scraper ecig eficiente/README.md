# Scraper Ecig Eficiente

Version refinada del scraper de Eciglogistica. No sustituye al scraper anterior: convive con `scraper` y `Scraper refinado`.

## Objetivo

Scrapear Eciglogistica completa sin fundir el PC ni disparar bloqueos `HTTP 429`, manteniendo el mayor recall posible para el pipeline de matching.

La mejora clave es separar:

- Fase 1: listado de categorias con Playwright, secuencial.
- Fase 2: enriquecimiento de fichas por HTTP + Cheerio, con Ecig limitado a 1 worker y 600 ms entre fichas.
- Backfill opcional de URLs conocidas: si Ecig no lista hoy una ficha antigua pero la URL sigue viva, se recupera y se enriquece.

## Por que existe

El scraper antiguo funcionaba, pero Eciglogistica empezo a provocar bloqueos y tiempos excesivos cuando se enriquecian fichas con navegador. Al pasar la fase de detalle a HTTP secuencial:

- baja el coste de CPU/RAM;
- se evita tener cientos/miles de navegaciones Playwright de detalle;
- se mantiene el delay de 600 ms;
- se hace fail-fast ante `429/403` para no devolver parciales silenciosos.

Durante la validacion se detecto que Ecig puede tener URLs vivas que no aparecen en los listados de categorias actuales. Por eso se anadio `--known-urls`: el barrido sigue siendo por categorias para descubrir novedades, pero las URLs ya conocidas se usan como red de seguridad.

## Uso

Instalacion:

```bash
npm install
npx playwright install chromium
npm run build
```

Scrapeo completo Ecig sin backfill:

```bash
npm start -- --connector eciglogistica --output-dir output/ecig
```

Scrapeo completo Ecig con backfill de URLs conocidas:

```bash
npm start -- --connector eciglogistica --known-urls path/to/output-antiguo.json --output-dir output/ecig-backfill
```

El archivo de `--known-urls` puede ser:

- un array de objetos de producto con `url`, `distributor`, `name`, `categoryId`, etc.;
- o un array simple de strings URL.

Si el objeto tiene `distributor`, solo se usa cuando coincide con `Eciglogistica`. Si no tiene `distributor`, se usa si la URL empieza por la base del conector.

## Validacion realizada

Run validada:

`runs/refined-ecig-full-known-backfill-20260603-140029`

Fuente de comparacion antigua:

`runs/20260601-201610-full-e2e-background-20260601-201610/scraper-output/output.json`

Resultado:

- Scraper antiguo Ecig: 5533 filas, 3245 URLs base.
- Scraper refinado sin backfill: 5510 filas, 3233 URLs base.
- Scraper refinado con backfill: 5525 filas, 3245 URLs base.
- URLs base faltantes tras backfill: 0.
- URLs base anadidas frente al antiguo: 0.
- Errores de enriquecimiento: 0.
- Bloqueos `429/403`: 0.
- Duracion aproximada del run validado: 45.6 min.

Las 8 filas netas menos frente al antiguo no son perdida de URL base. Son diferencias de variantes dentro de fichas vivas: variantes que ya no aparecen en la ficha actual y algunas variantes nuevas que si aparecen ahora.

## Informes incluidos

Los informes de validacion estan en:

- `reports/comparison-ecig-known-backfill-vs-old.md`
- `reports/comparison-ecig-known-backfill-vs-old.json`

## Criterio de eficiencia

Esta version es mas eficiente que volver al enriquecimiento inline con navegador para Ecig porque:

- usa Playwright solo para listados;
- usa HTTP + Cheerio para fichas;
- fuerza 1 worker en Ecig aunque el CLI reciba otra concurrencia;
- mantiene delay controlado de 600 ms;
- falla de forma visible si hay `429/403`, en vez de entregar un scrape parcial;
- recupera URLs historicas vivas mediante backfill.

No garantiza descubrir una URL nueva que Ecig no publique en ninguna categoria. Ningun scraper por categorias puede hacerlo sin otra fuente: sitemap, busqueda interna, API, BDD historica o URLs conocidas.
