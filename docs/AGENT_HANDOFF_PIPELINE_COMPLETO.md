# Handoff completo para otro agente: pipeline de matching Eciglogistica / Vaperalia

Documento generado para transferir el contexto tecnico y operativo a otra IA o a otro desarrollador sin depender de memoria conversacional.

Repo local principal:

```text
C:\Users\diego\Documents\New project\match-viewer-share
```

Repo GitHub:

```text
https://github.com/diegoppd4-star/match-viewer-vape
```

Ultimo commit subido con pipeline final y SQLLoader:

```text
42511cb Actualizar pipeline final y SQLLoader
```

## 1. Objetivo del proyecto

El objetivo es emparejar productos equivalentes entre dos distribuidoras de vapeo:

- Eciglogistica
- Vaperalia

El caso de uso de negocio es:

1. Una tienda selecciona un producto real de su lineal.
2. El sistema debe devolver la URL de ese mismo producto en una o varias distribuidoras.
3. El match debe respetar producto y variante: color, nicotina, resistencia, capacidad, pack, modelo, formato, etc.

No basta con encontrar productos parecidos. Hay que distinguir, por ejemplo:

- kit vs mod suelto;
- atomizador completo vs drip tip;
- 10 mg vs 20 mg;
- 0.6 ohm vs 0.8 ohm;
- color Hot Pink vs Gradient Purple;
- longfill vs aroma normal;
- version Pro/Plus/Nano/Mini/Koko/etc.

## 2. Problema inicial y por que no se hizo fuerza bruta total

La comparacion bruta de todos los productos de una distribuidora contra todos los productos de la otra no es viable como estrategia principal.

Mapa simplificado:

```text
Eciglogistica: miles de productos
Vaperalia:     miles de productos

Comparacion bruta:

N productos Ecig x M productos Vaperalia

Ejemplo:
4.000 x 4.000 = 16.000.000 comparaciones base

Si ademas se comparan variantes:
productos x variantes x descripciones x reglas tecnicas
```

Eso multiplica:

- coste de computo;
- coste de tokens si se usa LLM;
- falsos positivos;
- tiempo de auditoria humana;
- riesgo de que un candidato incorrecto tape el candidato correcto.

Por eso se construyo una pipeline por capas:

1. Preparacion estructurada de productos y variantes.
2. Matching determinista por tramos, marca, tipo, referencia, tokens y reglas tecnicas.
3. Auditorias inversas y anti-tramo para no perder productos mal categorizados.
4. Rescate determinista por descripcion sobre huerfanos.
5. Capa IA/no determinista separada, con ledger, solo cuando el determinismo no basta.
6. Generacion de JSON maestro.
7. Carga a BDD mediante SQLLoader con enriquecimiento EAN y upsert.

## 3. Regla de oro

Separar siempre:

```text
Determinista
No determinista / IA semantica
Carga a BDD
```

No mezclar decisiones de IA dentro del pipeline determinista.

No crear reglas hardcodeadas para URLs concretas.

Si una decision manual o de IA se acepta, debe quedar en una capa separada con ledger/auditoria. Si un patron se demuestra general y reproducible, entonces puede convertirse en regla determinista conservadora.

## 4. Conceptos clave

### Producto base

Unidad conceptual de producto antes de variantes.

Ejemplos:

- `Vaporesso Xros 4 Nano Pod Kit`
- `Dinner Lady Lemon Sherbets Aroma 30ml`
- `Vaporesso Eco Nano Replacement Pod Pack 2`

### Variante

Una presentacion concreta dentro de una base:

- color;
- nicotina;
- resistencia;
- capacidad;
- pack;
- sabor;
- tamano;
- variante URL con hash en Vaperalia.

Una misma URL puede contener varias variantes. Esto ocurre especialmente en Eciglogistica. Por tanto:

```text
URL != variante unica
```

Para diferenciar variantes se usan campos como:

- `variantId`
- `variantSignature`
- `variantLabel`
- `variantValues`
- `color`
- `reference_color`
- `derived_reference_color`
- `nicotina`
- `capacidad`
- `contenido_ml`
- `bote_ml`
- `resistencia`
- `base_ratio`
- `sabor`
- `tamano`

### Match base

Relacion entre productos base. Si el match base es falso, las variantes pueden heredar ese falso positivo y reforzarlo accidentalmente.

