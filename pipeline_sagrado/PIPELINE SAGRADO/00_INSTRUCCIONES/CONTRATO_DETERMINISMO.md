# Contrato de determinismo

## Principio

Con el mismo input y los mismos scripts, el resultado debe ser el mismo.

## Capas permitidas

Permitidas en `PIPELINE SAGRADO`:

- Pipeline 1 principal.
- Pipeline 2 rescate por descripcion.

No permitidas:

- Revision IA pura.
- Revision humana no registrada.
- Ledger no determinista.
- Reglas creadas para URLs concretas.

## Estados

El Pipeline 1 puede producir:

- `valid`
- `probable`
- `discarded_low_confidence`
- `ecig_only`
- `vaperalia_only`
- `base_no_match`

El Pipeline 2 debe producir:

- `probable`

Nunca debe producir `valid`.

## Cambios futuros

Si un patron del Pipeline 2 se confirma como regla general, debe convertirse en una regla determinista conservadora dentro del Pipeline 1 o 2.

Si la decision depende de lectura semantica no reproducible, debe vivir fuera de `PIPELINE SAGRADO`.

