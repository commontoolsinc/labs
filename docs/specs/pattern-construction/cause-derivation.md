# Cause Derivation Plan

## Scope

Causes must be stable for the cells that builder helpers (`lift`, `.map`,
`handler`, etc.) return while assembling a pattern graph. Those helpers execute
inside a frame created by `pushFrameFromCause`, so the frame already carries the
cause of the invocation (e.g., handler event, parent lift). The work here is to
derive deterministic causes for the **new cells** produced inside that frame by
combining the frame cause with deterministic fingerprints of the inputs and
implementation.

## Two-Layer Approach

Cause assignment works in two complementary layers:

1. **Automatic derivation** (this spec): Default causes are automatically derived
   from frame context, input cell ids, and implementation fingerprints
2. **Explicit override via `.for()`**: Authors can call `.for(cause)` on cells to
   explicitly assign a cause, providing an explicit layer on top of the automation

The `.for()` method acts as an escape hatch when automatic derivation isn't
sufficient or when authors want stable, human-readable cause names.

## Frame Cause Setup

1. When a lift or handler is invoked at runtime, the runtime computes a
   structured `frameCause` that captures the triggering context (event id,
   result cell id, handler name, etc.) and pushes it with `pushFrameFromCause`.
2. `createCell` and other builder helpers can read `frame.cause` when they need
   baseline information. The frame cause remains untouched while the author’s
   pattern factory runs.

## Deriving Causes for Builder Outputs

For every helper that returns a cell (including plain `lift`, `handler`,
`.map`, `.filter`, `pattern`, etc.), derive a cause using the following inputs:

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

### Explicit Overrides via `.for()`

- Newly created cells expose `.for(cause, flexible?)` to replace or refine the
  derived cause with an explicit value:
  - **Basic usage**: `.for(cause)` assigns the specified cause
  - **Flexible mode**: `.for(cause, true)` provides flexibility:
    - Ignores the `.for()` if link already exists
    - Adds extension if cause already exists (see tracker in `rollout-plan.md`
      lines 39-46)
  - The override must occur **before** the cell is materialized into a runtime
    cell or connected to a node
  - If the cell has already been connected, the call must throw to avoid
    inconsistencies
- This provides an **explicit layer on top of automatic derivation** - authors
  can use automatic derivation for most cells and only call `.for()` when they
  need specific control.

## Propagating Causes to Nested Frames

- When a helper constructs nested patterns or lifts (e.g., `.map` wrapping a
  callback pattern), push a new frame using the derived cause: `pushFrameFromCause
  (cause, unsafeBinding)`. This ensures nested cells inherit the parent cause
  while still deriving their own causes using the same pattern.
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
  that contributed to the hash. This helps diagnose instability during pattern
  authoring.
- Provide a CLI helper (`deno task inspect-causes`) that runs a pattern, prints
  generated causes, and highlights differences between runs.

## Risks

- **Missing inputs**: Ensure wrappers consistently report input ids even when
  proxies wrap literals. Fall back to a placeholder (e.g., `"literal"`) so the
  hash remains deterministic.
- **Hash collisions**: Use strong hashes (SHA-256) and compress for storage. Keep
  the full hash available for debugging.
- **Performance**: Gathering input ids should reuse dependency tracking already
  performed by the scheduler to avoid extra instrumentation.