Este fue el problema detectado en casos como:

```text
Ecig: Uwell Caliburn G5 Lite Koko Pod Kit
Vap:  Caliburn G5 Lite 1600mAh Uwell
```

No son el mismo producto aunque compartan tokens. El error nacia en el match base, no en la variante.

### Match variante

Relacion entre variantes concretas dentro de una base aceptada.

Un match de variante no debe arreglar un match base malo. Si la base es distinta, el match debe bloquearse antes.

## 5. Contrato esperado del scraper

El scraper debe entregar, como minimo, estos campos:

```text
distributor
url
name o title
brand
brandCandidates
commercialBrand
reference
breadcrumbPath
metaDescription
description
variants
```

Campos recomendados/adicionales:

```text
baseUrl
category
sourceCategories
productType
productLine
sku
priceTaxExcluded
color
reference_color
derived_reference_color
pod_type
nicotina
capacidad
contenido_ml
bote_ml
resistencia
base_ratio
sabor
cafeina
tamano
variantsJson
derivedJson
```

Notas importantes:

- `brandCandidates` es mejor que una sola marca. Muchas webs muestran marca real, submarca, linea comercial y fabricante mezclados.
- `commercialBrand` puede ser una linea comercial, no siempre la marca legal.
- `productLine` normalmente no sale como dato duro del HTML. Si se crea, debe tratarse como derivado, no como prueba fuerte.
- `breadcrumbPath` ayuda, pero no puede ser una barrera final porque una distribuidora puede clasificar un producto como kit y otra como pod o repuesto.
- `metaDescription` y `description` son criticos para rescates, aromas, longfills y productos donde el titulo no trae toda la informacion.

### Caso color Vaperalia

Se detecto que Vaperalia podia tener en URL un color simplificado y en referencia el color real.

Ejemplo:

```text
URL: black
referencia/producto: Graphite Black
```

Conclusion:

- el scraper debe recoger color desde referencia y desde URL cuando existan;
- el matcher debe priorizar el dato mas especifico;
- no se deben forzar casos concretos como regla de confianza.

## 6. Carpetas importantes del repo

```text
match-viewer-share/
  README.md
  index.html
  match-viewer.js
  match-viewer.css
  share-server.js

  scripts/
    prepare-products-json.js
    run-fuzzy-hardware-tramos.js
    fuzzy-hardware-base-matcher.js
    structural-match-guard.js
    variant-matcher.js
    build-valid-matches-json.js
    build-general-dataset.js
    build-inverse-vaperalia-audit.js
    build-catalog-filtered-unmatched.js
    build-dataset-manifest.js
    rescue-orphans-by-description.js
    build-reviewed-rescue-layer.js
    build-master-seed-jsons.js
    diff-master-jsons.js
    audit-structural-false-positive-risk.ps1

  config/
    structural-equivalence-overrides.json

  PIPELINE SAGRADO/
    README.md
    run_pipeline_1_principal.ps1
    run_pipeline_2_rescate_descripcion.ps1
    00_INSTRUCCIONES/
    01_PIPELINE_PRINCIPAL/
    02_PIPELINE_RESCATE_DESCRIPCION/
    03_INPUTS/
    04_ANEXO_CAPA_IA_NO_DETERMINISTA/

  ZampaDistros/
    server.js
    00_INSTRUCCIONES/

  outputs/
    general.matches.valid.json
    reviewed-rescues.matches.valid.json
    description-rescue-candidates.matches.valid.json
    master-json/
    master-json-structural-fix-20260522/
    audits/
    structural-fix-run/

  SQLLoader/
    README_SQLLOADER.md
    CARGAR_BDD.bat
    VALIDAR_CARGA_SIN_INSERTAR.bat
    ENRIQUECER_EAN13.bat
    scripts/
      enrich-master-ean13.js
      load_master_to_postgres.py
```

## 7. Pipeline 1: determinista principal

Carpeta congelada:

```text
PIPELINE SAGRADO/01_PIPELINE_PRINCIPAL
```

Wrapper:

```powershell
& ".\PIPELINE SAGRADO\run_pipeline_1_principal.ps1" -InputJson "C:\ruta\output.json"
```

Salida principal:

```text
outputs/general.matches.valid.json
```

Pasos internos:

1. Separar productos por `distributor`:
   - `Eciglogistica`
   - `Vaperalia`
