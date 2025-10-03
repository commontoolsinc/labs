# Pattern Learnings

- Avoid sending `undefined` payloads in scenarios; the harness expects an object
  and may attempt DOM style handling when it receives `undefined`.
- Prefer working directly with `lift`; `derive(cell, fn)` is just
  `lift(fn)(cell)`, so staying with the `lift` form keeps code consistent.
- Sanitize cells with `lift` before computing status booleans so validation
  logic stays explicit without extra handler branches.
- Snapshot cell values with `lift` before instantiating a new recipe instance;
  the handler can then safely rehydrate the clone while keeping reactive views
  in sync.
- Re-instantiating child recipes from sanitized parameter lists cleanly resets
  defaults and keeps manifests accurate; storing the sanitized manifest in a
  cell ensures parent summaries stay in sync after reconfiguration.
- Batched handler updates land cleanly when every mutable cell is sanitized via
  a shared `lift`; reuse that sanitized cell as the fallback to avoid re-running
  custom defaults.
- Building range-style controls benefits from a single `lift` helper that clamps
  values and records history, letting both direct value sets and relative nudges
  share consistent percentage calculations.
- Consolidating multiple reactive slices into a summary object works smoothly
  when `lift` normalizes each input first and a follow-up projection maps string
  labels for assertions.
- Building canonical snapshots of nested counters is easier when handlers keep
  raw order intact while the views produced by `lift` sort by normalized keys;
  recording sanitized mutation strings keeps history assertions deterministic.
- Splitting filtered and excluded projections works best when a single `lift`
  sanitizes the source list so both derived slices stay in sync with threshold
  adjustments.
- Using a normalizing `lift` for union-shaped state keeps loading and ready
  branches aligned so handlers only manage transitions while views remain
  stable.
- Sanitizing ring buffer capacity with a cell produced by `lift` lets handlers
  trim history consistently while keeping argument mutations simple.
- Capturing removal metadata in a dedicated cell makes it easy to restore child
  recipes with the same identifier while keeping summary cells deterministic.
- Recipes compose well: treat child recipes as reusable components so shared
  behaviors stay centralized and scenarios stay focused on wiring.
- Sanitizing session arrays with a single `lift` before deriving grouped
  summaries keeps tag and weekday aggregations deterministic while a dedicated
  cell for the latest entry simplifies scenario assertions.
- Keeping grouped counters as an append-only log and deriving totals with
  `lift`/`derive` keeps the handler simple while still exposing stable views for
  assertions and labels.
- Allowing a single `lift` to drive both derived summaries and a `createCell`
  snapshot makes it easy to expose aggregate risk data while keeping handlers
  focused on mutations.
- Keeping a cached summary cell and returning it when sanitized inputs match
  avoids unnecessary object churn, while an auxiliary memo cell can expose
  reference stability for harness assertions.
- Parent handlers can bubble events by capturing the child's handler stream and
  calling `send` directly; a small helper keeps the stream cast typed when
  wiring parent and child recipes.
- Keeping `ifElse` branches shaped identically makes it easy to map nested
  fields with `lift`, letting assertions target branch-specific details without
  extra schema helpers.
- Sequencing multiple events in one scenario step stays predictable when a
  `start` handler resets sanitized cells before subsequent `apply` handlers run;
  batch events in the harness will progress in order, so resetting step logs
  keeps derived counts aligned with the scenario's expectations.
- Enumerations stay deterministic when a `lift` normalizes the state cell and
  handlers gate mutations; logging each transition via `createCell` yields
  stable audit trails for the harness assertions.
- Chaining multiple `lift` transforms works reliably when each stage normalizes
  its input first; downstream derived cells like parity flags only need to
  reason about the sanitized shape from the previous lift.
- Rebuilding grouped summaries inside a `derive` call keeps thread ordering
  predictable when each update returns a fresh array sorted by latest
  timestamps; logging activity via a local `cell` offers an easy assertion
  surface without adding extra derived dependencies.
- Updating a `createCell` snapshot from the same `lift` that sanitizes metrics
  keeps aggregated analytics accessible for assertions while the handler stays
  focused on mutation.
- Normalizing stage probabilities with `clampProbability` allows forecast sums
  to remain stable even as handlers mutate both deal values and stage config.

- Aggregating shopping lists from sanitized plan entries stays stable when
  handlers normalize day and meal slots before updating the plan, letting
  derived sums run on predictable structures.
- Using a `lift`-produced metadata record alongside a typed handler map keeps
  event routing ergonomic while giving the harness deterministic surfaces for
  assertions like call counts and labels.
