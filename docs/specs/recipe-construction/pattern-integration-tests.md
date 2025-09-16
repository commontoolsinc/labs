# Pattern Integration Test Harness

> **Terminology update:** What we previously called “recipes” are now referred
> to as “patterns.” The builder API still exports a `recipe(...)` helper, but
> throughout this document we describe the authored artifacts as patterns.

## Objectives

- Provide end-to-end coverage that exercises recipes (especially in
  `packages/patterns/`) under both the legacy (V1) and new (V2) builder/runtime
  pipelines.
- Capture expected behavior as structured fixtures so we can compare outputs
  before and after the V2 migration without rewriting tests.

## Test Artifact Structure

Each pattern test case consists of:

- **Pattern module**: A `.tsx` or `.ts` file exporting a pattern, lift, or
  handler.
- **Fixture file** (proposed `.pattern.test.json` or `.pattern.test.ts`):
  - `arguments`: Optional initial argument payload (JSON) passed to the pattern.
  - `initialState`: Optional set of documents/cells to seed before running.
  - `assertions`: Array of checkpoints. Each checkpoint contains:
    - `expect`: A list of `{ path: string, value: JSONValue }` assertions on the
      result cell (paths use dot/bracket notation or JSON pointers).
    - `events`: Optional array of events to dispatch before the next checkpoint.
      Each event is `{ stream: string, payload: JSONValue }`, where `stream` is a
      cell link/path within the result graph.
- **Optional snapshot**: For debugging we can persist the generated graph
  snapshot and compare it between runs. Assertions stay selective to avoid
  brittle fixtures.

Example fixture snippet:

```json
{
  "arguments": { "initialCount": 1 },
  "assertions": [
    { "expect": [{ "path": "result.count", "value": 1 }] },
    {
      "events": [{ "stream": "result.increment", "payload": {} }],
      "expect": [{ "path": "result.count", "value": 2 }]
    }
  ]
}
```

## Harness Execution Flow

1. Compile the pattern module (shared pipeline for V1 and V2).
2. Run the pattern twice per fixture:
   - **V1 mode**: Use current `recipe`/`lift`/`handler` exports.
   - **V2 mode**: Swap in `recipeV2`/`liftV2`/`handlerV2` and new runtime paths.
3. For each mode:
   - Instantiate the runtime, seed initial state, run the pattern, and evaluate
     assertions.
   - For checkpoints with events, emit them sequentially via handler streams and
     re-run assertions after the scheduler settles.
4. Report differences clearly (e.g., mismatched values, missing paths).
5. Optionally dump V1 vs V2 graph snapshots when failures occur to aid debugging.

## Tooling Considerations

- Implement harness using Deno test runner (`deno task test`) so it integrates
  with existing CI scripts.
- Provide utilities for referencing cells/streams via friendly syntax (e.g.,
  resolve `result.increment` to the correct link automatically using the stored
  snapshot or capability wrappers).
- Allow fixtures to specify tolerance for unordered arrays or partial
  structures when patterns return collections.

## Rollout

- Add the harness and fixtures under `packages/runner/integration/` so
  UI-facing patterns remain focused on front-end rendering scenarios.
- Seed the suite with high-impact patterns (mirroring those in
  `packages/patterns/`) to validate end-to-end behavior.
- Expand coverage to other workspaces once the harness stabilizes.
- Keep fixtures mode-agnostic so future migrations (beyond V2) can reuse the
  same tests.
