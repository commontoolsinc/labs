# Recipe Graph Unification Spec

## Summary

Unify builder-time `OpaqueRef` proxies and runtime `Cell` objects into a single
capability-driven cell model. The new model preserves recipe ergonomics
(implicit property access, helpers like `.map`) while producing a concrete
runtime graph with stable cell identifiers that the runtime can persist,
rehydrate, and tear down. Result cells become the canonical owners of graph
metadata, and lifts and handlers gain cause-based identifier stability.

## Goals

- Provide a single cell abstraction with explicit capabilities (`Opaque`,
  `Mutable`, `Readonly`, `Writeonly`) that behaves consistently in builder code
  and at runtime.
- Preserve existing recipe ergonomics—automatic property proxies and helper
  methods—so authored code remains concise.
- Capture a post-instantiation graph snapshot with concrete cell ids so the
  runtime can rehydrate or tear down dynamic graphs.
- Stabilize ids across small edits by deriving causes from input cells plus
  implementation details.

## Non-goals

- Redesigning scheduler semantics beyond the current "ignore self-writes" and
  100-iteration cap.
- Guaranteeing backward compatibility for the existing process cell layout; the
  process cell will be replaced by the graph snapshot stored on the result
  cell.
- Delivering a full type-level capability system across the entire codebase in
  this phase; scope is builder APIs and runtime interfaces.

## Background

### Current builder flow

- `packages/runner/src/builder/recipe.ts` pushes a frame, runs the author’s
  factory immediately, and records every `OpaqueRef` and node it touches.
- Inputs are wrapped in `opaqueRef` proxies so the builder can serialize graphs
  before runtime cells exist.
- `factoryFromRecipe` walks the returned structure, synthesizes paths
  ("argument" and `internal/__#n`), infers defaults, and emits JSON with
  `argumentSchema`, `resultSchema`, `initial`, `result`, and serialized nodes.
  No runtime cell ids exist yet.
- `OpaqueRef` proxies track connected nodes, expose helpers like `.map()`, and
  rely on shadow refs to reuse parent cells without leaking frames.
- `lift` transforms a function into a module factory whose implementation runs
  reactively once live. Handlers wrap functions to produce streams and run once
  per event.

### Runtime instantiation today

- `Runner.setup` ensures each result cell has a paired process cell storing
  `TYPE` (recipe id), `argument`, `internal` state, `resultRef`, and optional
  spell links. Result cells expose generated data plus `source` metadata.
- `setupInternal` merges defaults into the process cell and binds the serialized
  recipe graph via `unwrapOneLevelAndBindtoDoc`; aliases remain path based.
- `startWithTx` iterates serialized nodes, resolves modules, and calls
  `instantiateNode`, turning aliases into real `Cell` instances through
  `sendValueToBinding`. The scheduler maintains reactivity.
- Handlers can emit new recipes; lifts that return recipes spawn fresh graphs
  and register teardown hooks.

## Repository Observations

- `packages/runner/src/builder/opaque-ref.ts` shows how `opaqueRef` proxies
  track connected nodes via `.connect`, compute nested schema metadata with
  `ContextualFlowControl`, and expose helpers such as `.map`. Capability
  wrappers must recreate these affordances against real runtime cells.
- `packages/runner/src/builder/factory.ts` pushes frames before calling the
  author factory. `createCell` expects the frame to provide a `cause` and an
  `unsafe_binding`, so the new wrappers must keep the frame lifecycle intact.
- `packages/runner/src/runner.ts` writes recipe metadata into a process cell
  (`TYPE`, `argument`, `internal`, `resultRef`) and later instantiates nodes by
  unwrapping aliases in `unwrapOneLevelAndBindtoDoc`. Snapshot generation should
  hook into this instantiation path to capture concrete cell ids.
- `packages/runner/src/create-ref.ts` hashes the supplied `cause` and recorded
  structure to derive entity ids. Stable causes therefore hinge on the data we
  pass into frames when new cells are materialized.

## Problem Statement

- Dual abstractions (`OpaqueRef` vs `Cell`) confuse authors and limit helper
  availability.
- Recipes lack persisted runtime graphs, making rehydration and teardown fragile
  for handler-produced or reactive graphs.
- Alias metadata hinges on synthesized paths that shift as recipes evolve.
- Cause assignment for runtime-created cells is ad hoc, so ids change under
  small edits.

## Proposed Design

### Capability-driven cells

- Keep the core `Cell` implementation for runtime internals.
- Introduce capability wrappers (`Mutable`, `Readonly`, `Writeonly`, `Opaque`)
  that proxy `Cell` instances.
- Proxies map property access (`cell.foo`) to `cell.key("foo")` and surface
  helpers. `.map`, `.filter`, etc., appear on array-like cells; unknown schemas
  fall back to property access semantics.