2. Preparar CSV de bases y variantes:
   - `eciglogistica__output.base.csv`
   - `eciglogistica__output.variants.csv`
   - `vaperalia__output.base.csv`
   - `vaperalia__output.variants.csv`
3. Ejecutar tramos congelados desde:
   - `PIPELINE SAGRADO/03_INPUTS/tramos_full_2026-05-14.txt`
4. Ejecutar matching base y variantes.
5. Ejecutar auditoria inversa de Vaperalia.
6. Detectar catalogo fuera de tramos.
7. Construir manifest.
8. Construir `general`.

### Sobre los tramos

Los tramos se usan para ordenar y reducir combinatoria. No son una verdad de negocio.

Problema aprendido:

```text
Una distribuidora puede tener un producto en "kits"
y la otra en "pods" o "repuestos".
```

Por eso:

- el tramo ayuda a comparar;
- no debe ser una barrera final;
- despues se ejecutan auditorias inversas y rescates para huerfanos.

### Estados que puede producir Pipeline 1

```text
valid
probable
discarded_low_confidence
ecig_only
vaperalia_only
base_no_match
```

Interpretacion de negocio:

- `matched_both`: producto/variante presente en ambas distribuidoras.
- `only_eciglogistica`: producto/variante presente solo en Eciglogistica.
- `only_vaperalia`: producto/variante presente solo en Vaperalia.

Ojo:

`base_no_match` historicamente significaba bases Ecig sin match base aceptado. Para BDD se debe traducir a `only_eciglogistica` si es una referencia concreta sin equivalente aceptado.

## 8. Matching base determinista

Script principal:

```text
scripts/fuzzy-hardware-base-matcher.js
```

El matcher base usa:

- alias de marca (`scripts/brand-aliases.js`);
- interseccion de `brandCandidates`;
- referencia;
- `syntheticReference`;
- tokens normalizados;
- familia/modelo;
- `productType`;
- campos tecnicos;
- guardia estructural.

### Alias de marca

Ejemplo importante:

```text
Aromes et liquides
A&L
AL
```

No se debe comparar marca como string literal unico. Hay que usar candidatos y alias.

### Guardia estructural

Archivo:

```text
scripts/structural-match-guard.js
```

Se introdujo tras encontrar falsos positivos estructurales. Bloquea candidatos cuando:

- una referencia contiene a otra pero sobra un token fuerte;
- hay conflicto de familia;
- hay conflicto tecnico;
- se mezclan piezas distintas.

Casos que debe evitar:

```text
Caliburn G5 Lite Koko vs Caliburn G5 Lite
PnP X vs PnP 2
Crown X vs Crown IV/V
Xlim SE vs Xlim Go
drip tip/boquilla vs atomizador/tank
pod empty/sin resistencia vs pod con resistencia integrada
kit vs mod suelto
```

Archivo de excepciones documentadas:

```text
config/structural-equivalence-overrides.json
```

Uso correcto:

- Solo excepciones generales y justificadas.
- No usar para forzar una URL concreta por conveniencia.

Informe de esta correccion:

```text
outputs/master-json-structural-fix-20260522/STRUCTURAL_FIX_REPORT.md
outputs/master-json-structural-fix-20260522/DIFF_VS_OLD.md
outputs/audits/structural-false-positive-risk.manual-review.md
```

## 9. Matching de variantes determinista

Script:

```text
scripts/variant-matcher.js
```

Debe comparar los campos de variante:

```text
color
reference_color
derived_reference_color
effective_color
nicotina
capacidad
contenido_ml
bote_ml
resistencia
pod_type
base_ratio
sabor
cafeina
tamano
variantSignature
variantLabel
variantValues
```

Reglas aprendidas:

- Una misma URL puede representar varias variantes.
- Vaperalia suele expresar variantes con fragmentos `#/...`.
- Eciglogistica puede agrupar 10 mg y 20 mg en una misma URL.
- Si Vaperalia solo tiene 10 mg y Ecig tiene 10/20 en la misma URL, el match 10-10 puede ser correcto aunque la URL Ecig muestre tambien 20.
- La variante 20 mg de Ecig no debe desaparecer: si no hay Vaperalia 20 mg, debe quedar como solo Eciglogistica.

### Nicotina

Regla legal recordada por negocio:

```text
Los botes con nicotina no pueden tener mas de 10 ml.
```

