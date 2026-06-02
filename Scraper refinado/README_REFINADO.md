# Scraper refinado

Este directorio conserva una copia separada del scraper legacy y aplica solo el cambio necesario para acelerar Eciglogistica sin borrar ni sustituir `scraper/`.

## Cambio aplicado

- `src/connectors/eciglogistica.ts`
  - Antes: `enrichInline = true`
  - Ahora: `enrichInline = false`

Con esto Eciglogistica deja de abrir cada ficha de producto con Playwright durante el crawl de listados. La ficha se descarga despues por HTTP y se parsea con Cheerio en la fase 2, usando la concurrencia existente del scraper.

La logica de extraccion de campos no cambia:

- `variants`
- `brand`
- `brandCandidates`
- `commercialBrand`
- `reference`
- `category`
- `breadcrumbPath`
- `priceTaxExcluded`
- `description`
- `metaDescription`

## Auditoria realizada

### Muestra Eciglogistica

Comando legacy:

```bash
node scraper/dist/index.js --connector eciglogistica --categories nicotine-salts --limit 8 --output-dir runs/audit-scraper-legacy-ecig-sample-v2
```

Comando refinado:

```bash
node "Scraper refinado/dist/index.js" --connector eciglogistica --categories nicotine-salts --limit 8 --output-dir runs/audit-scraper-refinado-ecig-sample-v2
```

Resultado:

- Legacy: 8 productos base -> 30 filas variantes.
- Refinado: 8 productos base -> 30 filas variantes.
- No faltan filas en refinado comparando por `url + name + variants`.
- No aparecen filas extra en refinado comparando por `url + name + variants`.
- Cobertura de campos critica equivalente.
- Tiempo aproximado observado:
  - Legacy: 79 s.
  - Refinado: 6-8 s.

### Diferencia detectada

El campo `reference` puede variar en Eciglogistica para productos con variantes bajo la misma URL. La web devuelve en el HTML una referencia de articulo asociada a una variante seleccionada por defecto, y esa variante seleccionada puede cambiar entre peticiones. Por eso el scraper legacy tampoco es estable en ese campo.

Ejemplo observado:

- `https://nueva.eciglogistica.com/juice-sauz-drifter-bar-salts-watermelon-ice-10ml`
- Misma URL y mismas variantes `MG`.
- La referencia visible puede aparecer como distintas referencias de articulo segun el HTML servido.

Conclusion: no se debe exigir igualdad literal de `reference` entre ejecuciones legacy/refinadas para estos casos. Si se necesita EAN/ref por variante, habria que implementar una mejora especifica que consulte la variante seleccionada via POST y asigne referencia por variante. Esa mejora no se incluye aqui porque cambiaria la salida funcional del legacy.

### Contrato de pipeline

Comando de muestra combinada:

```bash
node "Scraper refinado/dist/index.js" --connector all --categories vaperalia:kits-y-mods,eciglogistica:atomizadores --output-dir runs/audit-scraper-refinado-combined-contract
node tools/validate-scrape-contract.js --input runs/audit-scraper-refinado-combined-contract/output.json --out runs/audit-scraper-refinado-combined-contract-report.json
```

Resultado:

- `ok: true`
- Total: 132 filas.
- Vaperalia: 85 filas.
- Eciglogistica: 47 filas.
- Errores: 0.
- Warnings: 3, todos por `metaDescription` ausente en variantes de `innokin-prism-t20s-tank`.

## Uso

Para usar el scraper refinado en una ejecucion manual:

```bash
cd "Scraper refinado"
npm ci
npm run build
node dist/index.js --connector all --output-dir output
```

Para usarlo dentro de Docker/AutoUpdate haria falta cambiar explicitamente el orquestador o el Dockerfile para apuntar a este directorio. En este commit se conserva separado para poder auditarlo sin eliminar el scraper legacy.
