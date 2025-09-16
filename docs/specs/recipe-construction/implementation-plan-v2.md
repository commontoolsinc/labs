# Implementation Plan (V2 Opt-In)

## Phase 0: Integration Test Harness

- Build a recipe integration harness that can run `.tsx` recipes from
  `packages/patterns/` (and other sample directories) inside the runtime.
- Allow tests to declare:
  - Initial arguments/documents (by path or schema-aware fixtures).
  - Expected result snapshots (selective path assertions to keep fixtures small).
  - Event sequences: each entry specifies the stream cell path to emit on and
    the event payload, followed by updated expectations.
- Run the harness against the current implementation to produce a baseline
  digest. These tests must be shared between V1 and V2 so behavior stays aligned.

## Phase 1: Introduce V2 Entry Points

- Add `recipeV2`, `liftV2`, and `handlerV2` exports (plus builder re-exports via
  `createBuilder`) that immediately expose capability wrappers and the deferred
  execution lifecycle.
- Keep existing `recipe`/`lift`/`handler` untouched; they continue invoking the
  factory eagerly and serializing legacy metadata.
- Wire the integration test harness to run each scenario twice: once under V1
  entry points, once under V2.

## Phase 2: Runtime Support Behind Opt-In

- Teach the runtime to detect V2 recipes via metadata stored on result cells and
  execute the new pipeline:
  - Generate the node-only graph snapshot (`graph`, `pattern`, `generation`).
  - Use capability wrappers for runtime instantiation instead of `OpaqueRef`.
  - Apply deterministic causes and respect `.setCause`.
- Ensure V2 code paths can coexist with legacy metadata so the runtime can run
  both versions simultaneously.

## Phase 3: Serializable Node Factories

- Implement the `nodeFactory@1` sigil, `.curry`, and automatic deserialization
  for V2 factories. Legacy V1 factories continue using current serialization.
- Extend the integration harness to assert that serialized factories round-trip
  correctly when returned from recipes or passed through cells/events.

## Phase 4: Migration & Parity

- Incrementally migrate internal recipes to `recipeV2`/`liftV2` once tests pass.
- Keep running the dual-mode integration suite to confirm V1 and V2 stay in
  sync. Fix divergences in V2 before moving additional recipes.
- Provide documentation and codemods to ease recipe author migration.

## Phase 5: Flip Default

- After V2 covers all production-like scenarios, alias the default exports to
  the V2 implementations (`recipe = recipeV2`, etc.).
- Remove V1-only code paths, including `OpaqueRef`, `TYPE`, and legacy aliasing.
- Retain the integration tests as regression coverage for the unified system.
