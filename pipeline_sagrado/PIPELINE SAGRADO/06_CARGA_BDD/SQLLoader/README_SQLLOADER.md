# SQLLoader

Carpeta operativa para cargar las master JSON en PostgreSQL.

## Orden del pipeline

1. `scripts/enrich-master-ean13.js`
   - Lee `Productos_cliente_Diego_Poole_Prieto.csv`.
   - Cruza `articulo` contra `reference`.
   - Anade `ean13` a `master_matched_both.json` y `master_only_eciglogistica.json`.

2. `scripts/load_master_to_postgres.py`
   - Vuelve a ejecutar el enriquecimiento EAN13 salvo que se use `--skip-ean-enrichment`.
   - Genera una referencia por cada fila de:
     - `master_only_eciglogistica.json`
     - `master_only_vaperalia.json`
     - `master_matched_both.json`
   - Para `matched_both`, la referencia se crea con los datos de Eciglogistica.
   - Crea links en `referencia_distribuidora_links`:
     - uno para Eciglogistica en `only_eciglogistica`;
     - uno para Vaperalia en `only_vaperalia`;
     - dos para `matched_both`.
   - Carga en PostgreSQL mediante upsert batch:
     - `distribuidoras`: `on conflict (id) do update`;
     - `referencias`: `on conflict (id) do update`;
     - `referencia_distribuidora_links`: `on conflict (id) do update`.

## Ejecutables

- `VALIDAR_CARGA_SIN_INSERTAR.bat`: prepara todo y genera informe sin insertar.
- `CARGAR_BDD.bat`: ejecuta el pipeline completo y hace upsert contra la BDD.
- `ENRIQUECER_EAN13.bat`: solo ejecuta el enriquecimiento EAN13.

## Salidas

- `run_output/ean13-enrichment-report.*`
- `run_output/sql-loader-report.*`
- `schema/describe_loader_tables_after_ean_nullable.*`

## Nota EAN13

`referencias.ean13` es nullable. Si un EAN aparece en varias variantes, el loader lo deja a `NULL` en la carga para respetar el `UNIQUE` de PostgreSQL y evitar elegir arbitrariamente una variante ganadora.
