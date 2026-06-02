# AutoUpdateVaperaliaEciglogistica

Repositorio independiente para automatizar el refresco completo Eciglogistica/Vaperalia.

Orquestador local para ejecutar de principio a fin el pipeline Eciglogistica/Vaperalia sin depender de que Codex vaya llamando cada paso manualmente.

## Estado actual

El repositorio ya incluye el scraper en `scraper/`. Si ejecutas `run_auto_update.mjs` sin `--input-json` ni `--scraper-command`, el flujo por defecto es:

```text
scraper integrado -> validacion contrato -> Pipeline 1 -> Pipeline 2 -> Pipeline 3 CodexExec
```

## Que problema resuelve

Hasta ahora el proceso completo se hacia asi:

1. Codex lanzaba o recibia el scrapeo.
2. Codex lanzaba Pipeline 1.
3. Codex lanzaba Pipeline 2.
4. Codex lanzaba la capa IA no determinista con CodexExec.
5. Codex reconstruia `reviewed-rescues`.
6. Codex explicaba donde quedaban los outputs.

Esta carpeta convierte esa orquestacion en un archivo:

```text
run_auto_update.mjs
```

`run_auto_update.ps1` se mantiene como runner compatible con Windows, pero el runner principal para Docker es `run_auto_update.mjs`.

## Que contiene

- `run_auto_update.mjs`: runner principal end-to-end y entrada Docker.
- `run_auto_update.ps1`: runner compatible con Windows/PowerShell.
- `scraper/`: scraper TypeScript integrado para Eciglogistica/Vaperalia.
- `pipeline_sagrado/PIPELINE SAGRADO`: copia autocontenida del Pipeline Sagrado necesario para ejecutar las tres capas.
- `tools/validate-scrape-contract.js`: validacion previa del JSON de scrapeo.
- `docs/SCRAPPER_ARCHITECTURE.md`: contrato tecnico del scraper.
- `docs/AGENT_HANDOFF_PIPELINE_COMPLETO.md`: contexto completo del pipeline para otro agente/desarrollador.
- `config.example.json`: ejemplos de uso.
- `runs/`: carpeta donde se crean ejecuciones nuevas.

## Uso autonomo completo

Ejecuta scrapeo completo de Eciglogistica + Vaperalia y luego todo el pipeline:

```powershell
cd "C:\Users\diego\Documents\New project\AutoUpdateVaperaliaEciglogistica"

powershell -NoProfile -ExecutionPolicy Bypass -File .\run_auto_update.ps1 `
  -RunName "daily-full-refresh"
```

Equivalente multiplataforma:

```powershell
node .\run_auto_update.mjs --run-name daily-full-refresh
```

La primera vez instalara dependencias del scraper con `npm ci` y verificara Chromium de Playwright.

Para evitar reinstalaciones/verificaciones en una maquina ya preparada:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\run_auto_update.ps1 `
  -RunName "daily-full-refresh" `
  -SkipScraperInstall `
  -SkipPlaywrightInstall
```

## Uso con Docker

El objetivo de despliegue recomendado es Docker. La imagen incluye:

- Node.js 22 + npm.
- dependencias del scraper.
- Chromium de Playwright.
- Codex CLI (`@openai/codex`) para la capa IA no determinista.

El contenedor no depende de PowerShell: entra por `node /app/run_auto_update.mjs` y ejecuta los scripts JS del Pipeline Sagrado directamente.

Requisitos en Windows:

```cmd
winget install --id Docker.DockerDesktop --source winget --accept-package-agreements --accept-source-agreements
```

Despues de instalar Docker Desktop puede hacer falta reiniciar Windows o abrir Docker Desktop una vez para que el daemon quede activo.

Build:

```powershell
docker build -t autoupdate-vaperalia-eciglogistica .
```

El Dockerfile no clona el repo desde GitHub. El codigo entra como contexto de build (`COPY . .`), y las dependencias externas se instalan en build time desde fuentes versionadas o bloqueadas:

- Node viene de la imagen base `node:22-bookworm`.
- El scraper usa `package-lock.json`.
- Codex CLI queda fijado por `CODEX_CLI_VERSION`.
- Playwright instala Chromium dentro de la imagen.

Ejecucion completa:

```powershell
docker run --rm `
  -e OPENAI_API_KEY=$env:OPENAI_API_KEY `
  -v "${PWD}\runs:/app/runs" `
  autoupdate-vaperalia-eciglogistica `
  --run-name "docker-full-refresh" `
  --skip-scraper-install `
  --skip-playwright-install
