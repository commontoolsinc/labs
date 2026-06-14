# Annotation Primitive — Prototype Implementation Plan (labs-4)

Status: **revised per adversarial review — wish-backed altitude** · Branch:
`proto/annotation-primitive` · PR: commontoolsinc/labs#4132

This document plans a labs-4 prototype of the annotation primitive proposed in
loom **PR #2707** (`docs/development/connectors/annotations-*.md` in the loom
repo). That PR is a *design-doc* PR (eight markdown files, ~4.5k lines, no
implementation). This plan grounds its spec vocabulary in **real labs-4 code**
and lays out a phased build.

> **Revision note (2026-06-14).** v1 of this plan put the reverse index in the
> memory engine (a `link_index` table maintained at the commit boundary) and
> built a Phase-0 spike of it. Three independent adversarial critics converged on
> the same verdict: **that is the wrong altitude for a prototype, and its
> reactive layer (the actually-hard part) is not credible without a cross-layer
> protocol change.** This revision adopts their recommended path — a wish-backed
> library `annotationsOf` that is reactive for free — and demotes the engine
> index to a properly-specified *future optimization*. The full reasoning is in
> §6; the engine spike is preserved as a reference artifact in §5.

---

## 1. What the primitive is

An **annotation** is a statement that one entity is *about* another, attachable
to any target **from the author's own scope without write access to the
target**. The design's single true runtime ask is a **reverse index** — the
ability to answer *"what is attached to X?"* — with a thin pattern-space API on
top.

The author-facing API (latest loom revision, "collapse to ONE verb"):

```ts
// Library convention type
type Annotation<T> = { about: Cell<unknown> | EntityRef; rel?: string } & T;

// Authoring verb — identity is OPTIONAL
annotate<T>(
  target: Cell<unknown> | EntityRef,
  { rel, identity, ...data }: { rel?: string; identity?: unknown[] } & T,
): Cell<Annotation<T>>;

// THE reverse lookup
annotationsOf<T>(
  target: Cell<unknown> | EntityRef,
  schema?: JSONSchema,
): Cell<Annotation<T>[]>;

// Virtual home entries for entities with no document
anchorRef(type: string, naturalKey: object): EntityRef;

// Fold annotations through a resolution policy into a home doc
materialize<T>(target: EntityRef, policy: ResolutionPolicy<T>): Cell<T>;
```

**Identity semantics (critical).** Omit `identity` → **accreting**: each call is
a distinct act (append; two identical comments stay distinct). Provide
`identity` → **converging**: idempotent/toggle-able, keyed by
`(author, target, rel, identity)`. Default-accrete was chosen late in loom
review because the earlier default-converge silently overwrote data (two
comments collapsing into one). Forgetting `identity` should over-accrete
(recoverable), never overwrite (data loss). `identity` is validated to reject
non-deterministic values (timestamps, randoms).

**Invariant that defines the whole primitive:** an annotation is its **own
document** in the author's space; **nothing is ever written into the target.**
(This is why we reject storing annotations as `setMetaRaw` cell-metadata on the
target — that is the write-inversion tax the primitive exists to remove.)

---

## 2. Grounding: loom vocabulary → real labs-4 code

Verified against the working tree. ✅ = exists and is usable as-is;
🔶 = exists but the prototype builds *on top of* it; ❌ = does not exist.

| loom concept | labs-4 reality | status |
| --- | --- | --- |
| reactive discovery of a changing entity set | `wish({ query: "#tag" })` — reads a **concrete materialized index cell** (`…backlinksIndex.mentionable`) and rides the ordinary trigger index; re-runs when that cell is written. `builtins/wish.ts` | ✅ **the reactivity engine for `annotationsOf`** |
| author-space annotation doc + `about` edge | a normal pattern doc with an `about` field (a sigil link or `EntityRef`) and a discovery tag (`#annotation`); existing `annotation.tsx` already does this | ✅ |
| sigil link encoding | `{"/":{"link@1":{id,path,space,scope,schema,overwrite}}}` — `packages/runner/src/sigil-types.ts:16–32`; parse `link-types.ts:191`; resolve `link-resolution.ts:124` | ✅ |
| authorship/provenance on write | `TransformedBy` minted at prepare `cfc/prepare.ts:1340` | ✅ rides annotation writes for free |
| `createRef` for stable/anchor identity | `createRef(value, path)` | ✅ backs `anchorRef` + converging identity |
| reverse index maintained at commit | `scheduler_read_index` exists but is **not** a precedent — it is fed from live scheduler *observations* and is branch-local *because* it tracks ephemeral readers, the opposite of inheritable content (see §6) | ❌ for content; do **not** mirror it |
| per-reader read-time label filtering ("op-views") | **NOT PRESENT** — only egress-time LLM ceilings | ❌ deferred (§4) |
| `linkRole` on a link | added in `sigil-types.ts` this branch; **only needed by the future engine index** (§7), not by the library path | 🔶 forward-compat |