No confundir:

- `contenido_ml`
- `bote_ml`
- capacidad total del bote
- liquido contenido
- nicotina en mg

### Longfill

Un longfill es un bote con menos cantidad de liquido/aroma que su capacidad total. Por definicion puede tener:

```text
contenido_ml menor que bote_ml
```

Ejemplo:

```text
30 ml / 120 ml longfill
```

No debe emparejarse automaticamente con un aroma normal de 30 ml si la descripcion o formato indica que son productos distintos.

Error historico:

```text
Ecig Dinner Lady aroma 30 ml
Vaperalia Dinner Lady 30 ml / 120 longfill
```

Eso debe rechazarse si uno es aroma normal y otro longfill.

### Depositos de 2 ml

Regla concreta aceptada para un tramo:

```text
2 ml vs ausencia de ml puede emparejarse
```

Justificacion:

En Europa el estandar de capacidad de depositos suele ser 2 ml. Solo aplica cuando la comparativa es exactamente:

```text
2 ml en un lado
sin dato de ml en el otro
```

No generalizar a otros ml.

## 10. Pipeline 2: rescate determinista por descripcion

Carpeta congelada:

```text
PIPELINE SAGRADO/02_PIPELINE_RESCATE_DESCRIPCION
```

Wrapper:

```powershell
& ".\PIPELINE SAGRADO\run_pipeline_2_rescate_descripcion.ps1" -Pipeline1WorkDir "C:\ruta\pipeline1-workdir"
```

Salidas:

```text
outputs/description-rescue-candidates.matches.valid.json
outputs/audits/description-rescue-candidates.audit.md
```

Este pipeline cruza huerfanos/sobrantes para detectar candidatos que el tramo no comparo.

Regla fundamental:

```text
Pipeline 2 solo produce probables.
Nunca convierte candidatos en validos.
```

Motivo:

Muchos casos requieren lectura semantica. El pipeline puede detectar que algo "huele" a match, pero no debe aceptar automaticamente.

## 11. Capa IA/no determinista

Carpeta:

```text
PIPELINE SAGRADO/04_ANEXO_CAPA_IA_NO_DETERMINISTA
```

Script historico:

```text
scripts/build-reviewed-rescue-layer.js
```

Entradas:

```text
outputs/description-rescue-candidates.matches.valid.json
outputs/audits/description-rescue-candidates.audit.md
outputs/reviews/description-rescue-decisions.json
```

Salidas:

```text
outputs/reviewed-rescues.matches.valid.json
outputs/audits/reviewed-rescues.audit.md
```

Estados permitidos en ledger:

```text
accept
reject
needs_human
```

Principio:

- La IA lee descripciones, HTML scrapeado y campos completos.
- Decide si el candidato probable es el mismo producto.
- La decision se registra en JSON de decisiones.
- Despues un script genera la capa revisada.
- No se altera silenciosamente el pipeline determinista.

Criterios de aceptacion IA:

1. Misma marca real o alias justificado.
2. Misma familia/producto base.
3. Misma variante concreta si existe.
4. Sin conflicto duro.
5. La descripcion refuerza la equivalencia.
6. Diferencias de titulo explicables por orden, abreviatura, traduccion o falta de detalle.

Criterios de rechazo IA:

- nicotina distinta sin variante exacta;
- color distinto real;
- resistencia distinta;
- longfill contra aroma normal;
- drip tip contra atomizador;
- kit contra mod suelto;
- version/modelo distinto;
- edicion contradictoria;
- marca incompatible.

## 12. Master JSON para BDD

Script:

```text
scripts/build-master-seed-jsons.js
```

Salida actual importante:

```text
outputs/master-json-structural-fix-20260522/master_matched_both.json
outputs/master-json-structural-fix-20260522/master_only_eciglogistica.json
outputs/master-json-structural-fix-20260522/master_only_vaperalia.json
```

Archivos:

- `master_matched_both.json`: productos/variantes presentes en ambas distribuidoras.
- `master_only_eciglogistica.json`: productos/variantes solo en Eciglogistica.
- `master_only_vaperalia.json`: productos/variantes solo en Vaperalia.

Conteos actuales de la master estructural:

```text
matched_both: 730
only_eciglogistica: 4766
only_vaperalia: 3723
```

Detalle del diff estructural:

