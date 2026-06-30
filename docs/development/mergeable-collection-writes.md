# Mergeable collection writes (operation-based append, add-unique, increment, remove-by-value)

## The problem

The runtime is local-first and optimistic. A handler write applies to local
state immediately, commits to the server in the background, and is rolled back
("reverted") if the server rejects it. The server rejects a commit when one of
the commit's recorded reads is stale: a revision newer than the read's basis
sequence has touched the same entity (and, for `patch` revisions, an overlapping
path).

`Cell.push` was implemented as a read-modify-write of the whole array. It read
the entire array value, appended the new elements, and handed the whole combined
array to the diff machinery. The commit op was then reconstructed by diffing the
working array against the transaction's base snapshot. This has three
consequences that block scaling under write contention:

1. **Disjoint appends conflict.** Two sessions appending to the same list each
   record a read of the whole array. Whichever commits second has a read whose
   basis predates the first append, so the server rejects it even though the two
   appends touch different tail slots.

2. **Append is O(N).** The commit carries (a reconstruction of) the whole array
   rather than just the appended elements.

3. **Stale-base appends are silently lost or clobber.** During space
   rehydration a handler can run before the list's durable value has
   materialized in that session's replica. `push` then reads the list as empty
   (or shorter than it durably is) and computes its write against that empty
   base. The reconstructed op is either a whole-array `set` (clobbering the
   durable tail) or a positional splice computed against the wrong base; and
   because the recorded read basis can equal the current head, the optimistic
   "retry on conflict" safety net does not always fire. The append is lost
   durably. This is the symptom that motivated the work: with three profiles
   created while the home space is still rehydrating, the durable count of the
   home `profiles` list ends at one. Making the append mergeable is necessary but
   not sufficient to close that particular bug — the *Residual* section at the
   end of this note describes what this change does and does not fix, and the
   evidence for it.

The root cause is that the append's *intent* ("add these elements at the tail,
wherever the durable tail is") is discarded and then reconstructed from a
value diff against a base that may be wrong.

## The approach

Carry the append intent through the transaction so the commit emits a
tail-relative, mergeable operation instead of a reconstructed whole-array diff.

An append commits as a dedicated `append` patch op (`{ op: "append", path,
values }`). On the server this op inserts its elements at the array's *live*
tail, creating the array (and the path to it) if it is absent. Because the
position is resolved on the server against durable state, the op is correct
regardless of what the committing session had loaded locally — empty, short, or
up to date.

An append does not record a conflicting read of the array. The push reads the
array only to build the optimistic local value and to anchor entity ids on new
elements; it does not depend on the existing contents. So the array read is
excluded from the commit's conflict read set. Two appends therefore never
conflict with each other, and an append never conflicts with a concurrent edit
to existing elements. The optimistic write still reverts as a unit if the commit
fails for an unrelated reason.

### Why a dedicated `append` op rather than a positional splice or a `set`

The diff machinery already emits a tail `splice` when the working array is
longer than the base (`buildArrayPatchCandidates`). That positional splice is
not enough on its own: its index is computed against the (possibly stale) base,
so against a stale-short base it inserts in the wrong place, and against an
absent base the op falls back to a whole-array `set` that clobbers. A
tail-relative `append` carries no index — the server appends at the durable tail
— and folds the absent-base case into the same op (create then append) instead
of a clobbering `set`.

A dedicated op kind (rather than a flag on `splice`) cannot represent an invalid
state: it has no vestigial index or remove count that must be ignored or
constrained. It also forces every `switch (op.op)` site — op application, the
conflict-touched-path and scheduler-dirty-path maps, and the client's optimistic
replay — to handle `append` explicitly rather than silently inheriting `splice`'s
behavior, which the type checker enforces. Its touched path is exactly the array
path, the same as `splice`, so reader-invalidation and scheduler-dirty semantics
are unchanged. The set-add and counter-increment ops noted under Scope will be
new op kinds in the same family.

### Why excluding the read is safe

An unconditional append commutes with any other change to the array: with
appends from other writers (each lands at its own tail slot) and with edits to
existing elements (those slots are untouched by an append). So a pure append has
no read dependency on the array, and dropping the array read from the conflict
set loses no necessary safety.

