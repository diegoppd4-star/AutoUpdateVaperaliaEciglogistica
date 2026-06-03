# Informe de eficiencia: Scraper Ecig

## Resultado ejecutivo

La version `scraper ecig eficiente` mejora la estabilidad y el recall operativo frente al intento refinado sin backfill.

No elimina el scraper anterior. Se entrega como carpeta independiente para poder usarla, auditarla o descartarla sin romper el resto del proceso.

## Problema detectado

El scraper por categorias de Eciglogistica encontro 3233 URLs base actuales, pero el output antiguo tenia 3245 URLs base. Al comprobar las 12 URLs faltantes, todas respondian `HTTP 200` y tenian ficha viva.

Conclusion: no era un problema de enriquecimiento ni de variantes. Era un problema de descubrimiento: Ecig mantenia fichas vivas que no aparecian en los listados de categoria recorridos.

## Cambios aplicados

- Eciglogistica pasa a enriquecimiento no inline.
- Phase 1 mantiene Playwright para categorias.
- Phase 2 usa HTTP + Cheerio.
- Ecig fuerza `phase2Concurrency = 1`.
- Ecig mantiene `delayMs = 600`.
- Ecig activa `failOnListingFailures = true`.
- Ecig activa `failOnEnrichErrors = true`.
- El fetch de detalle falla de forma visible ante `429/403`.
- El crawler acepta `knownProducts`.
- El CLI acepta `--known-urls <json>`.
- Las URLs conocidas se deduplican por URL canonical antes de enriquecerse.

## Comparativa

| Medida | Antiguo | Refinado sin backfill | Refinado con backfill |
|---|---:|---:|---:|
| Filas Ecig | 5533 | 5510 | 5525 |
| URLs base Ecig | 3245 | 3233 | 3245 |
| URLs base faltantes vs antiguo | 0 | 12 | 0 |
| Errores | n/d | 0 | 0 |
| HTTP 429/403 | n/d | 0 | 0 |
| Duracion validada | n/d | n/d | 45.6 min |

## Diferencias restantes

Quedan 13 URLs comunes con distinto numero de variantes/filas. La diferencia neta es -8 filas frente al antiguo.

Estas diferencias no son perdida de producto base:

- hay variantes antiguas que ya no aparecen en la ficha actual;
- hay variantes nuevas que aparecen ahora;
- en algunos casos cambio la referencia visible de la ficha para las mismas variantes.

El detalle completo esta en `comparison-ecig-known-backfill-vs-old.md`.

## Veredicto

Se considera apto como scraper Ecig eficiente para el flujo de actualizacion porque:

- recupera todas las URLs base del output antiguo cuando se usa backfill;
- no devuelve parciales silenciosos ante fallos criticos;
- no uso navegador para enriquecer miles de fichas;
- finalizo sin `429/403`;
- produjo una salida compatible con el pipeline.

Debe ejecutarse con `--known-urls` apuntando a la ultima fuente maestra disponible cuando se quiera evitar perder fichas historicas vivas que Ecig no liste.