- Invoking proxied helpers (`cell.map(...)`) routes through the proxy so we can
  distinguish reading vs executing members.
- Remove `.setDefault`; rely on schema defaults. Other helpers become available
  wherever semantically valid.
- Rename the combination of opaque refs and literals to `OpaqueValue` so lifts
  can accept cells or plain data uniformly.

### Recipe definition and authorship

- Treat `recipe(...)` as sugar for a `lift` whose inputs default to `Opaque`
  cells. The author’s factory still runs immediately, returning capability-
  wrapped cells instead of opaque refs.
- Property access in recipes continues to use proxy wrappers, so existing code
  (e.g., `items.map(...)`) keeps working.
- Lifts and handlers may accept an optional `cause`. When omitted, the runtime
  derives the cause from input cell ids and a hash of the implementation body.

### Runtime graph instantiation

- Instantiating a recipe produces a concrete graph snapshot with real cell ids,
  capability kinds, aliases, and module bindings.
- The snapshot is stored alongside `value` and `source` metadata on the result
  cell. Documents written by the graph keep `source` pointing back to that
  result cell.
- Snapshot metadata is sufficient to rehydrate handler-generated graphs and to
  tear down dynamic graphs before rebuilding them on change.

### Serialization format

- Define a versioned structure containing `graphVersion`, `cells`, `nodes`, and
  `links`.
  - `cells`: id, capability, cause, schema hash, redirect targets.
  - `nodes`: module reference plus input/output bindings rewritten to concrete
    cell ids.
- Maintain backward compatibility by leaving existing `resultRef`/`source`
  fields untouched and appending a `graph` payload.

### Cause generation

- Default cause: hash of (input cell ids + implementation source).
- Optional `cause` parameter on `lift`, `handler`, and recipe factories
  overrides the default when authors provide stable names.
- Causes feed into cell id derivation to keep ids stable under benign edits.

## Impacted Areas

- Builder APIs (`recipe`, `lift`, `handler`, helper exports).
- Runtime cell creation, alias resolution, and recipe instantiation.
- Serialization (`json-utils.ts`, recipe manager persistence, result metadata).
- Tests and tooling that assume path-based aliases or opaque-ref-only helpers.

## Implementation Plan

1. **Capability wrappers**
   - Implement proxy-based wrappers and surface them from the builder API.
   - Update TypeScript definitions for capability-aware helpers.
2. **Unify builder outputs**
   - Adapt `recipe`/`lift` to emit capability-wrapped cells.
   - Replace `OpaqueRef` internals with compatibility shims or adapters.
3. **Graph snapshot generation**
   - Build runtime graph snapshots during instantiation and store them in result
     cell metadata.
   - Update rehydration/teardown logic to consume the snapshot.
4. **Cause derivation**
   - Implement default hashing and expose explicit overrides.
   - Ensure handler-spawned recipes reuse ids whenever inputs and code are
     unchanged.
5. **Cleanup**
   - Deprecate shadow refs and frame gymnastics once proxies land.
   - Remove `.setDefault`; rely on schema-level defaults.
6. **Testing & documentation**
   - Update builder/runner tests for new helper behavior and metadata.
   - Document capability wrappers and graph metadata for recipe authors.

## Testing Strategy

- Extend recipe and runner tests (e.g., `recipes/todo-list.tsx`) to assert
  capability wrapper behavior, array helpers, and redirect semantics.
- Add instantiation tests that serialize the new graph snapshot and rehydrate
  it, focusing on handler-generated graphs.
- Verify scheduler behavior (ignored self-writes, iteration cap) with the new
  cell model.
- Regression tests for `cellA.set(cellB)` vs `cellA.redirectTo(cellB)`.

## Risks & Mitigations

- **TypeScript proxy typing gaps.** Provide dedicated wrapper types with helper
  availability per schema; fall back to index signatures when needed.
- **Snapshot size/performance.** Start with minimal metadata (ids, capabilities,
  aliases) and profile before expanding.
- **Backward compatibility.** Introduce shims so existing recipes run unchanged
  during migration.

## Open Questions

- How can authors override default helper capability mapping without undermining
  safety guarantees?
- What exact schema/versioning do we use for the graph snapshot payload?

## Next Steps

- Prototype capability wrappers and convert a sample recipe to validate
  ergonomics (see `capability-wrappers.md`).
- Draft and iterate on the graph snapshot schema, then review with
  runtime/storage stakeholders (`graph-snapshot.md`).
- Implement rehydration against the stored graph snapshot and exercise it with
  a sample recipe while observing cause stability (`graph-snapshot.md`,
  `cause-derivation.md`).
- Plan the migration and documentation rollout for existing recipes
  (`rollout-plan.md`).