The limitation: an append whose decision depends on the current contents — for
example "append only if the list has fewer than N elements" — is not expressible
as a pure append, because the conditional read is dropped from conflict
detection. Such a write should continue to use a read-modify-write `set`, which
keeps its read in the conflict set. `Cell.push` is unconditional, so it qualifies
for the mergeable path.

## Mechanics

The same machinery carries three mergeable ops. `append` is described below;
`add-unique` and `increment` follow the same shape (see *The op family*).

- **`PatchOp` (`packages/memory/v2.ts`)** — a new `{ op: "append"; path; values }`
  variant. It carries only the array path and the elements to append.

- **`appendAtPath` (`packages/memory/v2/patch.ts`)** — thaws (and creates, if
  missing) the array at `path` and pushes `values` at the tail; `applyPatch`'s
  `append` case calls it. This one place covers both the server's commit-time
  materialization and a peer client replaying the revision. The two engine
  touched-path maps and the client's optimistic-replay path each gain an
  `append` case that returns the array path, the same as `splice`.

- **Transaction (`packages/runner/src/storage/v2-transaction.ts`)** —
  `recordArrayAppend(address, count)` records, per document and path, a mergeable
  intent (`mergeableOps` on the writable entry). At commit:
  - The op builder emits an `append` op for each recorded array path. With a
    base present, only `count` tail elements are the append; with the array
    absent from the base (a fresh or not-yet-loaded entity) the whole working
    array is the append, so a stale-empty base does not drop locally created
    prefix elements such as schema defaults.
  - It suppresses only the diff candidates the append replaces: the whole-array
    op at the append path, and element candidates in the appended tail (index at
    or past the append start). Edits to existing (pre-append) elements and
    unrelated sibling/ancestor candidates are kept, so a transaction that both
    edits an element and pushes keeps both changes.
  - When the base is absent — where the diff would otherwise fall back to a
    clobbering `set` — the append op is emitted instead.
  - `getMergeableOpAddresses()` exposes the recorded addresses so the commit's
    read-set builder can drop the op's incidental reads.

- **Read-set builder (`packages/runner/src/storage/v2.ts`)** — `buildReads`
  drops, on a mergeable-op entity, only the reads the op issues *as part of
  itself*: the read the op's `Cell` method marks as its own (`mergeableOpRead`),
  a read marked as an attempted write, the `["cfc"]` write-policy label, and any
  strict descendant of an op path (the link-resolution sub-reads the write makes
  beneath the value). A handler's *own* explicit `.get()` of the list is not
  marked, so it is kept — which is what makes a conditional push or keyed write
  still conflict-and-retry (see "Danger" below). This is narrower than the
  earlier path-level exclusion, which dropped any read overlapping the array path
  including the handler's. This drop sits alongside the conflict-granularity work
  (`docs/specs/memory-v2/08-conflict-granularity.md`), which separately keeps a
  read marked `excludeReadFromConflict` (an `asCell` reference resolution) out of
  the conflict set; the two exclusions are independent `continue`s in the same
  loop.

- **Engine touched paths (`packages/memory/v2/engine.ts`)** — each op reports its
  array path (like `splice`) in both `touchedPathsForPatch` (which the
  nonRecursive/shape matcher uses, retaining the parent injection) and
  `touchedLeafPathsForPatch` (the leaf-only matcher the conflict check and the
  scheduler reader-dirty index use). Because the ops act on the whole array path,
  not on an element index, they are compatible with the leaf-only matcher's
  invariant — array element insert/remove must reach the engine as an array-path
  op, never an indexed `add`/`remove`/`move` (`assertNoIndexedArrayStructuralOps`
  guards this). So a reader of the list is invalidated by an op, while the op's
  own (dropped) read keeps two ops from conflicting with each other — the
  array-membership analogue of the conflict-granularity fix for distinct-key
  writers to a container.

### The op family

