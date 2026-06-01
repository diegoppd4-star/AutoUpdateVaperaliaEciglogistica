# Instrucciones para otra IA

Este paquete se llama `PIPELINE SAGRADO` porque debe tratarse como una referencia congelada y determinista.

## Objetivo

Repetir los dos pipelines deterministas que se construyeron para emparejar productos entre Eciglogistica y Vaperalia.

No usar memoria conversacional. No inventar reglas. No elevar candidatos a validos manualmente.

## Definiciones

### Pipeline 1 - principal

Produce el dataset `general`.

Entrada:

- JSON scrapeado con productos de Eciglogistica y Vaperalia.

Salida principal:

- `outputs/general.matches.valid.json`

Que hace:

1. Separa Eciglogistica y Vaperalia por campo `distributor`.
2. Prepara CSV de bases y variantes.
3. Ejecuta tramos congelados por marca/tipo.
4. Ejecuta auditoria inversa Vaperalia.
5. Contabiliza productos Ecig fuera de tramos.
6. Construye `general`.

### Pipeline 2 - rescate por descripcion

Produce candidatos deterministas sobre sobrantes.

Entrada:

- Salida completa del Pipeline 1.

Salida principal:

- `outputs/description-rescue-candidates.matches.valid.json`
- `outputs/audits/description-rescue-candidates.audit.md`

Regla:

- Todo lo que produce es `probable`.
- No se convierte automaticamente en `valid`.

## Comandos recomendados

Ejecutar Pipeline 1:

```powershell
& ".\PIPELINE SAGRADO\run_pipeline_1_principal.ps1" -InputJson "C:\ruta\output.json"
```

El comando imprimira:

```text
PIPELINE_1_WORKDIR=...
GENERAL_JSON=...
```

Ejecutar Pipeline 2:

```powershell
& ".\PIPELINE SAGRADO\run_pipeline_2_rescate_descripcion.ps1" -Pipeline1WorkDir "C:\ruta\devuelta\por\PIPELINE_1_WORKDIR"
```

## Prohibiciones

- No ejecutar `build-reviewed-rescue-layer.js` como parte de estos pipelines.
- No modificar `description-rescue-candidates` para convertir probables en validos.
- No anadir casos concretos forzados al matcher.
- No usar LLM para decidir matches dentro de esta carpeta.
- No pisar `outputs/` vivos del repo si la tarea es solo auditar reproducibilidad.

## Si los numeros no cuadran

Comprobar en este orden:

1. Que el JSON de entrada sea exactamente el mismo.
2. Que contenga ambas distribuidoras y el campo `distributor`.
3. Que el Pipeline 1 se haya ejecutado en una carpeta limpia.
4. Que no se haya ejecutado la capa no determinista.
5. Que el Pipeline 2 se este comparando como dataset separado, no mezclado en `general`.
