# FUSE Pull-First Reactivity Plan

## Goal

Reduce CPU, scheduler, and tree-churn in the FUSE adapter by shifting from an
eager push model to a pull-first model:

- Keep topology reactive only where necessary.
- Materialize piece data only when a caller actually reads it.
- Avoid rebuilding large `input/` and `result/` trees for changes that no
  current reader needs.

This plan is based on the current implementation in
`packages/fuse/cell-bridge.ts` and `packages/fuse/mod.ts`.

## Current Behavior

Today the adapter does the following:

1. Connects a space and eagerly loads every piece under `pieces/`.
2. Builds each piece tree up front, including `input/` and `result/`.
3. Installs piece-level subscriptions for:
   - `input`
   - `result`
   - `result` again for projected name changes
4. Rebuilds the entire affected subtree on every subscribed change.

This means the main cost is not "one subscription per item". It is closer to
"multiple subscriptions per piece, each capable of causing a recursive subtree
rebuild".

There is already one useful precedent for a pull-oriented approach:

- `entities/` is stubbed first and lazily resolved on lookup.

## Proposed Model

Separate the FUSE view into two concerns:

### 1. Reactive Topology

Things that need push/reactive handling:

- piece created
- piece removed
- piece projected name changed
- possibly source tree changes if pattern source itself is meant to remain live

This is the part that should remain subscription-driven.

### 2. Pull-Based Content

Things that do not need eager subscriptions:

- file contents under `input/`
- file contents under `result/`
- nested object and array structure under a piece
- `[FS]` projection payloads
- VNode-derived `.json` projections

These should be built on demand when a caller performs:

- `lookup`
- `readdir`
- `open`
- `read`
- write-path resolution that needs the subtree to exist

The important change is: "freshness" should come from re-reading, not from
trying to keep the entire in-memory tree continuously synchronized.

## Target Semantics

### Space Level

Keep one live subscription per connected space for the piece list. That remains
the canonical source for:

- `pieces/` directory entries
- `entities/` directory stubs
- `pieces/.index.json`
- `pieces/pieces.json`

### Piece Level

Each piece starts as a lightweight stub under `pieces/`:

- `meta.json`
- `.src/` if we decide source editing should stay eager
- maybe `.handlers` only if cheap to derive
- no eager `input/`
- no eager `result/`

`entities/<id>` should remain a stub-first path as well.

### Hydration

When the kernel first touches a piece subtree, hydrate only the requested
portion:

- accessing `.../input` hydrates `input`
- accessing `.../result` hydrates `result`
- accessing `.../index.md` or `.../index.json` hydrates only the `[FS]`
  projection
- accessing a nested child may hydrate the parent prop subtree first, then
  continue lookup

Hydrated content is a cache, not a source of truth.

### Invalidation

Do not subscribe to piece content by default.

Instead:

- reads fetch or build the latest available content
- writes may optimistically patch the current node buffer for open handles
- cached hydrated subtrees may be evicted after inactivity
- topology changes invalidate affected parent directories and manifests

## Rename Handling

Rename is the main remaining reactive case besides create/remove.

### Canonical Rule

The canonical mapping in `pieces/` should always reflect the latest projected
piece name after reconciliation.

### Compatibility Alias

We should consider a temporary compatibility alias for the old projected name:

- old name resolves to new canonical location
- alias disappears if the old name is later reused by a different piece
- alias should not appear in `pieces.json`
- alias should probably not be treated as canonical for writes or manifests

There are two implementation options:

1. Explicit FUSE symlink node at the old name
2. Internal alias map in lookup logic, without exposing a visible symlink

The alias-map approach is likely safer because:

- it avoids noisy directory listings
- it avoids teaching clients that rename literally means "new symlink object"
- it can expire cleanly when the old name is reused

The explicit symlink approach is still viable if preserving shell-level
discoverability is more important than listing cleanliness.

## Recommended Architecture Changes

### Phase 1: Separate Topology From Content

Refactor `CellBridge` state to distinguish:

- space topology cache
- piece stub metadata
- piece hydration state
- optional alias state for renamed projected names

Add a piece hydration registry, for example:

- whether `input` is hydrated
- whether `result` is hydrated
- last access time
- whether hydration is in progress
- cache generation/version marker

### Phase 2: Stop Eager Piece Content Subscriptions

Change `addPieceToSpace()` so it:

- creates the projected piece directory
- writes `meta.json`
- records controller and manifest state
- does not call `subscribePiece()` for `input` and `result`

Retain only the minimum reactive mechanism needed for:

- piece list changes
- projected piece name changes

This likely means splitting the current `subscribePiece()` into:

- `subscribePieceTopology()`
- `hydratePiecePropOnDemand()`

### Phase 3: Introduce Lazy Hydration for `pieces/`

Add on-demand piece resolution similar to the current `entities/` flow.

In `mod.ts`, before returning `ENOENT` for a missing child under a piece stub,
attempt lazy hydration:

