# Estructura

```text
PIPELINE SAGRADO/
  README.md
  run_pipeline_1_principal.ps1
  run_pipeline_2_rescate_descripcion.ps1
  00_INSTRUCCIONES/
    INSTRUCCIONES_PARA_IA.md
    CONTRATO_DETERMINISMO.md
    CIFRAS_REFERENCIA.md
    ESTRUCTURA.md
  01_PIPELINE_PRINCIPAL/
    scripts/
  02_PIPELINE_RESCATE_DESCRIPCION/
    scripts/
  03_INPUTS/
    tramos_full_2026-05-14.txt
    tramos_full_2026-05-14.annotated.txt
  04_ANEXO_CAPA_IA_NO_DETERMINISTA/
    README.md
    LOGICA_REVISION_IA.md
    PROMPT_REPRODUCCION.md
    FORMATO_LEDGER.md
    build-reviewed-rescue-layer.js
    ledger_referencia/
```

## Scripts del Pipeline 1

- `prepare-products-json.js`
- `brand-aliases.js`
- `run-fuzzy-hardware-tramos.js`
- `run-deterministic-tramos.js`
- `fuzzy-hardware-base-matcher.js`
- `variant-matcher.js`
- `build-valid-matches-json.js`
- `export-readable-json.js`
- `build-inverse-vaperalia-audit.js`
- `build-catalog-filtered-unmatched.js`
- `build-dataset-manifest.js`
- `build-general-dataset.js`

## Anexo IA no determinista

No es parte del pipeline determinista. Sirve para reproducir una revision futura con ledger auditable.

## Scripts del Pipeline 2

- `rescue-orphans-by-description.js`
- `brand-aliases.js`
- `build-dataset-manifest.js`
- `build-general-dataset.js`
