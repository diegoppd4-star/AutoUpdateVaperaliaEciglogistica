# Prompt de reproduccion para Codex

Usa este prompt si otra instancia de Codex debe repetir la capa IA/no determinista.

```text
Lee primero:

- PIPELINE SAGRADO/README.md
- PIPELINE SAGRADO/00_INSTRUCCIONES/CONTRATO_DETERMINISMO.md
- PIPELINE SAGRADO/04_ANEXO_CAPA_IA_NO_DETERMINISTA/LOGICA_REVISION_IA.md

Objetivo:

Revisar los candidatos de outputs/description-rescue-candidates.matches.valid.json sin modificar el pipeline determinista.

Procedimiento:

1. Lee cada candidato probable.
2. Lee sus campos completos: URL, titulo, marca/candidatas, referencia, categoria/breadcrumb, variantes, descripcion y metaDescription.
3. Decide accepted/rejected.
4. Acepta solo si no hay conflictos duros de variante, modelo, formato, capacidad, nicotina, color, ohm, pack o edicion.
5. Rechaza si una descripcion generica de familia no prueba la variante concreta.
6. Registra cada decision en outputs/reviews/description-rescue-decisions.json.
7. No edites general.matches.valid.json.
8. Ejecuta node scripts/build-reviewed-rescue-layer.js para publicar reviewed-rescues.
9. Resume cuantas decisiones son accepted/rejected y por que.

Formato de salida esperado:

- Ledger JSON actualizado.
- outputs/reviewed-rescues.matches.valid.json
- outputs/audits/reviewed-rescues.audit.md

Runner recomendado:

```powershell
& ".\PIPELINE SAGRADO\run_pipeline_3_ia_no_determinista.ps1" -PipelineWorkDir "C:\ruta\workdir" -OriginalScrapeJson "C:\ruta\output.json"
```

Ese runner usa `generate-description-rescue-decisions-codexexec.js`, que pasa a CodexExec:

- el JSON completo de `description-rescue-candidates`;
- la auditoria markdown de esos candidatos;
- evidencia enriquecida desde el scrape original (`title`, `url`, `reference`, `brandCandidates`, `commercialBrand`, `breadcrumbPath`, `variants`, `description`, `metaDescription`);
- criterios de aceptacion/rechazo y conflictos duros.

Regla:

Si dudas, no aceptes. Marca rejected. La ejecucion automatica no debe dejar cola humana.
```