```

Con `docker compose`:

```powershell
docker compose up --build
```

En Windows tambien puedes lanzar:

```cmd
run_docker_full.cmd
```

Para probar sin capa IA:

```powershell
docker run --rm `
  -v "${PWD}\runs:/app/runs" `
  autoupdate-vaperalia-eciglogistica `
  --run-name "docker-test" `
  --skip-scraper-install `
  --skip-playwright-install `
  --skip-codex-exec
```

La capa CodexExec necesita credenciales disponibles dentro del contenedor. La opcion mas directa es `OPENAI_API_KEY`.

## Modos alternativos

El runner tambien soporta:

1. Recibir un JSON ya scrapeado con `-InputJson`.
2. Ejecutar otro scraper externo mediante `-ScraperCommand`.

## Uso con JSON ya scrapeado

```powershell
cd "C:\Users\diego\Documents\New project\match-viewer-share\AutoUpdateVaperaliaEciglogistica"

powershell -NoProfile -ExecutionPolicy Bypass -File .\run_auto_update.ps1 `
  -InputJson "C:\ruta\output.json" `
  -RunName "refresh-manual"
```

Esto ejecuta:

1. Validacion del contrato de scrapeo.
2. Pipeline 1 determinista.
3. Pipeline 2 rescate por descripcion.
4. Pipeline 3 IA no determinista con CodexExec.
5. Resumen de outputs.

## Uso con scraper externo

El comando externo debe escribir el JSON final en la ruta:

```powershell
$env:AUTOUPDATE_SCRAPE_OUTPUT_JSON
```

Ejemplo:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\run_auto_update.ps1 `
  -ScraperCommand "cd C:\ruta\scraper; npm start -- --connector all --full-refresh --out `$env:AUTOUPDATE_SCRAPE_OUTPUT_JSON" `
  -RunName "daily-full-refresh"
```

El runner tambien expone:

```powershell
$env:AUTOUPDATE_RUN_DIR
```

por si el scraper quiere dejar HTML, logs o artefactos auxiliares dentro de la ejecucion.

## Dry run

Valida el JSON de entrada y genera estructura de ejecucion, pero no ejecuta pipelines.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\run_auto_update.ps1 `
  -InputJson "C:\ruta\output.json" `
  -DryRun
```

## Saltar CodexExec

Para ejecutar solo determinismo + rescate por descripcion:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\run_auto_update.ps1 `
  -InputJson "C:\ruta\output.json" `
  -SkipCodexExec
```

## Outputs por ejecucion

Cada ejecucion crea una carpeta:

```text
runs/<timestamp-runname>/
```

Dentro:

- `input/scrape.json`: copia del JSON usado.
- `validation-report.json`: validacion del contrato.
- `pipeline-work/outputs/general.matches.valid.json`
- `pipeline-work/outputs/description-rescue-candidates.matches.valid.json`
- `pipeline-work/outputs/reviews/description-rescue-decisions.json`
- `pipeline-work/outputs/reviewed-rescues.matches.valid.json`
- `pipeline-work/outputs/audits/reviewed-rescues.audit.md`
- `run-summary.json`
- `logs/run.log`

## Contrato de la capa IA

La capa automatica CodexExec no debe emitir `needs_human`.

Cada candidato se cierra como:

- `accepted`
- `rejected`

Si no hay certeza suficiente para aceptar, se rechaza con motivo.

## Futuro BDD

Este runner cierra la generacion de resultados del pipeline.

La carga incremental a BDD debe conectarse despues leyendo:

- `general.matches.valid.json`
- `reviewed-rescues.matches.valid.json`
- familias `solo Eciglogistica`, `solo Vaperalia` y `matched_both` cuando se genere la exportacion maestra correspondiente.
