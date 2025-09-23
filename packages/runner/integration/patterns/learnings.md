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
- Use `createCell` only when the new cell stays in the returned graph (or feeds
  another node); for diagnostic summaries, reuse existing cells or allocate with
  `cell()` so we are not leaving orphaned documents behind.
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
  handlers gate mutations; append transitions to an existing history cell
  instead of minting extra `createCell` snapshots.
- Chaining multiple `lift` transforms works reliably when each stage normalizes
  its input first; downstream derived cells like parity flags only need to
  reason about the sanitized shape from the previous lift.
- Rebuilding grouped summaries inside a `derive` call keeps thread ordering
  predictable when each update returns a fresh array sorted by latest
  timestamps; logging activity via a local `cell` offers an easy assertion
  surface without adding extra derived dependencies.
- Keep aggregated analytics in the same cells you return so assertions observe
  the live reactive data, without duplicating it through `createCell`.
- Normalizing stage probabilities with `clampProbability` allows forecast sums
  to remain stable even as handlers mutate both deal values and stage config.
- Cloning sanitized cards before exposing them keeps derived template lists
  stable when filters swap; handlers only adjust the category cell, while
  downstream assertions compare fresh objects and avoid reference sharing.
- Recording a difference snapshot after every handler run still benefits from
  reusing sanitized step cells; keep those references in the result graph rather
  than mirroring them via `createCell`.
- Tracking direction toggles with a history cell while deriving the sorted view
  from sanitized arrays keeps sort mode reactive; the history cell alone is
  sufficient for assertions.
- Passing a structured object of cells into `lift` let me sanitize placements
  with the latest bin definitions so the relocation handler could stay focused
  on enforcing capacity without duplicating normalization logic.
- Reusing the same timeline builder inside handlers keeps change logs aligned
  with derived journey views while anchor sanitization prevents schedule drift.

- Aggregating shopping lists from sanitized plan entries stays stable when
  handlers normalize day and meal slots before updating the plan, letting
  derived sums run on predictable structures.
- Using a `lift`-produced metadata record alongside a typed handler map keeps
  event routing ergonomic while giving the harness deterministic surfaces for
  assertions like call counts and labels.
- Sanitizing alternate argument presets with a shared `lift` before selecting a
  new default keeps reinitialization deterministic; track flips in the same cell
  collection you expose rather than spawning extra snapshot cells.
- Maintaining sanitized channel preference lists lets derived schedule maps
  react predictably to frequency updates while a single summary `lift` keeps
  textual expectations aligned with handler-driven mutations.
- Swapping derive pipelines by storing the active function in a lift-produced
  cell keeps downstream mapped values stable; log mode changes in the shared
  history cell that scenarios already inspect.
- Normalizing token catalogs with `lift` before exposing derived colors keeps
  handler logic simple; trimming candidate token names inside the handler makes
  it easy to accept user-provided overrides without leaking invalid state.
- Building grouped bibliographies worked best when the raw argument cell was
  sanitized upfront; using `lift` with `toSchema` kept the grouped by-topic and
  by-style projections deterministic so scenario assertions stayed stable.
- Letting a derived summary enforce budget totals while handlers clamp incoming
  requests keeps allocations balanced; assertions can read from the returned
  summary/history cells without duplicating them through `createCell` logs.