- if parent is a piece dir and child is `input`, `result`, `index.md`,
  `index.json`, `.handlers`, or `.src`
- if parent is inside an unhydrated `input/` or `result/` subtree

This probably needs helpers such as:

- `isPieceDir(ino)`
- `ensurePiecePropHydrated(pieceIno, "input" | "result")`
- `ensureProjectedEntryHydrated(parentIno, childName)`

### Phase 4: Make `readdir` Demand-Driven

Right now `readdir` just enumerates existing children in `FsTree`.

Before listing a directory that is known to be a lazy boundary:

- ensure the relevant subtree is hydrated
- then enumerate children

Important lazy boundaries:

- `pieces/<piece>`
- `pieces/<piece>/input`
- `pieces/<piece>/result`
- `entities/<id>`

### Phase 5: Add Cache Eviction

Once hydration is pull-based, add bounded retention:

- track last access timestamp per hydrated prop
- evict stale `input` / `result` subtrees after a timeout
- never evict while there are open file handles referencing inodes inside that
  subtree

Eviction can be conservative at first. Even manual or size-threshold eviction is
enough to prove the model.

### Phase 6: Revisit Write Semantics

Current writes rely partly on subscription rebuilds to converge the tree after a
cell write.

With fewer subscriptions, write handling should become more explicit:

- update open-handle buffer immediately
- patch or invalidate the relevant hydrated subtree directly
- avoid relying on an asynchronous sink rebuild for correctness

For a first pass, the simplest rule is:

- after a successful write, invalidate the local hydrated prop cache
- the next read re-hydrates from source of truth

That is less fancy than optimistic mutation, but fits the pull-first design
better and is easier to reason about.

## Concrete Code Changes

### `packages/fuse/cell-bridge.ts`

Expected changes:

- split piece topology subscriptions from content hydration
- add lazy hydration entry points
- add piece-dir and prop-dir metadata needed by `mod.ts`
- stop rebuilding subtrees from sink callbacks for ordinary content updates
- preserve `syncPieceList()` as the source of create/remove reconciliation

Likely new internal methods:

- `ensurePieceStub(...)`
- `ensurePiecePropHydrated(...)`
- `ensureEntityHydrated(...)`
- `invalidatePiecePropCache(...)`
- `subscribePieceNameChanges(...)`

### `packages/fuse/mod.ts`

Expected changes:

- in `lookup`, attempt lazy hydration for piece content before failing
- in `readdir`, hydrate lazy directories before enumerating
- in `open` and possibly `read`, ensure the target subtree exists first
- after successful writes, invalidate or patch the relevant hydrated cache

### `packages/fuse/tree.ts`

May need small extensions:

- lightweight node tagging or metadata to identify piece dirs and lazy props
- helper methods for replacing a child subtree without disturbing sibling state
- alias support if we choose old-name compatibility entries

## Rollout Strategy

Recommended order:

1. Preserve current topology sync for piece add/remove.
2. Split rename subscription from content subscriptions.
3. Stop subscribing to `input` and `result`.
4. Add lazy hydration for `pieces/`.
5. Make writes invalidate hydrated caches instead of depending on rebuild sinks.
6. Add eviction.
7. Add optional rename alias behavior.

This order reduces risk because each step can be tested independently and keeps
the biggest semantic change, lazy content loading, narrow and observable.

## Testing Plan

Add tests for:

- `pieces/` tree starts as stubs, not fully materialized content
- first `lookup` of `input` or `result` hydrates exactly that prop
- repeated reads do not duplicate nodes or subscriptions
- write invalidates or patches only the affected prop cache
- piece add/remove still updates `pieces.json`, `.index.json`, and directory
  listing
- projected name changes still reconcile correctly
- old-name alias behavior, if implemented
- entity lazy resolution still works and shares hydration machinery

We should also add instrumentation assertions where practical:

- number of active piece-level subscriptions
- number of hydrated props
- number of rebuilds should drop sharply compared with current behavior

## Open Questions

1. Do we want `pieces/<piece>/.src/` to stay eager, or should source trees also
   become lazy? Yes, for the purpose of grep (if that's needed)
2. Should `.handlers` be derived eagerly from schema metadata, or only when the
   result/input subtree is hydrated? Yes, for the purpose of grep (if that's needed)
3. Do we want old projected names to be visible as symlinks, or only resolvable
   aliases? Symlinks seems more universal but I do not mind.
4. Should `pieces/pieces.json` include canonical paths only, or surface alias
   information separately? Canonical only.
5. Do we want cache eviction to be time-based, size-based, or both? Time based for now.

## Recommendation

The first implementation should aim for the smallest high-value shift:

- keep the space-level piece-list subscription
- keep rename reactivity
- remove ordinary piece content subscriptions
- make `pieces/` content hydrate on demand
- make writes invalidate cached content rather than trigger reactive rebuilds

That gets the core performance benefit without taking on the full alias or
eviction design up front.
