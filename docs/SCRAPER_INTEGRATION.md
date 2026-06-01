# Integracion del scraper

## Objetivo

El repositorio incluye `scraper/` para que el flujo completo no dependa de un JSON generado manualmente.

El runner principal `run_auto_update.mjs` ejecuta el scraper cuando no se proporciona `--input-json` ni `--scraper-command`.

`run_auto_update.ps1` mantiene compatibilidad Windows, pero Docker usa el runner Node.

## Comando interno

El runner compila y ejecuta:

```powershell
npm ci
npm exec -- playwright install chromium
npm run build
node dist/index.js --connector all --concurrency 5 --output-dir <runDir>/scraper-output
```

`--connector all` en este scraper significa exclusivamente:

- Vaperalia
- Eciglogistica

No incluye Nuevas Tendencias, KMLS ni Budsvape.

## Output conectado al pipeline

El scraper escribe:

```text
<runDir>/scraper-output/output.json
```

Luego `run_auto_update.ps1` copia ese archivo a:

```text
<runDir>/input/scrape.json
```

Ese `scrape.json` es la entrada unica para:

1. validacion de contrato;
2. pipeline determinista;
3. rescate por descripcion;
4. capa IA no determinista con CodexExec.

## Opciones utiles

- `--scraper-limit 20`: prueba con limite de productos.
- `--scraper-concurrency 10`: cambia concurrencia de enriquecimiento HTTP.
- `--scraper-categories "vaperalia:kits-y-mods,eciglogistica:mods-y-kits"`: limita categorias.
- `--scraper-debug`: guarda HTML de muestra en la carpeta de la ejecucion.
- `--skip-scraper-install`: no ejecuta `npm ci`.
- `--skip-playwright-install`: no verifica/instala Chromium de Playwright.

## Decision tecnica

El scraper se versiona como parte de este repositorio porque este software debe poder ejecutarse de punta a punta. Las salidas generadas (`scraper/output`, `scraper/debug`, `scraper/dist`, `scraper/node_modules` y `runs`) quedan fuera de Git.

## Docker

El Dockerfile instala Node.js, dependencias del scraper, Chromium de Playwright y Codex CLI. En contenedor no se usa la descarga portable de Node para Windows; npm viene instalado en la imagen.