`add-unique`, `increment`, and `remove-by-value` reuse every part of the above —
the intent record, the op-builder, the read-set drop, the engine and
optimistic-replay switch cases — differing only in the op they emit and how it
applies:

- **`add-unique`** (`{ op: "add-unique"; path; values }`, `addUniqueAtPath`) —
  appends each value only if no existing element equals it by stored-value deep
  equality, creating the array if absent. `Cell.addUnique(...)` does the same
  dedup locally (against its possibly-incomplete view) and records the count it
  added; the server re-dedups against durable state. Suppression is identical to
  `append` (the added elements are at the tail). A `Cell` argument dedups by its
  link rather than by value (see below), so re-adding the same entity is a no-op.

- **`increment`** (`{ op: "increment"; path; by }`, `incrementAtPath`) — adds
  `by` (which may be negative) to the number at `path`. A missing value implies a
  zero default: the increment treats it as 0 and creates the path, so a counter
  need not be initialized before its first increment. `Cell.increment(by?)`
  records the summed delta. A zero amount is an error, rejected at
  `Cell.increment` and at the op (so `increment(0)` surfaces a mistake rather
  than committing a no-op); two non-zero increments that sum to zero are a no-op
  the op builder drops, not an error. Suppression drops the scalar replace the
  diff would emit at the value path; the read of the current number is dropped
  from conflict detection, so concurrent increments sum instead of conflicting.

- **`remove-by-value`** (`{ op: "remove-by-value"; path; value }`,
  `removeByValueAtPath`) — removes every element of the array at `path` that
  equals `value` by stored-value deep equality; absent or non-array is a no-op.
  `Cell.removeByValue(ref)` matches by link when `ref` is a `Cell` and by value
  otherwise, filters the matches locally, and records one op per removed element,
  carrying the element's stored representation so the server matches the durable
  element exactly. Because it identifies what to remove by value rather than by
  position, concurrent removes of distinct entries merge instead of clobbering
  through a whole-array rewrite. Suppression drops the whole subtree at the array
  path that the local positional removal produced.

`add-unique` and `remove-by-value` compare by stored-value deep equality. For an
element that is a separate entity, that stored value is a link, so the comparison
is by same-target — identity, not deep content. `Cell.addUnique`/`removeByValue`
accept either a plain value (compared by content) or a `Cell` (compared by its
link); passing the cell returned by `elementById` is how a handler adds or
removes a keyed element by identity (see `keyed-collection-writes.md`). Because a
missing value is a zero default, `increment` is always zero-based: a counter
whose displayed starting value should be non-zero must be `set` to that value
first, since the op carries only the delta.

- **Call sites** — `Cell.push` (`packages/runner/src/cell.ts`) and the
  query-result-proxy's `push` (`packages/runner/src/query-result-proxy.ts`,
  which routes array mutators through `diffAndUpdate`) both call
  `recordArrayAppend` after writing the combined array, so id anchoring,
  cross-space link elements, and CFC write-policy recording continue to run
  through the existing `diffAndUpdate` path unchanged.

## Semantics and limitations

- **Add-wins across whole-entity writes.** Because an append carries no
  conflict-generating read of its entity and the server resolves it at the live
  tail (creating the array if absent), an append merges on top of a concurrent
  whole-entity `set` and is applied even after a `delete` — which recreates the
  list from the appended elements. This is the intended robustness against the
  rehydration race, at the cost of "delete then concurrent stale append"
  resurrecting the list rather than the append being rejected.

- **Append order is server-arrival order.** Concurrent appends from different
  sessions land in the order the server applies their commits, not a globally
  predetermined order. Code must not assume a specific interleaving of
  independently-issued appends.

- **Mixed whole-array reshape.** A transaction that both pushes and reshapes the
  whole array in another way (sort, reverse, splice-out) in the same commit
  emits the append and may drop the whole-array reshape op. Reshapes should be
  committed separately from a push.

## Conditional pushes stay protected: the read-set narrowing

A `push` whose correctness depends on first reading the list — the most common
shape being dedup-then-push,

```ts
// Shown for illustration only.
if (!users.get().some((u) => u.name === name)) users.push(newUser);
```