**Architecture decision (revised).** `annotationsOf(target)` is a **`computed`
over `wish({ query: "#annotation" })`** that keeps the candidates whose `about`
resolves to `target`. It reuses wish's existing reactivity wholesale: when a new
annotation doc is authored (and tagged), wish re-runs through the normal trigger
index and the computed re-filters. **Zero engine code.** Its only known weakness
is O(N) candidate scanning per target — a *performance* property a prototype is
allowed to have and should measure before paying engine surface to fix.

---

## 3. Phased build (right altitude — library first)

Each phase ships value and is independently reversible. No foundation
(pace-layer 1) code is touched.

### Phase A — `annotate` + `annotationsOf` (library)
- `annotate(target, { rel, identity?, ...data })` authors an annotation doc in
  the author's space carrying `about` (a link/ref to `target`), `rel`, the data,
  and the discovery tag so `wish` finds it. **No write to target.**
  - accreting (no `identity`) = read-modify-write append against the author's
    **live** per-target list — replay-safe, **never a bare ordinal counter**.
  - converging (`identity`) = stable cause via
    `createRef(author, target, rel, identity)`.
  - identity-determinism guard: reject `Date`/random with a loud error.
- `annotationsOf(target, schema?)` = `computed` filtering
  `wish({ query: "#annotation" })` by resolved `about === target`, schema-
  projected, with `.filter(a => a.rel === …)` ergonomics.
- **Gate:** author two comments on a doc → both appear distinct (accrete);
  a tag toggles (converge); the target document is never mutated (assert no
  revision on the target); the result updates reactively when a new annotation
  is authored.

### Phase B — `anchorRef` + `materialize`
- `anchorRef(type, naturalKey) = createRef({ type, naturalKey }, ["anchor", type])`
  — per-source identity for home-less entities (a phone is *evidence*, not the
  key).
- `materialize(target, policy)` = `computed` fold of `annotationsOf(target)`
  through a resolution policy into a home doc.

### Phase C — migrate two existing patterns
- `packages/patterns/system/backlinks-index.tsx` — delete the write-into-target
  scan; backlinks become `annotationsOf(target)`.
- `packages/patterns/annotation.tsx` — re-express on `annotate` /
  `annotationsOf` (it already discovers via `wish({ query: "#annotation" })`).

### Phase D — docs
- `docs/common/concepts/annotation.md` + glossary entry.

### Phase E — *deferred optimization*: engine-backed index (only if needed)
Pursue **only if** the wish-scan in Phase A demonstrably doesn't scale at demo
size. When pursued, do it the way the runtime wants (see §6): a **concrete
materialized "incoming" cell** written at the commit boundary, so reads ride the
existing concrete-address trigger index — **not** a SQLite side-table plus a
net-new synthetic-subscription protocol. Required correctness checklist before
any such index ships (all are gaps the Phase-0 spike had — §5):
1. **Branch inheritance** — reads must honor `readRowForBranch`-style parent-chain
   inheritance, or be explicitly scoped to `DEFAULT_BRANCH` with a loud comment
   and a test encoding the gap.
2. **Scope identity** — key on the *resolved* `scope_key`
   (`"user:<principal>"`, …) via `resolveScopeKey`, resolving `"inherit"` against
   the source doc's scope_key — never the raw `LinkScope` token.
3. **Freshness** — replace-all-for-source reconcile (delete-all + insert) so
   `seq`/`op_index` are always current; do **not** borrow
   `reconcileSchedulerIndexRows` (its key drops the freshness columns, so
   converging re-sets mutate zero rows).
4. **Edge feed** — prefer carrying role-bearing edges as *commit metadata* (the
   way `schedulerObservation` rides the commit, reusing the `CfcAddress` the
   runner already computes at `link-resolution.ts:46`); keep the document walk
   only as a server-authoritative verifier, and *state* the server-authoritative
   justification.
