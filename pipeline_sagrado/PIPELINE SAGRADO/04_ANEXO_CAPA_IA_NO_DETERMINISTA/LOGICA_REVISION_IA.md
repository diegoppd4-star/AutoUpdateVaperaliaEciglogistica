# Logica de revision IA no determinista

## Objetivo

Revisar semanticamente los candidatos `probable` generados por el Pipeline 2 (`description-rescue-candidates`) y decidir si deben elevarse a una capa separada de matches revisados.

La revision no cambia el matcher. No convierte reglas puntuales en codigo. No modifica `general`.

## Entrada obligatoria

La IA debe leer, como minimo:

- `outputs/description-rescue-candidates.matches.valid.json`
- `outputs/audits/description-rescue-candidates.audit.md`
- CSVs preparados de base y variantes si necesita campos completos.
- JSON scrapeado original si necesita HTML/campos completos no visibles en el dataset.

Campos a revisar en cada par:

- URL de Eciglogistica.
- URL de Vaperalia.
- titulo/base de producto.
- variantes concretas.
- marca, `brandCandidates`, `commercialBrand`.
- referencia y `syntheticReference`.
- `breadcrumbPath` y categoria.
- descripcion.
- `metaDescription`.
- campos de capacidad, nicotina, resistencia, color, pack y formato.

## Salida obligatoria

La IA no edita el dataset directamente.

Debe escribir decisiones en:

```text
outputs/reviews/description-rescue-decisions.json
```

Despues se ejecuta:

```powershell
node scripts/build-reviewed-rescue-layer.js
```

La salida publicada es:

```text
outputs/reviewed-rescues.matches.valid.json
outputs/audits/reviewed-rescues.audit.md
```

## Estados permitidos

- `accept`: se acepta el candidato como equivalente revisado.
- `reject`: se rechaza.
- `needs_human`: estado historico/de auditoria manual. No debe usarse en ejecuciones automaticas con CodexExec.

En ejecuciones automaticas sin presencia humana, el resultado debe ser binario:

- `accepted`: suficientemente seguro para publicar en la capa IA.
- `rejected`: no suficientemente seguro para publicar.

## Criterios de aceptacion

Aceptar solo si se cumple todo:

1. Misma marca real o marca comercial equivalente.
2. Misma familia/producto base.
3. Misma variante real cuando exista variante: color, nicotina, ohm, capacidad, pack, modelo.
4. No hay conflicto duro.
5. La descripcion refuerza el mismo producto o receta/modelo.
6. La diferencia de nombre se explica por orden, traduccion, abreviatura, familia comercial o falta de detalle en un lado.

Ejemplos de diferencias aceptables:

- `Aromes et liquides` frente a `A&L`.
- `Sweet Edition` presente en un lado y ausente en otro si la receta/nombre propio coincide y no hay edicion contradictoria.
- `30ml` frente a variante `capacidad=30 ml` si ambos son aroma normal.
- URL base en un lado y variante anclada por hash en el otro si los campos de variante coinciden.
- Una distribuidora agrupa variantes en una URL y la otra separa una variante en URL propia, si la variante exacta coincide.

## Criterios de rechazo

Rechazar si aparece cualquiera de estos conflictos:

- Nicotina distinta: `10mg` contra `20mg`, salvo que ambos lados tengan variante exacta consumida como `10-10` o `20-20`.
- Color distinto real: `Gradient Purple` contra `Hot Pink`.
- Resistencia distinta: `0.6 ohm` contra `0.8 ohm`, salvo familia base separada y variante exacta.
- Capacidad primaria distinta no explicable por longfill.
- Longfill contra aroma normal si solo un lado declara longfill y el bote/capacidad no coincide.
- Drip tip/boquilla contra atomizador/tanque completo.
- Kit contra mod suelto.
- Version o modelo distinto: `Nano`, `Mini`, `Pro`, `Plus`, `V2`, `Max`, `Legend`, `Primal`, etc., cuando actuan como diferenciadores reales.
- Edicion contradictoria: `Sweet Edition` contra `Green Edition`, `Dessert Bar` contra linea normal si no se demuestra que es el mismo producto.
- Marca incompatible o alias no justificado.
- La descripcion generica de familia menciona muchas variantes y no confirma la variante concreta.

## Confianza

Usar tres niveles:

- `high`: nombre propio, marca, formato y variante coinciden; descripcion lo refuerza.
- `medium`: hay una diferencia de presentacion/nombre, pero no conflicto y la descripcion lo resuelve.
- `low`: insuficiente para aceptar; en ejecucion automatica debe quedar `rejected`.

En la capa historica se aceptaron:

- 65 decisiones de confianza alta.
- 6 decisiones de confianza media por edicion comercial explicita solo en un lado, sin edicion contradictoria.

## Principio de no contaminacion

Si un patron aparece muchas veces y parece seguro, no se mete como decision IA repetida sin mas. Se propone convertirlo en regla determinista conservadora del Pipeline 1 o 2.

Si la decision depende de lectura semantica no formalizada, se queda en ledger.