```text
old matched_both: 731
new matched_both: 730
old only_eciglogistica: 4765
new only_eciglogistica: 4766
old only_vaperalia: 3727
new only_vaperalia: 3723
```

La diferencia no fue solo "quitar falsos positivos". Al bloquear falsos candidatos, algunos candidatos correctos volvieron a estar disponibles y pasaron a `matched_both`.

### Fuente de verdad para master

La master final usa:

```text
outputs/general.matches.valid.json
```

Ese `general` final ya incluye la capa `reviewed-rescues` aceptada historicamente.

No usar directamente:

```text
outputs/description-rescue-candidates.matches.valid.json
```

porque contiene probables antes de revision IA.

### Regla de campos en master

Para `matched_both`:

- los campos comparativos de primer nivel salen de Eciglogistica;
- de Vaperalia se conserva la URL en `vaperalia_url`;
- la referencia real en BDD se crea con datos Eciglogistica por decision de negocio;
- se crean dos links distribuidor: Eciglogistica y Vaperalia.

Para `only_eciglogistica`:

- una referencia por producto+variante de Eciglogistica;
- un link de Eciglogistica.

Para `only_vaperalia`:

- una referencia por producto+variante de Vaperalia;
- un link de Vaperalia.

### Campos comparativos incluidos en master

Los campos usados para comparar no van anidados. Se escriben como atributos de primer nivel.

Lista principal:

```text
distributor
url
baseUrl
title
description
baseTitle
category
sourceCategories
brand
brandCandidates
commercialBrand
productLine
breadcrumbPath
metaDescription
productType
typeGroup
reference
syntheticReference
baseKey
variantCount
variantSummary
variantValues
sku
priceTaxExcluded
minPriceTaxExcluded
maxPriceTaxExcluded
sourceFiles
variantSignature
variantLabel
color
reference_color
derived_reference_color
effective_color
pod_type
nicotina
capacidad
contenido_ml
bote_ml
resistencia
base_ratio
sabor
cafeina
tamano
derivedJson
variantsJson
sourceFile
comparison_hash
```

`comparison_hash` es una huella determinista de los campos comparativos normalizados.

## 13. SQLLoader: enriquecimiento EAN y carga BDD

Carpeta versionada:

```text
SQLLoader/
```

Carpeta operativa local actual:

```text
C:\Users\diego\Desktop\SQLLoader
```

Scripts:

```text
SQLLoader/scripts/enrich-master-ean13.js
SQLLoader/scripts/load_master_to_postgres.py
SQLLoader/CARGAR_BDD.bat
SQLLoader/VALIDAR_CARGA_SIN_INSERTAR.bat
SQLLoader/ENRIQUECER_EAN13.bat
```

### Importante sobre credenciales

No subir cadenas de conexion a Git.

El repo contiene `CARGAR_BDD.bat` seguro, que espera:

```text
DATABASE_URL
```

como variable de entorno.

### Inputs que espera SQLLoader

En la carpeta operativa:

```text
SQLLoader/input_master/master_matched_both.json
SQLLoader/input_master/master_only_eciglogistica.json
SQLLoader/input_master/master_only_vaperalia.json
SQLLoader/input_master/prepared/vaperalia__output.variants.csv
SQLLoader/Productos_cliente_Diego_Poole_Prieto.csv
```

El CSV de cliente tiene:

```text
articulo
ean13
```

`articulo` corresponde al campo JSON:

```text
reference
```

### Orden real de carga

`load_master_to_postgres.py` hace:

1. Ejecuta `enrich-master-ean13.js`.
2. Lee los tres master JSON.
3. Genera IDs estables con SHA-256.
4. Deduplica SKUs si hace falta.
5. Limpia EAN13.
6. Si un EAN13 aparece en varias referencias, lo deja en `NULL`.
7. Inserta/upsertea `distribuidoras`.
8. Inserta/upsertea `referencias`.
9. Inserta/upsertea `referencia_distribuidora_links`.
10. Escribe reportes.

### Upsert

La carga usa batch upsert:

```sql
on conflict (id) do update
```

para:

```text
distribuidoras
referencias
referencia_distribuidora_links
```

### EAN13

La tabla `referencias.ean13` es nullable, pero sigue siendo `UNIQUE`.

Por eso:

- EAN unico: se carga.
- EAN repetido entre variantes: se carga como `NULL`.

