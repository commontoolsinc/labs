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
