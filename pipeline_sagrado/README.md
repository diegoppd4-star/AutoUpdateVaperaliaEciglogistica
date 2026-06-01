# pipeline_sagrado

Copia autocontenida del Pipeline Sagrado usado por `run_auto_update.ps1`.

Se incluye aqui para que el orquestador no dependa de rutas externas ni de que Codex recuerde donde estaba cada script.

El runner llama a:

1. `PIPELINE SAGRADO/run_pipeline_1_principal.ps1`
2. `PIPELINE SAGRADO/run_pipeline_2_rescate_descripcion.ps1`
3. `PIPELINE SAGRADO/run_pipeline_3_ia_no_determinista.ps1`

No edites esta copia si el cambio debe afectar al Pipeline Sagrado principal. Primero actualiza la fuente principal y despues vuelve a copiarla aqui.
