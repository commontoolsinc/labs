# Capability Types via Branded Types

> **Status:** This design has been **superseded by the branded types approach**
> described in `rollout-plan.md`. We are using TypeScript branded types with
> symbol-based brands rather than runtime proxy wrappers.

## Objectives

- Collapse `OpaqueRef` and runtime `Cell` APIs into a single type system whose
  surface area is gated by explicit capabilities (`Opaque`, `Readonly`,
  `Mutable`, `Writeonly`).
- Use TypeScript's type system (branded types) rather than runtime Proxy objects
  to enforce capability boundaries.
- Keep pattern ergonomics intact by continuing to expose property proxies and
  helpers like `.map()`.
- Provide a migration path that lets existing patterns run during the migration
  window by adapting the current builder implementation incrementally.

## Current Behaviors Informing Design

- `opaqueRef` proxies in `packages/runner/src/builder/opaque-ref.ts` capture
  nested schema information via `ContextualFlowControl` so that child property
  accesses can inherit IFC annotations. They also record connected nodes with
  `.connect` and export builder metadata used by `factoryFromPattern`.
- Builders rely on push/pop frames from `pattern.ts` to keep track of
  `unsafe_binding` context, generated id counters, and the causal object used by
  `createCell` during runtime invocation.
- Runtime cells in `packages/runner/src/cell.ts` already expose read, write,
  redirect, and schema-centric helpers. `createCell` injects causes derived from
  the enclosing frame before delegating to `runtime.getCell`.
- Helper factories such as `.map()` call back into `createNodeFactory` to build
  nested patterns. That indirection means wrappers must cooperate with module
  factories that expect builder-time proxies yet execute against runtime cells.

## Type System Shape (Branded Types Approach)

The actual implementation uses **branded types** rather than runtime Proxy wrappers:

- Create a `CellLike<T>` type with a symbol-based brand where the value is
  `Record<string, boolean>` representing capability flags.
- Factor out interface parts along: reading, writing, `.send` (for stream-like),
  and derives (currently just `.map`).
- Define capability types by combining these factored parts with specific brand
  configurations:
  - `OpaqueRef<T>`: `{ opaque: true, read: false, write: false, stream: false }`
    - Supports: property proxies, `.map`, `.filter`, `.derive`, structural equality
  - `Cell<T>` (Mutable): `{ opaque: false, read: true, write: true, stream: true }`
    - Supports: everything (`.get`, `.set`, `.update`, `.push`, `.redirectTo`, `.send`)
  - `Stream<T>`: `{ opaque: false, read: false, write: false, stream: true }`
    - Supports: `.send` only
  - `ReadonlyCell<T>`: `{ opaque: false, read: true, write: false, stream: false }`
    - Supports: `.get`, `.getAsQueryResult`, schema navigation
  - `WriteonlyCell<T>`: `{ opaque: false, read: false, write: true, stream: false }`
    - Supports: `.set`, `.update`, `.redirectTo` but hides `.get`
- For `OpaqueRef`, keep proxy behavior where each key access returns another
  `OpaqueRef`.
- Simplify most wrap/unwrap types to use `CellLike`.

### Comparison to Original Proxy Design

The branded types approach provides compile-time safety without runtime overhead.
The original proxy-based `CapabilityCell<T, C>` design is **not being implemented**
because TypeScript's type system can enforce the same boundaries more efficiently.

## Construction Flow (Branded Types)

1. Builder entry points (`pattern`, `lift`, `handler`) push a frame and work with
   the unified `CellLike` types instead of separate `opaqueRef` and `Cell` types.
2. Cell creation is deferred - cells can be created without an immediate link,
   using `.for(cause)` to establish the link later.
3. For compatibility during migration, legacy `OpaqueRef` helper affordances
   (`setDefault`, `unsafe_bindToPatternAndPath`) continue working until all call
   sites migrate.
4. During runtime execution, `pushFrameFromCause` seeds the frame with the
   `cause` and `unsafe_binding`. Created cells can call `runtime.getCell` when
   their cause is ready (either automatically derived or explicitly set via
   `.for()`).

## Type System Notes

- Export capability-specific TypeScript types from `@commontools/api`:
  `OpaqueRef<T>`, `Cell<T>`, `ReadonlyCell<T>`, `WriteonlyCell<T>`, and
  `Stream<T>`.
- All types extend a shared `CellLike<T>` base with branded capability flags.
- Extend our JSON Schema annotations so authors can declare capabilities at any
  depth. When `asCell: true` is present, allow an `opaque`, `readonly`, or
  `writeonly` flag (or the closest JSON Schema standard equivalent if one
  exists).
- Provide conditional helper types to map schema metadata to helper surfaces
  (e.g., array helpers only appear when `T` extends `readonly any[]`). Reuse the
  IFC-aware schema lookup utilities to keep helper availability aligned with the
  JSON schema.
- Augment builders so `pattern` factories default to `OpaqueRef` inputs while
  `lift` can declare stronger capabilities for each argument via a typed options
  bag (e.g., `{ inputs: { item: Capability.Mutable } }`).

## Cause Defaults and `.for()` Method

- Cause assignment happens in two layers:
  1. **Automatic derivation**: Default causes are derived from frame context,
     input cell ids, and implementation fingerprints (see `cause-derivation.md`)
  2. **Explicit override via `.for()`**: Authors can call `.for(cause)` to
     explicitly assign a cause before the cell is linked
- The `.for()` method provides an explicit layer on top of automation:
  - Optional second parameter makes it flexible (ignores if link already exists,
    adds extension if cause already exists)
  - Throws if cell already connected to a node or materialized into runtime cell
- Helpers (e.g., `.map`, `.filter`) use automatic derivation by default but can
  be overridden with explicit `cause` parameters to `lift` or `handler`.

## Migration Strategy (In-Place)

This is an **in-place migration** rather than a V1/V2 opt-in system:

- **Step 1**: Unify Cell API types using branded types (see `rollout-plan.md`)
  - Create `CellLike<>` and factor out capability traits
  - Remove `ShadowRef`/`unsafe_` mechanisms
- **Step 2**: Enable deferred cell creation with `.for()` method
  - Change `RegularCell` constructor to make link optional
  - Add `.for()` method for explicit cause assignment
  - Implement automatic cause derivation as baseline
- **Step 3**: Update pattern lifecycle to use deferred execution
  - Run patterns like lifts with tracked cell/cause creation
  - Remove JSON pattern representation
- **Step 4**: Cleanup legacy APIs
  - Remove `setDefault`, `setPreExisting` once defaults come from schemas
  - Deprecate path-based aliasing in favor of graph snapshots (Phase 2)

## Open Questions

- When migrating existing schemas to the new capability annotations, should we
  store capability metadata in-line or factor it into shared schema manifests?
