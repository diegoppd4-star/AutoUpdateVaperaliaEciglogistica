# Formato del ledger de decisiones

Archivo:

```text
outputs/reviews/description-rescue-decisions.json
```

## Estructura recomendada

```json
{
  "reviewedAt": "2026-05-18T18:03:50.628Z",
  "reviewer": "Codex",
  "basis": "Revision semantica no determinista de candidatos del Pipeline 2.",
  "decisions": [
    {
      "decision": "accept",
      "confidence": "high",
      "ecigProductId": "...",
      "vaperaliaProductId": "...",
      "ecigVariantId": "...",
      "vaperaliaVariantId": "...",
      "reason": "Misma marca, mismo nombre propio, misma capacidad y descripcion compatible.",
      "reviewedFields": [
        {
          "side": "eciglogistica",
          "url": "...",
          "title": "...",
          "brand": "...",
          "reference": "...",
          "variant": "...",
          "descriptionSnippet": "..."
        },
        {
          "side": "vaperalia",
          "url": "...",
          "title": "...",
          "brand": "...",
          "reference": "...",
          "variant": "...",
          "descriptionSnippet": "..."
        }
      ]
    }
  ]
}
```

## Campos minimos por decision

- `decision`
- `confidence`
- `ecigProductId`
- `vaperaliaProductId`
- `ecigVariantId`
- `vaperaliaVariantId`
- `reason`
- `reviewedFields`

## Decisiones validas

- `accepted`
- `rejected`

Los alias `accept` y `reject` se normalizan por compatibilidad, pero el ledger canonico debe escribir `accepted` y `rejected`.

`needs_human` solo puede existir en ledgers historicos o auditorias manuales. El runner automatico con CodexExec no debe emitirlo: si no hay certeza suficiente para aceptar, se escribe `rejected`.

## Reglas de escritura

- Una decision por variante/par real.
- La razon debe mencionar las senales que justifican la decision.
- Si se acepta con confianza media, explicar que falta y por que no es conflicto.
- Si se rechaza, nombrar el conflicto duro concreto.
- No borrar decisiones historicas sin dejar constancia.
