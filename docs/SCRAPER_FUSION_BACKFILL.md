# Scraper fusionado y backfill

Este documento resume el cambio que fusiona el scraper eficiente de Eciglogistica dentro del scraper integrado usado por `run_auto_update.mjs` y Docker.

## Objetivo

El flujo autonomo debe partir siempre de un scrapeo completo de Vaperalia + Eciglogistica. El scraper integrado vive en `scraper/` y es el unico que debe usar el orquestador. Las carpetas historicas `scraper ecig eficiente/` y `Scraper refinado/` se conservan como referencia, pero no son la entrada principal del pipeline.

## Cambios clave

- `scraper/src/connectors/eciglogistica.ts` ya no usa enriquecimiento inline con una ficha abierta por cada producto durante el crawl de categorias.
- Eciglogistica lista categorias con Playwright y enriquece fichas en fase 2 via HTTP+Cheerio, con concurrencia 1 y pausa de 600 ms.
- El conector Eciglogistica es estricto: si una pagina de categoria falla definitivamente o una ficha falla al enriquecer, el scraper debe fallar antes de devolver un parcial silencioso.
- `scraper/src/crawler.ts` soporta reintentos para `429`/`403`, `Retry-After`, diagnosticos de listing y backfill de URLs conocidas.
- `run_auto_update.mjs` y `run_auto_update.ps1` aceptan `--scraper-known-urls` / `-ScraperKnownUrls`.

## Backfill de URLs conocidas

El backfill recibe un JSON antiguo de scrapeo, normalmente:

```text
runs/<run-anterior>/scraper-output/output.json
```

El scraper extrae de ahi URLs con distribuidor, nombre y categoria. En cada conector:

1. Recorre primero todas las categorias actuales.
2. Deduplica por URL canonicalizada.
3. Añade como candidatos las URLs historicas del mismo distribuidor que no hayan aparecido en categorias.
4. Enriquecer esas URLs confirma si siguen vivas o si han desaparecido.

Esto evita perder productos vivos que una distribuidora no expone correctamente en categorias, sin convertir el backfill en fuente principal.

## Comando Docker recomendado

```powershell
$env:CODEX_HOST_HOME="C:\Users\diego\.codex"
docker compose run --rm autoupdate `
  --run-name docker-full-refresh `
  --scraper-known-urls /app/runs/<run-anterior>/scraper-output/output.json `
  --ean-csv /app/runs/local-inputs/Productos_cliente_Diego_Poole_Prieto.csv `
  --skip-playwright-install `
  --load-bdd `
  --load-bdd-dry-run
```

`--load-bdd-dry-run` exige tambien `--load-bdd`. Sin `--load-bdd`, no se ejecuta el loader.

El CSV de EAN13 se aporta con `--ean-csv` o con la variable de entorno `EAN_CSV`. En Docker Compose, la ruta debe existir dentro del contenedor. La forma mas sencilla es copiarlo a `runs/local-inputs/`, que ya esta montado como `/app/runs`.

## Validacion minima

Antes de considerar valida una fusion:

1. `npm run build` debe compilar el scraper.
2. Un humo combinado debe producir productos de Vaperalia y Eciglogistica.
3. `tools/validate-scrape-contract.js` debe devolver `ok: true`.
4. La run Docker completa debe pasar por:
   - scrapeo integrado,
   - validacion de contrato,
   - pipeline determinista,
   - rescate por descripcion,
   - CodexExec no determinista,
   - generacion master JSON,
   - loader BDD en dry-run si se solicita.

## Precauciones

- No usar `--limit` en una prueba `--connector all` si se quiere probar ambos conectores; el limite es global y Vaperalia puede consumirlo antes de que Ecig arranque.
- No desactivar CodexExec en una prueba definitiva, porque la capa no determinista forma parte del pipeline cerrado.
- No usar el backfill para preservar productos antiguos sin comprobar HTML vivo. El backfill solo añade URLs como candidatas a re-enriquecer.
