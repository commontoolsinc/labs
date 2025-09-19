# Pattern Learnings

- Avoid sending `undefined` payloads in scenarios; the harness expects an object
  and may attempt DOM style handling when it receives `undefined`.
- Combining `lift` for sanitizing cells with `derive` for status booleans keeps
  no-op validation logic explicit while avoiding extra handler branches.
- Replacing nested patterns works best by snapshotting cell values with `lift`
  or `derive` before instantiating a new recipe instance; the handler can then
  safely rehydrate the clone while keeping reactive views in sync.
- Re-instantiating child recipes from sanitized parameter lists cleanly resets
  defaults and keeps derived manifests accurate; storing the sanitized manifest
  in a cell ensures parent summaries stay in sync after reconfiguration.
- Batched handler updates land cleanly when every mutable cell is sanitized via
  `lift`; `derive` can safely fall back to the sanitized cell to avoid
  re-running custom defaults.
- Building range-style controls benefits from a single helper that clamps values
  and records history, letting both direct value sets and relative nudges share
  consistent percentage calculations.
- Consolidating multiple reactive slices into a derived summary object works
  smoothly when `lift` normalizes each input first and a separate `derive`
  projects string labels for assertions.
- Building canonical snapshots of nested counters is easier when handlers keep
  raw order intact while derived views sort by normalized keys; recording
  sanitized mutation strings keeps history assertions deterministic.
- Splitting filtered and excluded projections works best when a single `lift`
  sanitizes the source list so both derived slices stay in sync with threshold
  adjustments.
- Using a normalizing `lift` for union-shaped state keeps loading and ready
  branches aligned so handlers only manage transitions while derived views
  remain stable.
- Sanitizing ring buffer capacity with a derived cell lets handlers trim history
  consistently while keeping argument mutations simple.
