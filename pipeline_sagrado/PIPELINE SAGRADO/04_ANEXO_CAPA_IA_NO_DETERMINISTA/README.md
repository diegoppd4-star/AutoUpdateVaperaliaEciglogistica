# Anexo - Capa IA no determinista

Este anexo documenta la logica usada para revisar con IA/humano los candidatos del Pipeline 2.

No forma parte del Pipeline 1 ni del Pipeline 2. Esta aqui solo para que la revision pueda repetirse mas adelante de forma trazable.

## Contenido

- `LOGICA_REVISION_IA.md`: reglas y procedimiento de revision.
- `PROMPT_REPRODUCCION.md`: prompt operativo para Codex u otra IA.
- `FORMATO_LEDGER.md`: estructura de decisiones.
- `generate-description-rescue-decisions-codexexec.js`: runner que construye el paquete de contexto, llama a CodexExec y escribe el ledger.
- `build-reviewed-rescue-layer.js`: script que convierte el ledger en dataset visible.
- `ledger_referencia/description-rescue-decisions.json`: ledger historico usado.
- `ledger_referencia/reviewed-rescues.audit.md`: auditoria historica de la capa publicada.
- `ledger_referencia/description-rescue-candidates.audit.md`: auditoria fuente de candidatos.

## Regla

La IA no debe modificar los scripts del Pipeline 1 o Pipeline 2.

La IA solo puede:

1. Leer candidatos probables.
2. Revisar campos extraidos.
3. Escribir decisiones explicitas en un ledger (`accepted` o `rejected`).
4. Ejecutar `build-reviewed-rescue-layer.js`.

El resultado debe publicarse separado como `reviewed-rescues`, nunca mezclado silenciosamente con `general`.

En modo automatico no debe quedar cola `needs_human`. Cuando CodexExec no tenga certeza suficiente para aceptar, debe rechazar el candidato y dejar el motivo en el ledger.

## Ejecucion reproducible

Desde el workdir que ya contiene los resultados de Pipeline 1 y Pipeline 2:

```powershell
node scripts/generate-description-rescue-decisions-codexexec.js --rescue outputs/description-rescue-candidates.matches.valid.json --rescue-audit outputs/audits/description-rescue-candidates.audit.md --original-scrape C:\ruta\output.json --out outputs/reviews/description-rescue-decisions.json
node scripts/build-reviewed-rescue-layer.js --rescue outputs/description-rescue-candidates.matches.valid.json --decisions outputs/reviews/description-rescue-decisions.json --a-variants outputs/prepared/eciglogistica__output.variants.csv --b-variants outputs/prepared/vaperalia__output.variants.csv
```

Preferiblemente usar el wrapper de raiz:

```powershell
& ".\PIPELINE SAGRADO\run_pipeline_3_ia_no_determinista.ps1" -PipelineWorkDir "C:\ruta\workdir" -OriginalScrapeJson "C:\ruta\output.json"
```
