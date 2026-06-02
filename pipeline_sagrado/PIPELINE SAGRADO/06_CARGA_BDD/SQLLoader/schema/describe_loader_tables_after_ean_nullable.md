# Describe tablas de carga tras ean13 nullable

## public.referencias

Filas actuales: 0

| # | Columna | Tipo | Nullable | Default |
|---:|---|---|---|---|
| 1 | `bote_ml` | `double precision` | YES | `` |
| 2 | `cantidad_ml` | `double precision` | YES | `` |
| 3 | `contenido_ml` | `double precision` | YES | `` |
| 4 | `minimo_unidades_compra` | `integer` | NO | `` |
| 5 | `nivel_nicotina` | `double precision` | YES | `` |
| 6 | `id` | `bigint` | NO | `` |
| 7 | `ean13` | `character varying(13)` | YES | `` |
| 8 | `categoria` | `character varying(16)` | YES | `` |
| 9 | `base_ratio` | `character varying(40)` | YES | `` |
| 10 | `pod_type` | `character varying(40)` | YES | `` |
| 11 | `cafeina` | `character varying(80)` | YES | `` |
| 12 | `color` | `character varying(80)` | YES | `` |
| 13 | `omniaje` | `character varying(80)` | YES | `` |
| 14 | `product_type` | `character varying(80)` | YES | `` |
| 15 | `linea_producto` | `character varying(120)` | YES | `` |
| 16 | `marca` | `character varying(120)` | YES | `` |
| 17 | `marca_comercial` | `character varying(120)` | YES | `` |
| 18 | `sku` | `character varying(120)` | NO | `` |
| 19 | `tamano` | `character varying(120)` | NO | `` |
| 20 | `base_key` | `character varying(160)` | YES | `` |
| 21 | `name` | `character varying(160)` | NO | `` |
| 22 | `sabor` | `character varying(160)` | YES | `` |

### Constraints

- `referencias_categoria_check`: `CHECK (((categoria)::text = ANY ((ARRAY['NICOTINA'::character varying, 'RESISTENCIAS'::character varying, 'LIQUIDOS'::character varying, 'MAQUINAS'::character varying, 'DESECHABLES'::character varying, 'ALQUIMIAS'::character varying, 'OTROS'::character varying])::text[])))`
- `referencias_minimo_unidades_compra_check`: `CHECK ((minimo_unidades_compra >= 1))`
- `referencias_pkey`: `PRIMARY KEY (id)`
- `uk_referencias_ean13`: `UNIQUE (ean13)`
- `uk_referencias_sku`: `UNIQUE (sku)`

### Indices

- `referencias_pkey`: `CREATE UNIQUE INDEX referencias_pkey ON public.referencias USING btree (id)`
- `uk_referencias_ean13`: `CREATE UNIQUE INDEX uk_referencias_ean13 ON public.referencias USING btree (ean13)`
- `uk_referencias_id`: `CREATE UNIQUE INDEX uk_referencias_id ON public.referencias USING btree (id) WHERE (id IS NOT NULL)`
- `uk_referencias_sku`: `CREATE UNIQUE INDEX uk_referencias_sku ON public.referencias USING btree (sku)`

## public.referencia_distribuidora_links

Filas actuales: 0

| # | Columna | Tipo | Nullable | Default |
|---:|---|---|---|---|
| 1 | `activo` | `boolean` | NO | `` |
| 2 | `match_confidence` | `double precision` | YES | `` |
| 3 | `price_tax_excluded` | `double precision` | YES | `` |
| 4 | `deleted_at` | `timestamp with time zone` | YES | `` |
| 5 | `distribuidora_id` | `bigint` | NO | `` |
| 6 | `id` | `bigint` | NO | `` |
| 7 | `referencia_id` | `bigint` | YES | `` |
| 8 | `scraped_at` | `timestamp with time zone` | YES | `` |
| 9 | `updated_at` | `timestamp with time zone` | NO | `` |
| 10 | `base_url` | `character varying(2048)` | YES | `` |
| 11 | `url` | `character varying(2048)` | NO | `` |
| 12 | `brand_candidates` | `text` | YES | `` |
| 13 | `breadcrumb_path` | `text` | YES | `` |
| 14 | `derived_reference_color` | `character varying(255)` | YES | `` |
| 15 | `description` | `text` | YES | `` |
| 16 | `match_reason` | `text` | YES | `` |
| 17 | `meta_description` | `text` | YES | `` |
| 18 | `reference_color` | `character varying(255)` | YES | `` |
| 19 | `source_brand` | `character varying(255)` | YES | `` |
| 20 | `source_reference` | `character varying(255)` | YES | `` |
| 21 | `source_title` | `character varying(255)` | YES | `` |
| 22 | `synthetic_reference` | `character varying(255)` | YES | `` |
| 23 | `variant_signature` | `character varying(255)` | YES | `` |
| 24 | `variante` | `character varying(255)` | YES | `` |
| 25 | `variants_json` | `text` | YES | `` |

### Constraints

- `fkhoa4fnqxy1lnrga1d8pggpc66`: `FOREIGN KEY (distribuidora_id) REFERENCES distribuidoras(id)`
- `referencia_distribuidora_links_pkey`: `PRIMARY KEY (id)`
- `uk_ref_distribuidora_link_ref_distribuidora_variante`: `UNIQUE (referencia_id, distribuidora_id, variante)`

### Indices

- `referencia_distribuidora_links_pkey`: `CREATE UNIQUE INDEX referencia_distribuidora_links_pkey ON public.referencia_distribuidora_links USING btree (id)`
- `uk_ref_distribuidora_link_ref_distribuidora_variante`: `CREATE UNIQUE INDEX uk_ref_distribuidora_link_ref_distribuidora_variante ON public.referencia_distribuidora_links USING btree (referencia_id, distribuidora_id, variante)`

## public.distribuidoras

Filas actuales: 0

| # | Columna | Tipo | Nullable | Default |
|---:|---|---|---|---|
| 1 | `tiempo_entrega_default_dias` | `integer` | NO | `` |
| 2 | `id` | `bigint` | NO | `` |
| 3 | `cif` | `character varying(32)` | YES | `` |
| 4 | `vat` | `character varying(32)` | YES | `` |
| 5 | `localidad` | `character varying(160)` | YES | `` |
| 6 | `nombre` | `character varying(160)` | NO | `` |
| 7 | `logo_link` | `character varying(512)` | YES | `` |

### Constraints

- `distribuidoras_pkey`: `PRIMARY KEY (id)`
- `distribuidoras_tiempo_entrega_default_dias_check`: `CHECK ((tiempo_entrega_default_dias >= 0))`
- `uk_distribuidoras_cif`: `UNIQUE (cif)`
- `uk_distribuidoras_nombre`: `UNIQUE (nombre)`

### Indices

- `distribuidoras_pkey`: `CREATE UNIQUE INDEX distribuidoras_pkey ON public.distribuidoras USING btree (id)`
- `uk_distribuidoras_cif`: `CREATE UNIQUE INDEX uk_distribuidoras_cif ON public.distribuidoras USING btree (cif)`
- `uk_distribuidoras_nombre`: `CREATE UNIQUE INDEX uk_distribuidoras_nombre ON public.distribuidoras USING btree (nombre)`