Ultima validacion de carga:

```text
referencias: 9219
referencia_distribuidora_links: 9949
distribuidoras: 2
links Eciglogistica: 5496
links Vaperalia: 4453
ean13 not null: 1931
ean13 null: 7288
duplicados ean13 not null: 0
```

## 14. ZampaDistros

ZampaDistros es una interfaz visual para admitir JSON de una distribuidora nueva.

Arranque:

```powershell
node ZampaDistros/server.js
```

URL:

```text
http://localhost:8765/
```

Funcion:

1. Permite arrastrar JSON.
2. Valida si tiene campos necesarios.
3. Si faltan campos, devuelve errores.
4. Si pasa contrato, normaliza.
5. Ejecuta admision contra catalogos existentes.
6. Genera informes.

Carpeta de resultados:

```text
outputs/admissions/zampadistros/<distribuidora>-run-<timestamp>/
```

Archivos esperados:

```text
validation-report.md
validation-report.json
input.normalized.json
run-summary.md
prepared/*.base.csv
prepared/*.variants.csv
matches/<target>/*.matches.valid.json
matches/<target>/cross-tramo-rescue.<target>.md
matches/<target>/target-only.<target>.md
```

### Relacion con PIPELINE SAGRADO

`PIPELINE SAGRADO` conserva el proceso original Eciglogistica/Vaperalia.

`ZampaDistros` adapta ese proceso para nuevas distribuidoras.

ZampaDistros no debe validar matches solo por tramo. Debe ejecutar rescate anti-tramo, porque ya se demostro que las categorias de distribuidor no son fiables como frontera final.

## 15. Visor local de matches

Arranque:

```powershell
node share-server.js
```

URL:

```text
http://localhost:8000/
```

Dataset por query param:

```text
http://localhost:8000/?dataset=general
http://localhost:8000/?dataset=reviewed-rescues
http://localhost:8000/?dataset=description-rescue-candidates
http://localhost:8000/?dataset=inverse-vaperalia-audit
```

El visor debe mostrar URL clicable tambien en:

- solo Eciglogistica;
- solo Vaperalia;
- bases sin match;
- descartados.

Esto fue corregido porque era importante auditar productos que no encontraron match.

## 16. Como reproducir los pipelines deterministas

Desde la raiz del repo:

```powershell
cd "C:\Users\diego\Documents\New project\match-viewer-share"
```

Pipeline 1:

```powershell
& ".\PIPELINE SAGRADO\run_pipeline_1_principal.ps1" -InputJson "C:\ruta\output.json"
```

El comando devuelve:

```text
PIPELINE_1_WORKDIR=...
GENERAL_JSON=...
```

Pipeline 2:

```powershell
& ".\PIPELINE SAGRADO\run_pipeline_2_rescate_descripcion.ps1" -Pipeline1WorkDir "C:\ruta\devuelta\por\PIPELINE_1_WORKDIR"
```

El comando devuelve:

```text
PIPELINE_2_WORKDIR=...
RESCUE_JSON=...
RESCUE_AUDIT_MD=...
```

No ejecutar `build-reviewed-rescue-layer.js` como parte de los pipelines deterministas.

## 17. Como generar master JSON

Script:

```powershell
node scripts/build-master-seed-jsons.js `
  --general outputs/general.matches.valid.json `
  --ecig-base "C:\Users\diego\Documents\New project\outputs\prepared\eciglogistica__output.base.csv" `
  --ecig-variants "C:\Users\diego\Documents\New project\outputs\prepared\eciglogistica__output.variants.csv" `
  --vaperalia-base "C:\Users\diego\Documents\New project\outputs\prepared\vaperalia__output.base.csv" `
  --vaperalia-variants "C:\Users\diego\Documents\New project\outputs\prepared\vaperalia__output.variants.csv" `
  --out-dir outputs/master-json
```

Para la version estructural corregida se uso:

```text
outputs/master-json-structural-fix-20260522/
```

Antes de reemplazar master viejas, generar diff:

```powershell
node scripts/diff-master-jsons.js --old outputs/master-json --new outputs/master-json-structural-fix-20260522
```

## 18. Como cargar BDD

Carpeta operativa:

```text
C:\Users\diego\Desktop\SQLLoader
```

Primero validar sin insertar:

```powershell
.\VALIDAR_CARGA_SIN_INSERTAR.bat
```

