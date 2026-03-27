# Schema Follow-Ups

This file is a revalidated follow-up list for schema semantics and
reviewability. It replaced an older issue dump whose top items no longer
reproduced after the recent schema-hardening passes.

Last revalidated: 2026-03-27

## Resolved / stale items

These were previously tracked here but should no longer drive prioritization:

1. **Reactive array element access falling back to `true`**
   - Current fixture/output no longer reproduces this.
   - `items[index]` now emits `type: ["string", "undefined"]`.
   - Pinned in `test/validation.test.ts` under `Schema Precision Follow-Ups`.

2. **Boolean schema inconsistency based on `true` / `false` literal unions**
   - Current fixture output no longer uses `anyOf` with separate boolean literal
     enums for the cases that originally prompted the note.
   - Current schema-generator behavior normalizes boolean literal unions to
     plain `type: "boolean"` in the relevant paths.
   - Pinned in `test/validation.test.ts` under `Schema Precision Follow-Ups`.

3. **`map-array-length-conditional` skipping `mapWithPattern`**
   - Current fixture output now uses `mapWithPattern`.
   - The older note was stale after the closure / JSX routing cleanup.

## Remaining live questions

### 1. JSX / render-node schema verbosity

Current behavior:

- JSX-producing derives and helper-owned JSX callbacks can emit substantial
  render-node schema payloads or local `$defs` blocks
- this appears semantically correct, but it makes fixture output harder to scan
  and raises reviewability concerns

This is primarily a reviewability/design question, not an immediate correctness
bug.

Questions:

- Do we want to keep emitting the full render-node schema shape inline?
- Should common render-node shapes be canonicalized behind a shared `$ref` or
  helper alias?
- If we keep the current verbosity, should the docs explicitly bless it so
  reviewers do not interpret it as accidental churn?

Recommended next step:

- decide whether render-node result schemas are:
  - accepted as-is,
  - aliased/canonicalized,
  - or intentionally elided in narrow cases

## Notes on retired opacity follow-ups

- CTS no longer emits `asOpaque` in current schema output; this is already the
  stated contract in
  `docs/specs/ts-transformer/ts_transformers_current_behavior_spec.md`.
- The old property-chain leaf note was therefore stale twice over:
  - the leaf value (`.length`) is plain at runtime
  - the legacy `asOpaque` marker is no longer part of current emitted schemas

## Suggested next order

1. Decide whether JSX/render-node schema verbosity needs a canonical aliasing
   pass.
2. Keep converting any newly discovered schema concerns into focused validation
   tests so the queue stays about live issues, not stale fixture memories.
