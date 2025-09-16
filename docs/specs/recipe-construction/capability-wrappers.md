# Capability Wrappers Prototype

## Objectives

- Collapse `OpaqueRef` and runtime `Cell` APIs into a single object whose
  surface area is gated by explicit capabilities (`Opaque`, `Readonly`,
  `Mutable`, `Writeonly`).
- Keep recipe ergonomics intact by continuing to expose property proxies and
  helpers like `.map()` while steering operations through capability-aware
  wrappers.
- Provide a migration path that lets existing recipes run during the migration
  window by adapting the current builder implementation incrementally.

## Current Behaviors Informing Design

- `opaqueRef` proxies in `packages/runner/src/builder/opaque-ref.ts` capture
  nested schema information via `ContextualFlowControl` so that child property
  accesses can inherit IFC annotations. They also record connected nodes with
  `.connect` and export builder metadata used by `factoryFromRecipe`.
- Builders rely on push/pop frames from `recipe.ts` to keep track of
  `unsafe_binding` context, generated id counters, and the causal object used by
  `createCell` during runtime invocation.
- Runtime cells in `packages/runner/src/cell.ts` already expose read, write,
  redirect, and schema-centric helpers. `createCell` injects causes derived from
  the enclosing frame before delegating to `runtime.getCell`.
- Helper factories such as `.map()` call back into `createNodeFactory` to build
  nested recipes. That indirection means wrappers must cooperate with module
  factories that expect builder-time proxies yet execute against runtime cells.

## Wrapper Shape

- Introduce a lightweight `CapabilityCell<T, C extends Capability>` interface
  that wraps a concrete runtime cell and exposes operations allowed by
  capability `C`. Capabilities map to subsets of the current `Cell` API:
  - `Opaque`: property proxies, `.map`, `.filter`, `.derive`, structural
    equality, read-only helpers.
  - `Readonly`: everything in `Opaque` plus `.get`, `.getAsQueryResult`, and
    schema navigation helpers that do not mutate state.
  - `Mutable`: superset of `Readonly` plus `.set`, `.update`, `.push`, and
    `.redirectTo`.
  - `Writeonly`: `.send`, `.set`, `.redirectTo`, but intentionally hides `.get`
    to encourage event-sink authoring disciplines.
- Use `Proxy` objects to intercept property access and method calls. Each proxy
  lazily constructs child proxies with the same capability so nested lookups
  remain ergonomic (e.g. `mutable.todos[0].title.set("…")`).
- When a helper like `.map` is invoked, delegate to a capability-aware shim that
  wraps the callee recipe factory so the inner function receives wrappers
  instead of raw cells or `OpaqueRef`s. Internally reuse the existing
  `createNodeFactory` path to avoid reimplementing module registration.

## Construction Flow

1. Builder entry points (`recipe`, `lift`, `handler`) push a frame, wrap inputs
   in `CapabilityCell` proxies instead of `opaqueRef`, and still record the
   graph using existing traversal utilities.
2. For compatibility, supply adapters that allow legacy `OpaqueRef` helper
   affordances (`setDefault`, `unsafe_bindToRecipeAndPath`) to continue working
   until all call sites migrate. These adapters simply forward to the wrapped
   runtime cell or translate to snapshot metadata updates.
3. During runtime execution, `pushFrameFromCause` already seeds the frame with
   the `cause` and `unsafe_binding`. Wrappers created while executing a lifted
   function can therefore call `runtime.getCell` immediately because the cause
   data is ready.

## Type System Notes

- Export capability-specific TypeScript types from `@commontools/api` such as
  `OpaqueCell<T>`, `ReadonlyCell<T>`, `MutableCell<T>`, and `WriteonlyCell<T>`.
  These extend a shared base that keeps the proxy type information available to
  recipe authors.
- Extend our JSON Schema annotations so authors can declare capabilities at any
  depth. When `asCell: true` is present, allow an `opaque`, `readonly`, or
  `writeonly` flag (or the closest JSON Schema standard equivalent if one
  exists). Builder proxies read these flags to choose the capability for the
  proxy returned by `key()` or nested property access.
- Provide conditional helper types to map schema metadata to helper surfaces
  (e.g., array helpers only appear when `T` extends `readonly any[]`). Reuse the
  IFC-aware schema lookup utilities to keep helper availability aligned with the
  JSON schema.
- Augment builders so `recipe` factories default to `OpaqueCell` inputs while
  `lift` can declare stronger capabilities for each argument via a typed options
  bag (e.g., `{ inputs: { item: Capability.Mutable } }`).

## Cause Defaults

- Capability helpers (e.g., `.map`, `.filter`) should emit deterministic
  default causes that combine the parent cell's cause with a helper-specific
  label. Authors can still pass explicit `cause` overrides to `lift` or
  `handler`, but most call sites inherit stable defaults automatically.
- Expose an optional `.setCause(cause: CauseDescriptor)` chain on newly created
  capability cells. It overrides the derived id before the cell participates in
  the graph. If the cell has already been connected to a node or materialized
  into a runtime cell, `.setCause` must throw to avoid inconsistencies.

## Migration Strategy

- Step 1: Introduce wrappers with shims that forward to existing opaque ref
  behavior. Dual-write metadata (`export()`) so `factoryFromRecipe` can continue
  serializing the graph until the snapshot pipeline lands.
- Step 2: Convert builtin helpers and modules to consume wrappers. Audit
  `packages/runner/src/builder` to replace direct `OpaqueRef` imports with
  wrapper types while keeping `opaqueRef` available as a thin adapter.
- Step 3: Update recipes in `recipes/` iteratively. Provide codemods that swap
  `cell()` usage for capability-specific constructors when explicit mutability is
  required.
- Step 4: Remove legacy-only APIs (`setDefault`, `setPreExisting`) once the
  snapshot work replaces path-based aliasing and defaults come from schemas.

## Open Questions

- When migrating existing schemas to the new capability annotations, should we
  store capability metadata in-line or factor it into shared schema manifests?
