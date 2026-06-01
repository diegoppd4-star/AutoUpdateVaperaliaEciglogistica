# AutoUpdateVaperaliaEciglogistica

Repositorio independiente para automatizar el refresco completo Eciglogistica/Vaperalia.

Orquestador local para ejecutar de principio a fin el pipeline Eciglogistica/Vaperalia sin depender de que Codex vaya llamando cada paso manualmente.

## Que problema resuelve

Hasta ahora el proceso completo se hacia asi:

1. Codex recibia o localizaba un JSON scrapeado.
2. Codex lanzaba Pipeline 1.
3. Codex lanzaba Pipeline 2.
4. Codex lanzaba la capa IA no determinista con CodexExec.
5. Codex reconstruia `reviewed-rescues`.
6. Codex explicaba donde quedaban los outputs.

Esta carpeta convierte esa orquestacion en un archivo:

```text
run_auto_update.ps1
```

## Que contiene

- `run_auto_update.ps1`: runner principal end-to-end.
- `pipeline_sagrado/PIPELINE SAGRADO`: copia autocontenida del Pipeline Sagrado necesario para ejecutar las tres capas.
- `tools/validate-scrape-contract.js`: validacion previa del JSON de scrapeo.
- `docs/SCRAPPER_ARCHITECTURE.md`: contrato tecnico del scraper.
- `docs/AGENT_HANDOFF_PIPELINE_COMPLETO.md`: contexto completo del pipeline para otro agente/desarrollador.
- `config.example.json`: ejemplos de uso.
- `runs/`: carpeta donde se crean ejecuciones nuevas.

## Punto importante sobre el scraper

Este repo contiene el Pipeline Sagrado y el contrato del scraper, pero no contiene el codigo fuente ejecutable del scraper original.

Por eso el runner soporta dos modos:

1. Recibir un JSON ya scrapeado con `-InputJson`.
2. Ejecutar un scraper externo mediante `-ScraperCommand`.

El modo 2 queda preparado para el futuro automatico diario: cuando el scraper real este disponible, se conecta ahi.

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
