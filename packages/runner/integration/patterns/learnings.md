# Pattern Learnings

- Avoid sending `undefined` payloads in scenarios; the harness expects an object
  and may attempt DOM style handling when it receives `undefined`.
- Combining `lift` for sanitizing cells with `derive` for status booleans keeps
  no-op validation logic explicit while avoiding extra handler branches.
