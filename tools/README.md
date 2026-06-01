# tools

Utilidades auxiliares del orquestador.

## `validate-scrape-contract.js`

Valida que el JSON scrapeado tenga el contrato minimo que necesita el Pipeline Sagrado para arrancar:

- `distributor`
- `url`
- `name` o `title`

Y avisa si faltan campos importantes para la calidad del matching:

- `reference`
- `brand`, `brandCandidates` o `commercialBrand`
- `variants` como objeto
- `description`
- `metaDescription`
- `breadcrumbPath`

Tambien comprueba que existan productos de:

- Eciglogistica
- Vaperalia

No intenta corregir el scrapeo. Si faltan campos bloqueantes, corta la ejecucion antes de gastar tiempo en el pipeline. Si faltan campos de calidad, deja warnings para auditoria.

Uso directo:

```powershell
node tools\validate-scrape-contract.js --input C:\ruta\output.json --out validation-report.json
```
