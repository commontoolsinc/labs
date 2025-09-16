# Cause Derivation Plan

## Scope

Causes must be stable for the cells that builder helpers (`lift`, `.map`,
`handler`, etc.) return while assembling a recipe graph. Those helpers execute
inside a frame created by `pushFrameFromCause`, so the frame already carries the
cause of the invocation (e.g., handler event, parent lift). The work here is to
derive deterministic causes for the **new cells** produced inside that frame by
combining the frame cause with deterministic fingerprints of the inputs and
implementation.

## Frame Cause Setup

1. When a lift or handler is invoked at runtime, the runtime computes a
   structured `frameCause` that captures the triggering context (event id,
   result cell id, handler name, etc.) and pushes it with `pushFrameFromCause`.
2. `createCell` and other builder helpers can read `frame.cause` when they need
   baseline information. The frame cause remains untouched while the author’s
   recipe factory runs.

## Deriving Causes for Builder Outputs

For every helper that returns a cell (including plain `lift`, `handler`,
`.map`, `.filter`, `recipe`, etc.), derive a cause using the following inputs:

- **Frame cause**: Treat the `frameCause` as the parent component. It ensures
  all descendants remain tied to the invocation that spawned them.
- **Input cell ids**: Gather the normalized ids of the input cells passed to the
  helper. For `.map`, include the list/array cell id plus ids of captured cells
  in the callback. Wrappers expose `cell.__metadata.cause` or similar to make the
  ids available without forcing a read.
- **Implementation fingerprint**: Hash the helper’s implementation. For inline
  functions reuse the hash already stored in the function cache. For `ref`
  modules or builtins use their canonical identifier.
- **Helper discriminator**: Include a stable label describing the helper and its
  position (e.g., `"lift"`, `"map"`, `"handler"`). If a helper can be invoked
  multiple times within the same frame (like `.map`), add an index or property
  path to disambiguate siblings.
- **Literal/configuration inputs**: Serialize options or literal data that alter
  behavior (e.g., `.map({ chunkSize: 10 })`).

Combine these pieces into a structured object and feed it to `createRef`:

```ts
const cause = createRef({
  parent: frameCause,
  helper: "lift",
  impl: implementationHash,
  inputs: inputIds.sort(),
  index: helperIndex,
  config: stableConfigJson,
});
```

The resulting entity id seeds the cause for the cell returned by the helper.

### Explicit Overrides

- Newly created capability cells expose `.setCause(cause: CauseDescriptor)` to
  replace the derived cause with an explicit value (useful for hand-authored
  stability keys). The override must occur **before** the cell participates in
  the graph. If the cell has been connected to a node, read, or written, the
  call must throw so we do not retroactively change ids that other nodes may
  already reference.

## Propagating Causes to Nested Frames

- When a helper constructs nested recipes or lifts (e.g., `.map` wrapping a
  callback recipe), push a new frame using the derived cause: `pushFrameFromCause
  (cause, unsafeBinding)`. This ensures nested cells inherit the parent cause
  while still deriving their own causes using the same recipe.
- `createCell` inside the nested frame now starts its `generatedIdCounter` from
  a hash of `{ parent: cause, path: currentPath }` so sibling inserts don’t
  shift identifiers.

## Integration Points

- Update capability wrappers so every helper funnels through a single
  `deriveCause` utility before calling `runtime.getCell`.
- Extend `pushFrameFromCause` to accept structured causes (with optional
  metadata) and make `createCell` resilient to both legacy and structured
  inputs.
- Ensure `.setCause` checks with the builder runtime whether the cell has been
  connected or materialized; reject overrides when unsafe.
- Persist the derived cause string in the graph snapshot so consecutive runs can
  detect churn.

## Tooling and Instrumentation

- Log derived causes when `RuntimeOptions.debug` is enabled, including the inputs
  that contributed to the hash. This helps diagnose instability during recipe
  authoring.
- Provide a CLI helper (`deno task inspect-causes`) that runs a recipe, prints
  generated causes, and highlights differences between runs.

## Risks

- **Missing inputs**: Ensure wrappers consistently report input ids even when
  proxies wrap literals. Fall back to a placeholder (e.g., `"literal"`) so the
  hash remains deterministic.
- **Hash collisions**: Use strong hashes (SHA-256) and compress for storage. Keep
  the full hash available for debugging.
- **Performance**: Gathering input ids should reuse dependency tracking already
  performed by the scheduler to avoid extra instrumentation.