5. **Link semantics** — index the link's target `path` (sub-path targets), skip
   `overwrite:"redirect"` links, and pre-filter with a cheap `"link@1"` substring
   check before the recursive walk.
6. **Shared tag** — decide deliberately where `"link@1"` lives (memory can't
   import runner; `@commonfabric/api` is a foundation both could depend on) — do
   not silently fork the constant.

---

## 4. Scope cuts (unchanged)

1. **Per-reader read-time label filtering — DEFERRED.** No server-side op-view
   filtering exists. v1: annotation docs carry authorship labels (`TransformedBy`
   at prepare, free); `annotationsOf` does a best-effort label check at the
   read layer. True per-reader server-side filtering is future work.
2. **Cross-space discovery — DEFERRED.** v1 is single-space (the space of the
   target), which covers all migration targets and demos.
3. **Identity stability** — accreting desugars to read-modify-write against the
   live per-target list, sidestepping the loom "stable per-event id" runtime gap.

---

## 5. Reference artifact: the Phase-0 engine spike

Committed on this branch (`feat(memory): annotation primitive — Phase 0
link_index spike`). It adds a `link_index` table to `packages/memory/v2/engine.ts`,
maintained at the commit boundary by walking each materialized revision for
role-bearing sigil links, plus `readIncomingLinks()`. **8 gate tests + the
existing engine suites pass.**

It is retained **only** as proof the commit-boundary mechanism works
mechanically. It is **not** the recommended path, and as a general reverse index
it has two correctness **blockers** and several should-fixes (all enumerated as
the §3 Phase-E checklist): branch inheritance, scope encoding, the borrowed-
reconcile freshness bug, dropped target `path`, redirect links, the post-SELECT
cost gate, speculative cross-space columns, and a gate test that injects sigils
literally (so it does not prove an annotation written *through the runner* lands
a `linkRole` in storage). If Phase E is ever pursued, prefer the concrete-cell
model over reviving this side-table.

---

## 6. Why the altitude changed (the load-bearing reasoning)

- **The hard part is reactive delivery, and the engine path can't do it cheaply.**
  The scheduler trigger index keys only on **concrete** `space/scope/id`
  (`scheduler/keys.ts`, `trigger-index.ts:240`). A committed annotation doc `D`
  never writes its target `X` (that's the point), so the change-notification path
  (`schedulerWriteAddressesForRevisions`, built only from `revision.id`) carries
  `D`'s id and never `X`. A reader watching `X` is never woken. Making the
  SQLite-side-table index reactive would require a **cross-layer change-
  notification protocol extension** (memory-server + runner-storage + scheduler) —
  weeks of work, and exactly the kind of distributed cache-invalidation change
  that breeds subtle missed-update/over-invalidation bugs.
- **`wish()` already solves the analogous problem — without any of that.** It is
  reactive over a changing entity set by reading a *concrete materialized index
  cell* and riding the ordinary trigger index. The grain-following design either
  (a) reuses wish directly (Phase A), or (b) if an index is truly warranted,
  makes that index a *concrete cell written on commit* so reads subscribe through
  the existing mechanism (Phase E). A SQLite side-table is invisible to the
  reactive graph, which is precisely why it would force a parallel invalidation
  path.
- **Risk ordering was inverted.** Phase 0 retired the *easy, certain* risk (walk
  JSON, write rows) in the *least-reversible* layer, while the *uncertain* risk
  (reactive delivery) was deferred. The prototype's actual purpose — validating
  `annotate`/`annotationsOf` ergonomics and deleting the write-inversion hacks —
  sits entirely on top of `annotationsOf` and treats its implementation as a
  black box. So implement the cheap, reversible version first.

---

## 7. Migration targets (why these)

labs' own hand-rolled reimplementations of the primitive, named in the loom
design:
- `system/backlinks-index.tsx` — the marquee anti-pattern: iterates `allPieces`
  and writes a `backlinks` array **into** each target (write-inversion + O(N)
  rescan). Becomes a reverse-index read.
- `annotation.tsx` / `annotation-manager.tsx` — discover via
  `wish({ query: "#annotation" })` and rely on the backlinks hack for reverse
  lookup. The library path subsumes this directly.
- `experimental/folksonomy-aggregator.tsx` — a central collector standing in for
  a missing reverse index (follow-up candidate).