Luego cargar:

```powershell
$env:DATABASE_URL = "<connection string>"
.\CARGAR_BDD.bat
```

No escribir la cadena real en docs, commits o capturas.

La carga es upsert. Reejecutar no deberia duplicar si los IDs fuente son los mismos.

## 19. Checklist antes de aceptar cambios de otra IA

1. Leer este documento.
2. Leer:
   - `PIPELINE SAGRADO/README.md`
   - `PIPELINE SAGRADO/00_INSTRUCCIONES/CONTRATO_DETERMINISMO.md`
   - `PIPELINE SAGRADO/04_ANEXO_CAPA_IA_NO_DETERMINISTA/LOGICA_REVISION_IA.md`
   - `SQLLoader/README_SQLLOADER.md`
3. Verificar si el cambio es determinista o IA/no determinista.
4. Si es determinista, debe estar en scripts y ser reproducible.
5. Si es IA/no determinista, debe ir a ledger separado.
6. No meter excepciones por URL salvo que se documente como override estructural general y revisable.
7. Ejecutar diff de master si cambia matching.
8. Revisar falsos positivos estructurales:
   - tokens fuertes extra;
   - modelo/version;
   - capacidad;
   - nicotina;
   - resistencia;
   - kit/mod/atomizador/repuesto;
   - longfill/aroma normal.
9. Revisar que los huerfanos siguen apareciendo como `only_eciglogistica` o `only_vaperalia`.
10. Revisar que la BDD no pierde variantes por compartir URL.

## 20. Errores historicos que no deben repetirse

### 20.1 Agrupar ignorando variantes

Preocupacion de negocio:

```text
No se puede agrupar dejando de lado color, nicotina, modelo, marca, etc.
```

Solucion:

- base y variante se tratan separadas;
- la URL no es identificador unico de variante;
- los campos de variante son parte del hash y de la salida master.

### 20.2 Usar categoria como frontera final

Problema:

```text
Un producto puede estar como kit en una web y como pod/repuesto en otra.
```

Solucion:

- tramos para reducir combinatoria;
- inversa Vaperalia;
- rescate anti-tramo;
- rescate por descripcion sobre huerfanos.

### 20.3 Forzar casos concretos

Problema:

Modificar confianza para casar casos concretos no extrapolables.

Solucion:

- no forzar URLs;
- arreglar scraper/campos si falta informacion;
- convertir patrones generales en reglas deterministas conservadoras;
- decisiones semanticas al ledger IA.

### 20.4 Falso positivo por containment de tokens

Ejemplo:

```text
Caliburn G5 Lite Koko
Caliburn G5 Lite
```

Solucion:

- `structural-match-guard.js`;
- auditoria de riesgo estructural;
- diff de master.

### 20.5 Longfill contra aroma normal

Ejemplo:

```text
Dinner Lady Aroma 30 ml
Dinner Lady 30 ml / 120 ml Longfill
```

Solucion:

- entender longfill como formato distinto;
- comparar contenido y bote;
- rechazar si el formato no coincide.

### 20.6 Vaperalia agrupada o separada distinto de Ecig

Ejemplo:

Ecig agrupa 0.6, 0.8 y 1.2 ohm en una URL.

Vaperalia puede separar 0.6 en una URL y 0.8/1.2 en otra.

Solucion:

- no depender solo de URL base;
- resolver por variante;
- permitir que una URL Ecig tenga varios links de variantes;
- no perder variantes no cubiertas.

### 20.7 EAN duplicado entre variantes

Problema:

`referencias.ean13` es `UNIQUE`. Algunos EAN aparecen repetidos en varias referencias/variantes.

Solucion:

- EAN unico se carga;
- EAN repetido se deja `NULL`;
- no elegir ganador arbitrario.

## 21. Que debe hacer un agente nuevo si recibe un scrapeo nuevo

1. Confirmar si el scrapeo contiene ambas distribuidoras o una nueva distribuidora.
2. Validar campos minimos.
3. Si faltan campos:
   - devolver informe de error;
   - no ejecutar matching.
4. Si es Eciglogistica/Vaperalia completo:
   - ejecutar `PIPELINE SAGRADO` Pipeline 1;
   - ejecutar Pipeline 2 si se quiere rescate;
   - mantener IA separada.
