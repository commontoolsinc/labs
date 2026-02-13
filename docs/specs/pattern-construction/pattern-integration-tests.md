# Pattern Integration Test Harness

> **Status:** Test harness implementation is **COMPLETE**. This spec documents
> the design for reference.
>
> **Terminology update:** What we previously called "patterns" are now referred
> to as "patterns." The builder API still exports a `pattern(...)` helper, but
> throughout this document we describe the authored artifacts as patterns.

## Objectives

- Provide end-to-end coverage that exercises patterns (especially in
  `packages/patterns/`) to ensure behavior remains consistent during the
  in-place migration.
- Capture expected behavior as structured fixtures so we can verify outputs
  remain correct throughout the migration process.

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

1. Compile the pattern module.
2. Run the pattern using the current (evolving) implementation:
   - Instantiate the runtime, seed initial state, run the pattern, and evaluate
     assertions
   - For checkpoints with events, emit them sequentially via handler streams and
     re-run assertions after the scheduler settles
3. Report differences clearly (e.g., mismatched values, missing paths).
4. Optionally dump graph snapshots when failures occur to aid debugging.

Note: The harness originally supported V1/V2 dual-mode testing but has been
updated to support the in-place migration approach instead.

## Tooling Considerations

- Implement harness using Deno test runner (`deno task test`) so it integrates
  with existing CI scripts.
- Provide utilities for referencing cells/streams via friendly syntax (e.g.,
  resolve `result.increment` to the correct link automatically using the stored
  snapshot or capability wrappers).
- Allow fixtures to specify tolerance for unordered arrays or partial
  structures when patterns return collections.

## Rollout

- Harness and fixtures are located under `packages/runner/integration/` so
  UI-facing patterns remain focused on front-end rendering scenarios.
- Suite includes high-impact patterns (mirroring those in `packages/patterns/`)
  to validate end-to-end behavior.
- Coverage continues to expand to other workspaces as needed.
- Fixtures remain implementation-agnostic so they can be reused for future
  migrations.
