# Annotation Primitive — Prototype Implementation Plan (labs-4)

Status: **under review — altitude in question** · Branch: `proto/annotation-primitive`

> **⚠️ Adversarial review outcome (2026-06-14).** Three independent critics
> reviewed this plan and the Phase-0 spike. Headline findings (detail in the PR
> description):
>
> - **Altitude is likely wrong for a prototype.** Phase 0 put the reverse index
>   in the memory engine — the hardest, least-reversible layer — to retire the
>   *easy* risk (walk JSON, write rows), while **Phase 2 (reactive delivery) —
>   the genuinely hard part — is not credible as written.** The scheduler
>   trigger index keys only on concrete `space/scope/id`; a committed annotation
>   doc `D` never writes its target `X`, so the change-notification path carries
>   `D`'s id only and a reader watching `X` is never woken. Making
>   `annotationsOf` reactive would require a cross-layer change-notification
>   protocol extension (memory-server + runner-storage + scheduler) this plan
>   does not scope or budget.
> - **`wish()` already solves the analogous problem** (reactive over a changing
>   set of entities) by reading a *concrete materialized index cell* and riding
>   the ordinary trigger index — no synthetic subscription. **Recommended
>   pivot:** build `annotationsOf` as a `computed` over
>   `wish({ query: "#annotation" })` filtered by the `about` target — zero engine
>   code, reactive on day one, exercises every ergonomic question and both
>   migrations. Only if that demonstrably doesn't scale, promote the index to a
>   concrete commit-written cell (the wish model) — never a SQLite side-table
>   plus a net-new synthetic-subscription protocol.
> - **Two correctness blockers in the Phase-0 spike** (were the engine path
>   kept): (1) **branch inheritance** — the reverse read misses every annotation
>   committed on a parent branch before a fork; `scheduler_read_index` is an
>   *anti*-precedent (it is branch-local because it tracks live ephemeral
>   readers, not inheritable content). (2) **scope encoding** — `to_scope` stores
>   the raw `LinkScope` token (`"user"`/`"session"`/`"inherit"`) while a target's
>   real identity is a *resolved* `scope_key` (`"user:<principal>"`, …); they
>   coincide only for `"space"`, so non-space targets silently return nothing.
>   Plus a reconcile bug: borrowing `reconcileSchedulerIndexRows` freezes
>   `seq`/`op_index` on converging re-sets, which would silently defeat the very
>   Phase-2 invalidation the engine path exists to enable.
>
> The Phase-0 engine spike below is retained as a **reference artifact** proving
> the commit-boundary mechanism *works mechanically*, not as the recommended
> path. The §2 claim that `scheduler_read_index` is an "exact precedent" is
> **withdrawn**.

This document plans a labs-4 prototype of the annotation primitive proposed in
loom **PR #2707** (`docs/development/connectors/annotations-*.md` in the loom
repo). That PR is a *design-doc* PR (eight markdown files, ~4.5k lines, no
implementation). This plan grounds its spec vocabulary in **real labs-4 code**
and lays out a phased build.

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

// THE runtime primitive — the reverse index
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

---

## 2. Grounding: loom vocabulary → real labs-4 code

Verified against the working tree. ✅ = exists and is our hook point;
❌ = does not exist, must be built.