5. Si es una distribuidora nueva:
   - usar ZampaDistros;
   - revisar `validation-report.md`;
   - revisar `cross-tramo-rescue`;
   - no aceptar candidatos IA sin ledger.
6. Si se generan master:
   - distinguir claramente `matched_both`, `only_eciglogistica`, `only_vaperalia`;
   - incluir campos comparativos de primer nivel;
   - generar `comparison_hash`;
   - auditar uno-a-varios.
7. Si se carga BDD:
   - enriquecer EAN primero;
   - dry-run;
   - upsert;
   - validar conteos.

## 22. Invariantes de negocio

Estos principios deben mantenerse:

- El objetivo no es "producto parecido"; es "mismo producto/variante real".
- Un producto solo en una distribuidora es informacion valida, no un error.
- Una URL puede tener varias variantes.
- Una variante puede estar separada en una distribuidora y agrupada en otra.
- La categoria de la web no es verdad fuerte.
- La descripcion puede resolver candidatos, pero si la decision no es formalizable debe quedar fuera del pipeline determinista.
- La tabla maestra debe tener una fila por producto/variante real, no una fila por distribuidora.
- Los links por distribuidora se guardan aparte.
- Para `matched_both`, actualmente los valores canonicos se toman de Eciglogistica por decision de negocio.

## 23. Resumen mental rapido

```text
Scrapeo bruto
  |
  v
Validacion de campos
  |
  v
prepare-products-json
  |
  +--> base.csv
  +--> variants.csv
  |
  v
Pipeline 1 determinista
  |
  +--> tramos marca/tipo
  +--> match base
  +--> structural guard
  +--> match variantes
  +--> inversa Vaperalia
  +--> fuera de tramos
  |
  v
general.matches.valid.json
  |
  v
Pipeline 2 determinista por descripcion
  |
  v
description-rescue-candidates (solo probables)
  |
  v
Revision IA separada con ledger
  |
  v
reviewed-rescues
  |
  v
Master JSON
  |
  +--> master_matched_both
  +--> master_only_eciglogistica
  +--> master_only_vaperalia
  |
  v
SQLLoader
  |
  +--> enrich EAN13
  +--> upsert referencias
  +--> upsert referencia_distribuidora_links
```

## 24. Preguntas que el agente debe hacerse antes de tocar codigo

1. Estoy arreglando una regla general o un caso puntual?
2. Esto pertenece al pipeline determinista o a la capa IA?
3. El cambio puede reproducirse con el mismo input?
4. Puede crear falsos positivos estructurales?
5. Puede ocultar variantes solo Ecig o solo Vaperalia?
6. Estoy usando categoria como barrera final?
7. Estoy tratando URL como variante unica?
8. Estoy respetando longfill/nicotina/capacidad?
9. Hay que regenerar master JSON?
10. Hay que hacer diff contra master anterior?
11. Hay que actualizar SQLLoader o solo outputs?
12. Estoy evitando subir credenciales?

## 25. Archivos de lectura obligatoria

```text
README.md
PROJECT_OVERVIEW_AND_PIPELINES.es.md
docs/MEMORY_PIPELINES_MATCHING.md
PIPELINE SAGRADO/README.md
PIPELINE SAGRADO/00_INSTRUCCIONES/INSTRUCCIONES_PARA_IA.md
PIPELINE SAGRADO/00_INSTRUCCIONES/CONTRATO_DETERMINISMO.md
PIPELINE SAGRADO/04_ANEXO_CAPA_IA_NO_DETERMINISTA/LOGICA_REVISION_IA.md
ZampaDistros/00_INSTRUCCIONES/RELACION_CON_PIPELINE_SAGRADO.md
outputs/master-json-structural-fix-20260522/README.md
outputs/master-json-structural-fix-20260522/STRUCTURAL_FIX_REPORT.md
SQLLoader/README_SQLLOADER.md
```

## 26. Estado actual resumido

Estado del proyecto tras las ultimas ediciones:

- Pipeline final subido a GitHub.
- Guardia estructural integrada.
- Master estructurales generadas.
- SQLLoader versionado.
- Enriquecimiento EAN integrado en carga.
- Carga BDD realizada y validada.
- `ean13` nullable confirmado.
- Upsert batch funcionando.
- No hay credenciales versionadas en repo.

El siguiente agente debe continuar desde esta base, no reconstruir desde memoria.
