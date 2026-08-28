# Product identity prompt evaluation

This folder freezes the evidence, Sol high ground truth, Luna max evaluations, and winning prompt for the 2026-08-25 product-identity calibration.

## Outcome

`PROMPT_WINNER.txt` scored 22/22 twice in independent `gpt-5.6-luna` runs with `model_reasoning_effort=max`:

- `results/iteration-01.report.json`: 22 passed, 0 failed.
- `results/winner-confirmation.report.json`: 22 passed, 0 failed.

The first candidate prompt passed, so no answer-dependent second prompt was necessary. The confirmation run used the identical prompt and identical fixed evidence.

## Ground truth

The twelve disputed pairs contain six `DIFFERENT` and six `SAME` decisions:

- `DIFFERENT`: five A&L Green Edition products versus their non-Green counterparts.
- `SAME`: IVG Neon Lime and Paradise Lagoon at the exact selected 20 mg / 10 ml variants.
- `DIFFERENT`: original Ursa Nano 800 mAh versus Ursa Nano S3 1600 mAh.
- `SAME`: Ursa V3 pods at 0.8 and 1.0 ohm, and Xros Corex 2.0 pods at 0.8 and 1.2 ohm.

The ten positive controls are deterministic matches with match, base, and variant confidence all equal to 1.0. They cover named editions, longfills, coils, grouped capacities, colours, pods, and concentrated aromas.

Every page was inspected at its exact URL in a real Chromium session. The evaluation input itself comes from the immutable scrape used by run `20260825-120517-matching-from-complete-scrape`, because that is the evidence the production matcher actually receives. Grouped supplier URLs are resolved to one exact selected scrape row before Luna sees them.

## Files

- `PROMPT_WINNER.txt`: frozen winning prompt.
- `pair-specs.json`: URL selections, Sol truth, and human evidence basis.
- `dataset.json`: exact selected scrape rows used by the eval.
- `build-dataset.mjs`: deterministic dataset builder; errors unless every side resolves to exactly one row.
- `output-schema.json`: strict Luna response schema.
- `evaluate.mjs`: invokes Luna max, compares all ids against hidden truth, and writes raw and scored results.
- `prompts/iteration-01.txt`: original prompt candidate, byte-for-byte equivalent in content to the winner.
- `results/*.raw.json`: structured Luna answers.
- `results/*.report.json`: scored comparisons.

## Reproduce

From the repository root:

```bash
node prompt-evals/product-identity-luna-max/build-dataset.mjs
node prompt-evals/product-identity-luna-max/evaluate.mjs \
  prompt-evals/product-identity-luna-max/PROMPT_WINNER.txt \
  manual-confirmation
```

The second command requires configured Codex authentication and network access. It launches Luna in an ephemeral read-only sandbox. It does not access Neon or write to the matching pipeline.

## Scope caveat

Passing 22/22 proves alignment on this fixed calibration set, not universal product-matching correctness. New identity failures should be added as labelled regression pairs before changing the prompt. Keep the ground truth outside the prompt input so evaluation cannot leak answers.
