# Hierarchical Params Refactor – Implementation Summary

## Executive Summary

- We rewrote the map-closure transformer so generated code keeps the original
  callback bodies and variable names, while maintaining compatibility with the
  existing `mapWithPattern` runtime contract.
- The change substantially improves readability, removes several brittle AST
  rewriting passes, and closes correctness gaps (optional chaining, computed
  keys, identifier collisions).

## Why We Needed This

The earlier transformer renamed callback parameters (`item` → `element`),
flattened captured state into a single object, and rewrote the callback body to
match those new names. That approach worked functionally but left us with:

- Generated code that no longer resembled the source, making reviews and
  debugging harder.
- Symbol-resolution issues in TypeScript because we injected synthetic
  identifiers.
- Edge-case bugs around optional chaining, computed property names, and alias
  collisions (`element`, `_v1`, etc.).

Our goal for this refactor was to eliminate the body rewrite altogether and let
developers read the transformed file as if it were hand-written.

## What Changed

### 1. Capture hierarchy mirrors the source

- We now build a **capture tree** (`groupCapturesByRoot`) that records each
  captured expression by its root (e.g. `state.pricing.discount`).
- The generated schema and runtime params object follow that same shape.
  Example: `{ state: { pricing: { discount: … } } }` instead of
  `{ discount: … }`.

### 2. Destructuring aliases recover original names

- Runtime still delivers `{ element, index, array, params }` to the recipe
  callback.
- We destructure to the developer’s names
  (`({ element: item, params: { state } })`) so the callback body is untouched.
- New helpers normalise identifiers across transformers, ensuring shared
  behaviour when we need fresh names.

### 3. Body rewriting is minimal and safer

- We no longer rename identifiers or replace capture references.
- The only edits we still make are to rebuild destructured element bindings and
  to cache computed property names once per callback (so expressions like
  `{ [nextKey()]: value }` run exactly once).
- Optional chaining is preserved because params are built from the original AST
  rather than reconstructed manually.

### 4. Supporting utilities were aligned

- `capture-tree.ts` now rebuilds access expressions using the original operators
  (optional chaining vs. plain dot access).
- Identifier normalisation is shared across closures, derives, and opaque-ref
  transforms.
- The `derive` transformer was updated alongside closures so its synthesized
  callbacks use the same hierarchical capture helpers and keep destructuring
  intact; a focused regression test guards the collision case we fixed there.
- Regression fixtures were updated manually to document the new structure and to
  add coverage for numeric aliases, computed keys, and collision scenarios.

## Impact & Benefits

- **Readability:** Generated output now mirrors the source; reviewers can reason
  about behaviour without mentally translating renamed variables.
- **Correctness:** Fixes long-standing edge cases (optional chaining, computed
  aliases, captured `element` collisions) and prevents repeated evaluation of
  computed keys.
- **Maintainability:** We removed entire classes of substitution logic, making
  the transformer easier to extend (e.g. upcoming handler-closure support can
  reuse the same helpers).
- **Confidence:** Full `deno task test` passes; targeted regression fixtures
  fail if we revert the business-logic pieces (demonstrated via stash/unstash
  checks during development).

## Trade-offs & Remaining Questions

- **Fixture churn:** Updating fixtures by hand was tedious but gives us a
  high-confidence baseline that future regressions will surface clearly.
- **Runtime contract:** We intentionally kept the existing
  `{ element, index, array, params }` shape to minimise risk. If we ever adjust
  the runtime API we can simplify further, but that is out of scope for now.
- **Future alignment:** Other transformers (e.g. handler closures, `derive`) can
  adopt the same capture-tree utilities so we continue converging on a single
  naming story.

## Recommended Next Steps

1. **Share this summary with stakeholders** so everyone understands the new
   shape and the reasons behind it.
2. **Apply the shared helpers** to upcoming work (handler closures, additional
   built-ins) to avoid drifting naming rules.
3. **Monitor for follow-on cleanups:** once handler closures land, reassess
   whether we can simplify the runtime contract or remove more legacy code
   paths.

With these changes in place the closure transformer is significantly more
predictable, and we have a solid foundation for the remaining roadmap items.
