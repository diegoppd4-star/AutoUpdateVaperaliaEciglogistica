# PIPELINE SAGRADO

Congelacion operativa de los dos pipelines deterministas del proyecto Eciglogistica / Vaperalia.

Esta carpeta existe para que otra IA, otro desarrollador o nosotros mismos podamos repetir el trabajo sin depender de memoria conversacional.

## Que contiene

- `01_PIPELINE_PRINCIPAL`: matching determinista principal Eciglogistica -> Vaperalia.
- `02_PIPELINE_RESCATE_DESCRIPCION`: rescate determinista por descripcion sobre huerfanos/sobrantes.
- `03_INPUTS`: lista de tramos congelada usada para el relanzamiento completo.
- `04_ANEXO_CAPA_IA_NO_DETERMINISTA`: descripcion, ledger de referencia y runner CodexExec de la capa IA, separado del pipeline determinista.
- `00_INSTRUCCIONES`: contrato operativo, cifras de referencia e instrucciones para otra IA.
- `run_pipeline_1_principal.ps1`: wrapper reproducible del pipeline principal.
- `run_pipeline_2_rescate_descripcion.ps1`: wrapper reproducible del rescate por descripcion.
- `run_pipeline_3_ia_no_determinista.ps1`: wrapper reproducible de la capa IA no determinista con CodexExec.

## Regla de oro

No mezclar la capa no determinista con los resultados deterministas.

Los pipelines 1 y 2 no ejecutan la capa no determinista.

El anexo `04_ANEXO_CAPA_IA_NO_DETERMINISTA` documenta como repetir la revision, conserva una referencia historica y permite lanzar CodexExec para generar un ledger nuevo. Si se usa, debe publicarse como capa separada y etiquetada.

## Uso rapido

Desde la raiz del repo:

```powershell
& ".\PIPELINE SAGRADO\run_pipeline_1_principal.ps1" -InputJson "C:\ruta\output.json"
```

El comando devuelve una carpeta de trabajo temporal y genera:

```text
outputs/general.matches.valid.json
```

Despues:

```powershell
& ".\PIPELINE SAGRADO\run_pipeline_2_rescate_descripcion.ps1" -Pipeline1WorkDir "C:\ruta\a\la\carpeta\temporal"
```

Ese segundo comando genera:

```text
outputs/description-rescue-candidates.matches.valid.json
outputs/audits/description-rescue-candidates.audit.md
```

La capa IA no determinista se lanza despues del Pipeline 2:

```powershell
& ".\PIPELINE SAGRADO\run_pipeline_3_ia_no_determinista.ps1" -PipelineWorkDir "C:\ruta\a\la\carpeta\temporal" -OriginalScrapeJson "C:\ruta\output.json"
```

Ese tercer comando genera:

```text
outputs/reviews/description-rescue-decisions.json
outputs/reviews/description-rescue-codexexec-prompt.json
outputs/reviewed-rescues.matches.valid.json
outputs/audits/reviewed-rescues.audit.md
```

Para auditar el paquete de contexto sin llamar a CodexExec:

```powershell
& ".\PIPELINE SAGRADO\run_pipeline_3_ia_no_determinista.ps1" -PipelineWorkDir "C:\ruta\a\la\carpeta\temporal" -OriginalScrapeJson "C:\ruta\output.json" -DryRun
```

## Inputs esperados

El JSON de entrada puede contener ambas distribuidoras mezcladas. El runner separa por:

- `distributor = Eciglogistica`
- `distributor = Vaperalia`

Debe incluir los campos del contrato nuevo:

- `url`
- `name` o `title`
- `brand`, `brandCandidates` o `commercialBrand`
- `reference`
- `breadcrumbPath`
- `metaDescription`
- `description`
- `variants`
