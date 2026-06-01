# Cifras de referencia

Estas cifras sirven para auditar reproducibilidad con el scrapeo completo usado el 2026-05-20.

Input usado para comprobacion:

```text
C:\Users\diego\Downloads\output (2).json
```

Ese JSON contenia:

- Eciglogistica: 5.496 filas scrapeadas.
- Eciglogistica: 3.220 productos base preparados.
- Vaperalia: 4.447 filas scrapeadas.
- Vaperalia: 2.358 productos base preparados.

## Pipeline 1 - principal

Resultado esperado de `outputs/general.matches.valid.json`:

```text
baseRows: 3220
baseMatchesKept: 165
baseProductsVisible: 236
validVariants: 657
probableVariants: 3
totalVariantsKept: 660
totalVariantsVisible: 1222
discardedVariantsVisible: 562
ecigOnlyVariants: 203
vaperaliaOnlyVariants: 294
discarded_low_confidence: 65
baseNoMatch: 2984
impossible: 0
```

Esta es la foto del pipeline principal antes de la capa IA/no determinista.

## Pipeline 2 - rescate por descripcion

Con el codigo congelado actual, resultado esperado de `outputs/description-rescue-candidates.matches.valid.json`:

```text
baseRows: 64
validVariants: 0
probableVariants: 81
totalVariantsKept: 81
rescueSourceCounts.base: 51
rescueSourceCounts.variant: 13
```

Nota: una foto anterior del rescate por descripcion tenia 54 productos y 71 probables. La diferencia viene de mejoras deterministas posteriores en rescates de variantes sueltas (`variant_orphan_description_rescue`). No es IA no determinista.

## Capa excluida

La capa `reviewed-rescues` no forma parte de `PIPELINE SAGRADO`.

Esa capa tenia 71 variantes elevadas a validas por revision no determinista/semantica registrada en ledger, pero queda fuera de este paquete.