| loom concept | labs-4 reality | status |
| --- | --- | --- |
| commit boundary / "prepare boundary" | `applyCommitTransaction()` @ `packages/memory/v2/engine.ts:3091`; after `materializeSnapshots()` @ `:3249` each `revision.document` is fully materialized | ✅ hook point |
| derived index maintained at commit | `scheduler_read_index` / `scheduler_write_index` DDL @ `engine.ts:263–309`, maintained by diff/reconcile `reconcileSchedulerReadRows()` @ `engine.ts:2690`, invoked inside the commit txn | ✅ exact precedent for `link_index` |
| sigil link encoding | `{"/":{"link@1":{id,path,space,scope,schema,overwrite}}}` — `packages/runner/src/sigil-types.ts:16–32`; parse `link-types.ts:191`; resolve `link-resolution.ts:124`. Links are stored **inline** in documents | ✅ exists |
| `linkRole:"about"` keyword | schema keywords parsed in `packages/runner/src/cfc.ts` (`getAsCellValues` `:591–633`); no notion of link *role* | ❌ build |
| `link_index` reverse table | — | ❌ build |
| `LinkReference` atom (both endpoints minted at commit) | not present (loom spec item SC-10) | ❌ synthesized at the index walker |
| per-reader read-time label filtering ("op-views") | **NOT PRESENT** — only egress-time LLM observation ceilings | ❌ large separate effort — **deferred** (see §4) |
| reactive query delivery | scheduler `subscribe()` + trigger index (`packages/runner/src/scheduler/pull-subscriptions.ts:35+`, `trigger-index.ts`); `wish` builtin `builtins/wish.ts:1383+` is tag-based only | ✅ reuse, keyed on target-id |
| authorship/provenance on write | `TransformedBy` minted at prepare `packages/runner/src/cfc/prepare.ts:1340` | ✅ rides annotation writes for free |
| entity identity / scope | `(branch, id, scope_key, seq, op_index)`; space is implicit per-DB; `resolveScopeKey()` @ `engine.ts:46` | ✅ |
| migrations | no versioning; `CREATE TABLE IF NOT EXISTS` + manual `ALTER TABLE` in the INIT string is the convention | ✅ additive DDL is safe |

**Architecture decision (locked).** An annotation is **its own document** in the
author's space whose `about` field is a sigil link tagged `linkRole:"about"` at
the target. The commit walker indexes `from = annotationDoc → to = target
(role=about)`. `annotationsOf(target)` reads `link_index` for **incoming**
about-edges. **Nothing is ever written into the target** — that is the entire
point of the primitive, and the reason we reject storing annotations as
`setMetaRaw` cell-metadata on the target (that is the write-inversion tax the
primitive exists to remove).

---

## 3. Phased build

De-risks the deepest layer first.

### Phase 0 — commit-boundary index spike (highest risk first)
- Add `link_index` DDL to the INIT string near `engine.ts:332`
  (`CREATE TABLE IF NOT EXISTS`, additive; idempotent guards are the
  convention — no migration system exists).
- Columns:
  `(branch, from_id, from_scope_key, from_path JSON, to_space, to_id,
  to_scope, role, seq, op_index, removed_seq)` plus a lookup index on
  `(branch, to_id, to_scope, role)` for incoming-edge queries.
- Add `reconcileLinkRows()` mirroring `reconcileSchedulerReadRows`, called
  immediately after `materializeSnapshots()` @ `engine.ts:3249`, inside the
  same SQLite transaction (atomic with the revision write).
- Walker scans each `revision.document` JSON for sigil `link@1` objects
  (**not** `SourceLink {"/" : string}` — that shape is content-addressed
  source, not a sigil link) and emits rows. Diff/reconcile so updates and
  deletes retract rows (`removed_seq`).
- **Gate:** a runner test commits an annotation doc and reads index rows back.

### Phase 1 — `linkRole` keyword
- Add `linkRole?: string` to `LinkV1Inner` (`sigil-types.ts:16–32`).
- Add a `getLinkRole` accessor alongside `getAsCellValues` in `cfc.ts`.
- Keep `linkRole` on the **stored** sigil during serialization
  (`link-utils.ts:222–287`) — unlike `asCell` (stripped at write), `linkRole`
  is link-semantics, not cell-semantics, so it persists.
- Walker filters to `role === "about"`.

### Phase 2 — reactive reverse read + `annotationsOf` builtin
- Engine query "incoming about-edges to X" (`server.ts` graphQuery analog) +
  runner wiring in `storage/v2.ts`.
- **Key new wiring / main runtime risk:** make `incoming-edges-to(target)` a
  subscribable synthetic address in the trigger index, dirtied whenever
  `reconcileLinkRows` touches a row with `to_id = target`, so subscribed result
  cells update.