— is the case the read-set narrowing exists to get right. A naive read-drop that
removed every read whose path overlaps the array would break it: it would drop
the `.some(...)` uniqueness check along with the op's own read, so two clients
adding the same name at the same moment would each read the list without the
other's entry, both pass the check, and both append, with no conflict to force a
retry.

The implemented drop is narrower than that. It removes only the reads the op
*itself* issues — the list value it reads to build the write (marked
`mergeableOpRead`), the link-resolution and element sub-reads strictly beneath
the array path, the query-result proxy's shape-only container read of the array,
and the `["cfc"]` policy label — and keeps a *recursive* read at the array path
that the op did not make, which is the handler's own explicit `.get()`/`.some()`.
So a handler that reads the list and then `push`es still records that read: two
concurrent conditional appends conflict, the loser retries, sees the winner's
entry, and bails, while an unconditional `push` (no explicit read) stays fully
mergeable. This is the narrowing described under the read-set builder above. The
lunch poll's `addUser`
([participant-identity-card.tsx](../../packages/patterns/lunch-poll/participant-identity-card.tsx))
is a deliberate read-then-push that relies on it.

Two further responses make the keyed case cheaper and catch misuse (see
`keyed-collection-writes.md`):

- **Address the membership by identity (implemented).** A uniqueness condition is
  expressible as "add this entity, deduped by its identity": give the element a
  deterministic address with `elementById`, then `addUnique` it. The dedup is by
  link, so concurrent adds of the same key resolve to one entity on the server,
  with no retry — and concurrent adds of *different* keys merge. This replaces the
  read-then-`some()`-then-push shape for the keyed case, avoiding the retry the
  narrowing would otherwise force. Other content-dependent conditions (not a
  uniqueness check — for example "append only if the list has fewer than N
  elements") are not generally mergeable and keep a read-modify-write `set`/`push`,
  which the narrowing above keeps safe.

- **Catch misuse at build time (future).** The transformer's capability analysis
  already tracks per-handler reads and writes; a diagnostic can flag a handler
  that reads a collection and then mergeable-`push`es to it, pointing at the
  identity-addressed `addUnique` or at `set`. Not yet built.

## Scope

Four mergeable ops are implemented: tail append (`Cell.push`), set-add
(`Cell.addUnique`), numeric increment (`Cell.increment`), and remove-by-value
(`Cell.removeByValue`). Together with `elementById` for deterministic element
addressing, these cover the keyed-collection mutations (insert-if-new, set my
value, edit a record's field, delete a record) — see `keyed-collection-writes.md`.
The lunch poll is migrated to them as the worked example. Patterns still using a
read-modify-write `set` for these shapes — a dedup-then-push for a set, a
`set(get() + 1)` for a counter, a `set(filter(...))` to delete — can adopt the
mergeable methods to stop false-conflicting and clobbering under contention; the
favorites, spaces, MRU, and pin lists on the owner-protected home space are the
highest-value remaining candidates.

## Residual: profile-append-during-rehydration is not fully closed by this change

This work was motivated by profile creates being lost when issued while the home
space is rehydrating. The mergeable-append mechanism here is necessary for that
case and fixes the part where a stale or empty base produced a clobbering or
position-wrong op. It is not sufficient on its own.

An end-to-end probe — create one profile, reload, then create two more using only
an idle-wait (no full-sync barrier) between steps, reading a durable count of the
home `profiles` list — still ends at one. Server-side op tracing during that run
shows the home `profiles` entity receiving its initial `set` and exactly one
`append` op (the first, pre-reload create); the two post-reload creates
produce no append revision on that entity at all. A commit that is rejected on a
conflict never reaches the revision-apply path, so the two appends are being
attempted and conflict-rejected (or reverted and not replayed) during the
post-reload churn — not clobbered at the tail. That is a separate failure: an
optimistic event-handler write reverted by an unrelated conflict during
rehydration and never successfully retried (and/or the home rehydration storm
itself), on the cross-space, multi-space commit path. Closing it needs work on
the revert/replay of event-handler writes or on eliminating the rehydration
storm, beyond making the append mergeable.
