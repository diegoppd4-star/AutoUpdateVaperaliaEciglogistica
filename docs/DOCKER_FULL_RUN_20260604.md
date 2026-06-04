# Prueba Docker definitiva 2026-06-04

Run principal:

```text
runs/20260604-133345-docker-fused-full-refresh-load-bdd-dryrun
```

## Comando

Se ejecuto en Docker Compose con scraper integrado, backfill de URLs conocidas, CodexExec y loader BDD en dry-run.

La carga BDD se recupero con `--only-load-bdd` tras detectar que el CSV de EAN13 no estaba disponible dentro del contenedor. El runner queda corregido con `--ean-csv`.

## Scrapeo

Contrato de scrapeo: `ok: true`.

```json
{
  "totalRows": 10016,
  "Vaperalia": 4492,
  "Eciglogistica": 5524,
  "uniqueDistributorUrls": 7739
}
```

Eciglogistica recupero URLs historicas vivas mediante backfill despues del crawl de categorias.

## Matching final

Archivo agregado:

```text
pipeline-work/outputs/general.matches.valid.json
```

Resumen final:

```json
{
  "baseRows": 3247,
  "baseMatchesKept": 223,
  "baseProductsVisible": 280,
  "validVariants": 740,
  "probableVariants": 3,
  "totalVariantsKept": 743,
  "totalVariantsVisible": 1277,
  "discardedVariantsVisible": 534,
  "ecigOnlyVariants": 190,
  "vaperaliaOnlyVariants": 282,
  "discardedBaseMatches": 2967,
  "discarded_low_confidence": 62
}
```

## Rescate por descripcion

Archivo:

```text
pipeline-work/outputs/description-rescue-candidates.matches.valid.json
```

Resumen:

```json
{
  "baseRows": 64,
  "baseMatchesKept": 64,
  "probableVariants": 81,
  "rescueSourceCounts": {
    "base": 51,
    "variant": 13
  }
}
```

## Capa IA no determinista

Archivo:

```text
pipeline-work/outputs/reviewed-rescues.matches.valid.json
```

Resumen:

```json
{
  "baseRows": 57,
  "baseMatchesKept": 57,
  "validVariants": 72,
  "probableVariants": 0,
  "discarded_low_confidence": 9,
  "ecigOnlyVariants": 5,
  "vaperaliaOnlyVariants": 2
}
```

## Loader BDD dry-run

Archivo:

```text
pipeline-work/sql-loader/run_output/sql-loader-report.json
```

Resumen:

```json
{
  "dryRun": true,
  "referencias": 9284,
  "referencia_distribuidora_links": 10027,
  "eanEnrichmentRan": true,
  "duplicateEansSetToNull": 977,
  "eanRowsSetToNullBecauseDuplicate": 3116,
  "unresolvedVaperaliaLinks": 0
}
```

No se inserto nada en BDD. El dry-run genero plan y reportes.

## Incidencia corregida

Primer intento de loader:

```text
No existe CSV: /app/.../sql-loader/Productos_cliente_Diego_Poole_Prieto.csv
```

Correccion:

- Nuevo flag `--ean-csv <path>`.
- Tambien soporta variable de entorno `EAN_CSV`.
- En Docker Compose, copiar el CSV no versionado a `runs/local-inputs/` y pasarlo como `/app/runs/local-inputs/Productos_cliente_Diego_Poole_Prieto.csv`.