- Add `builtins/annotations-of.ts` (modeled on `builtins/wish.ts`), the api
  type in `packages/api/index.ts`, and builder wiring in
  `builder/factory.ts`.
- **Gate:** subscribe to `annotationsOf(target)`, commit an annotation in a
  separate txn, observe the result cell update + schema projection.

### Phase 3 — library verbs
- `annotate(target, { rel, identity?, ...data })`:
  - accreting (no `identity`) = read-modify-write append against the author's
    **live** per-target list — replay-safe, **never a bare ordinal counter**.
  - converging (`identity`) = stable cause from
    `createRef(author, target, rel, identity)`.
  - identity-determinism guard: reject `Date`/random with a loud error.
- `anchorRef(type, naturalKey) = createRef({ type, naturalKey },
  ["anchor", type])`.
- `materialize(target, policy)` = `computed` fold over `annotationsOf`.
- Pattern-level tests: accreting-distinct, converging-idempotent-toggle,
  no-write-to-target invariant.

### Phase 4 — migrate two existing patterns
- `packages/patterns/system/backlinks-index.tsx` — delete the
  write-into-target scan; backlinks become `annotationsOf(target)`.
- `packages/patterns/annotation.tsx` — re-express on `annotate` /
  `annotationsOf`.

### Phase 5 — docs + stress pass
- `docs/common/concepts/annotation.md` + glossary entry.
- Devil's-advocate sub-agent review of robustness / regret-in-6-months / ideal
  UX before presenting.

---

## 4. Scope cuts (decided)

The "full" design leans on two subsystems that **do not exist in labs-4 and are
each large efforts**. Both are **deferred** for the prototype; the reverse-index
core ships without them.

1. **Per-reader read-time label filtering — DEFERRED.** No server-side op-view
   filtering exists today. v1: annotation docs carry authorship labels
   (`TransformedBy` at prepare, free) and `annotationsOf` does a best-effort
   label check at the runner read layer. True per-reader server-side filtering
   is future work (new memory-server machinery).
2. **Cross-space discovery — DEFERRED.** Each space is a separate SQLite DB, so
   `link_index` is naturally per-space. v1: `annotationsOf` finds annotations
   authored in the **same space** as the target — covers all migration targets
   and demos. Cross-space index federation is future work.

Other intentional simplifications:
- **Identity stability** (stable per-event id for accreting replay-safety): the
  loom design names this as a runtime gap. We sidestep it by desugaring
  accreting to read-modify-write against the live per-target list.

---

## 5. Risks

- **Reactive invalidation of the reverse read (Phase 2)** is the principal
  novelty — existing trigger-index subscriptions key on reads of concrete
  addresses; we must dirty a *synthetic* "incoming-edges-to(target)" key from
  the commit-side reconcile. This is the most likely place to get subtle
  missed-update or over-invalidation bugs; it gets a dedicated test matrix.
- **Walker cost at commit.** Walking every committed document for sigil links
  adds commit-path work. Mirror the scheduler index's diff/reconcile so steady
  state is cheap; benchmark before/after on a large commit.
- **Transformer surface.** `linkRole` is set explicitly by the annotation
  library (schema keyword), **not** inferred from TS types, to avoid touching
  `ts-transformers`. Revisit only if ergonomics demand type-inferred roles.

---

## 6. Migration targets (why these)

These are labs' own hand-rolled reimplementations of the primitive, named in the
loom design:
- `system/backlinks-index.tsx` — the marquee anti-pattern: it iterates
  `allPieces` and writes a `backlinks` array **into** each target
  (write-inversion + O(N) rescan). Becomes a reverse-index read.
- `annotation.tsx` / `annotation-manager.tsx` — discover via
  `wish({ query: "#annotation" })` and rely on the backlinks hack for reverse
  lookup.
- `experimental/folksonomy-aggregator.tsx` — a central collector standing in
  for a missing reverse index (out of scope for v1 migration; candidate for a
  follow-up).
