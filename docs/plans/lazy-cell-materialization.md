# Lazy, schema-observing cell materialization

Status: Stage 1 complete; Stage 2 next

`Cell.get()` materializes everything its schema selects, in one pass, before the
reader touches any of it. A lift declaring a list of a thousand entries gets a
thousand entries built, link-resolved, defaulted, back-to-cell annotated and
registered as reactive dependencies — even when its body reads `list.length` and
returns.

This plan makes that materialization lazy. A reader gets a proxy that resolves
each path when it is touched, narrowing the schema as it descends and refusing
the read when the data no longer matches. A transaction can be flipped into a
mode where every cell read hands back such a proxy; the runner flips it for the
transaction that runs a lift, and treats a schema refusal exactly as it treats
an argument that did not resolve.

## Status convention

- [ ] Not started
- [x] Complete and verified

Mark a parent checkbox complete only after all of its child checks pass. Keep
this plan updated in the same commits as the implementation. When the final
stage lands, archive it under `docs/history/plans/` following
[`../README.md`](../README.md).

## What the runtime does today

Four mechanisms carry the current behavior. The design below reuses all four.

**Eager, schema-driven materialization.** `Cell.get()`
([`cell.ts`](../../packages/runner/src/cell.ts)) calls `validateAndTransform`
([`schema.ts`](../../packages/runner/src/schema.ts)), which reads the whole
document value in one shot and hands it to `SchemaObjectTraverser`
([`traverse.ts`](../../packages/runner/src/traverse.ts)). The traverser walks
the _data's_ own properties and, for each one, narrows the schema by that key.
Properties the schema does not select are skipped without descent, via the
`emptyProperties` / `missingProperty` marker schemas that make
`TransformObjectCreator.addOptionalProperty` a no-op. So schema-on-read already
prunes. What it does not do is defer: everything the schema _does_ select is
built.

**A schema-less lazy proxy.** `createQueryResultProxy`
([`query-result-proxy.ts`](../../packages/runner/src/query-result-proxy.ts)) is
the existing lazy view. It resolves links per access, records container reads as
non-recursive shape reads (`SHAPE_READ`) and value reads as recursive, wraps
array methods, and exposes `toCell`. It is reached from two places:
`Cell.getAsQueryResult()`, and `validateAndTransform` itself — at the root and
again per subtree, in `TransformObjectCreator.createObject` — whenever the
effective schema is absent or `true`. It observes no schema, so it cannot apply
defaults, cannot mint `Cell`s for `asCell` fields, and cannot tell a reader that
the data has stopped matching.

**Schema narrowing already exists.** `ContextualFlowControl.schemaAtPath`
([`cfc.ts`](../../packages/runner/src/cfc.ts)) narrows a schema by a path,
resolves `$ref`, unions `anyOf` / `oneOf` branches, and caches per interned
schema. `canBranchMatch`, in `traverse.ts`, is a shallow branch prefilter — type
check plus required-key presence, no descent. Together these are the narrowing
primitive a lazy proxy needs.

**The "argument did not resolve" path.** `readJavaScriptArgument`
([`runner.ts`](../../packages/runner/src/runner.ts)) computes `isValidArgument`
as `argument !== undefined`. When it is false the action skips the body, writes
an undefined result through the ordinary result path, and logs at info level —
the run is a non-event, not a failure. This is the disposition a schema refusal
should reuse.

Two boundaries worth naming because they bound the win:

- **Loading is unaffected.** The query selector that decides which documents the
  server ships is the cell's own schema, taken in `syncCell`
  ([`v2.ts`](../../packages/runner/src/storage/v2.ts)), independent of `.get()`.
  Laziness saves local traversal, allocation, freezing, and reactive read
  registration. It does not, by itself, save network. Narrowing the sync
  selector to what a reader touches is a separate, later piece of work.
- **Lifts run in-process.** `invokeJavaScriptImplementation` calls
  `fn(argument)` directly, with no serialization boundary, so a proxy reaches
  the body intact.

## The model

A **lazy view** is a proxy over a `(link, schema)` pair. Creating one costs a
single non-recursive read of the container at `link`. Reading a property `p`:

1. Narrows the schema: `schemaAtPath(schema, [p])`, with the same
   `emptyProperties` / `missingProperty` markers the traverser uses, so a
   property the schema does not select is absent from the view rather than
   present and raw.
2. Resolves links at the child path, combining the link's own schema into the
   narrowed one, exactly as `validateAndTransform` does.
3. Dispatches on the narrowed schema: `asCell` / `asStream` mints a `Cell`; an
   absent or `true` schema hands back today's schema-less query-result proxy; a
   scalar returns the value; a container returns another lazy view.
4. Applies the schema `default` when the slot is absent.
5. Registers the read on the transaction before returning — including the read
   that fails.

Point 5 is load-bearing and not incidental. A refusal must leave behind the
dependency that will re-trigger the reader when the missing data arrives. The
existing read path already records the activity before it inspects the value
([`v2-transaction.ts`](../../packages/runner/src/storage/v2-transaction.ts)), so
a read of an absent path registers; the lazy view must make sure it issues that
read rather than short-circuiting on the container's key set.

### What the view promises

**Root guard, then touch-scoped.** At materialization the view validates the
root container only: its type, the presence of its `required` keys, and the
immediate JSON type of each required key where the schema states a scalar type.
That is one non-recursive shape read — the read the view takes anyway. If the
root guard fails, `.get()` returns `undefined`, exactly as today, and the
runner's existing `isValidArgument` gate handles it with no new machinery.

Below the root, every check happens where the reader touches. Reading a
container validates that container's `required` keys; reading a leaf validates
its type; reading a property the schema excludes yields `undefined`.

State the delta plainly, because it is the one behavior change a pattern author
can observe: **a mismatch in a subtree the reader never touches no longer stops
the reader.** Today a broken field five levels down collapses the whole argument
and the lift does not run. Under this contract the lift runs, because nothing
ever asked. This is the deliberate cost of not materializing what nobody wants.
It is bounded in the direction that matters — a reader that touches broken data
still refuses — and it removes a class of whole-argument collapses caused by
data the reader had no interest in.

**`anyOf` resolves at the point of access.** When the narrowed schema at a path
is a union, the view reads the value at that path non-recursively and filters
branches with `canBranchMatch`. One surviving branch narrows to it; several
merge their property schemas the way `mergeAnyOfBranchSchemas` already does;
none is a refusal. The prefilter is shallow by construction, so this stays a
container-shaped read, not a descent.

### Snapshot semantics

A lazy view reads the state as of the `.get()` that created it, not the live
transaction state. A reader that materializes a list and then writes into it
iterates what it was handed, which is what eager materialization gives today.

This is close to free, for a reason that falls out of how writes work. A write
descends through `cloneForMutation` with `force: false`
([`mutable-path-write.ts`](../../packages/runner/src/storage/transaction/mutable-path-write.ts),
[`value-clone.ts`](../../packages/data-model/src/value-clone.ts)), which thaws a
frozen container by shallow-cloning it and leaves an already-mutable one alone.
So a **deep-frozen document root is stable against every later write in the
transaction**: each write rebuilds the spine it descends and never reaches into
the frozen tree. Pinning a snapshot is therefore one `deepFreeze` of the current
root — and `deepFreeze` short-circuits on already-deep-frozen values through its
cache ([`deep-freeze.ts`](../../packages/data-model/src/deep-freeze.ts)), so it
costs only what this transaction has already thawed by writing. Nothing is
copied, and there is no per-write cost afterwards.

For the case this plan exists to serve, the cost is zero. The scheduler opens a
transaction and hands it straight to the action
([`run.ts`](../../packages/runner/src/scheduler/run.ts)), whose first act is to
read its argument. No write precedes it, so the snapshot for every document is
its `initial` attestation — which the transaction already retains, unmodified,
for the whole of its life.

The general shape, for a `.get()` that happens after writes:

- The transaction carries a write epoch, bumped on each write.
- A lazy view records the epoch at creation.
- Reading a document at epoch E resolves to its `initial` attestation when its
  first write is later than E (the common case — nothing needs pinning), and
  otherwise to the root pinned for E.
- Pins are taken at materialization, for the documents the transaction has
  already written. That set is small and known: it is the transaction's writable
  document entries.

Reads still register their activity on the live transaction, so reactivity and
commit preconditions are unchanged; only the _value_ comes from the pin. The
preconditions describe committed state, which is what the pin holds, so the two
stay consistent.

### The mismatch signal

A refusal below the root throws a dedicated error class — call it
`SchemaMismatchError` — carrying the link, the path, and which check failed.

Throwing alone is not enough: a reader can catch it. So the throw also **marks
the transaction**. The transaction gains a sticky note ("this transaction
produced a schema refusal", with the detail for diagnostics) that survives any
`try`/`catch` in the reader's body and any `await` in an async one. The runner
checks the mark after the body returns, and treats a marked transaction as a
refusal regardless of what the body handed back.

Disposition of a refusal:

- The result is written as undefined through the ordinary result path, the same
  value a non-resolving argument produces.
- It is **not** reported as an action error and **not** logged as one. A refusal
  is a run that could not proceed on the data available, not a fault.
- Writes the body made before the refusal remain in the transaction and commit.
  This matches how an ordinary thrown lift error already behaves, and the sticky
  mark leaves the door open to a stricter disposition later without changing the
  detection mechanism.
- The reads taken up to the refusal — including the one that failed — stay
  registered, so the node re-runs when its inputs change and may then find valid
  data. This is the property that makes the disposition correct rather than
  merely quiet.

### The transaction mode

Lazy materialization is a mode on the transaction, not an argument threaded
through every call. `TransactionWrapper`
([`extended-storage-transaction.ts`](../../packages/runner/src/storage/extended-storage-transaction.ts))
is the existing shape for a transaction that changes read behavior —
`createNonReactiveTransaction` is the precedent — and the mode belongs alongside
it, with a scoped `runWithLazyMaterialization(fn)` helper mirroring
`runWithAmbientReadMeta`.

`Cell.get()` consults the mode and dispatches to the lazy view instead of
`validateAndTransform`. Cells minted during a lazy read inherit the mode through
`getTransactionForChildCells`, so a lift reaching through an `asCell` handle
stays lazy — which is where most of the win is, since a large argument is
usually large because of what hangs off its handles.

The runner turns the mode on around argument materialization and the body, and
off before `writeJavaScriptActionResult`. Result writing, diffing, and the
scheduler's own reads keep eager semantics.

The per-transaction read cache on `Cell.get()`
([`cell.ts`](../../packages/runner/src/cell.ts)) keys on a `variant` string; the
mode joins it, so an eager and a lazy read of the same view do not share an
entry.

## Stages

### Stage 0 — Measure

- [x] Baseline recorded. `test/cell-schema-read-depth.bench.ts` already measures
      whole-array materialization across schema depth, which is the number a
      lazy read has to beat: eager `.get()` costs the same whether the reader
      wants one field or all of them.
- [x] Confirm which cost dominates. It is traversal, by a wide margin.

For a 1000-item list, one `.get()`:

| Schema at the item          | time    |
| --------------------------- | ------- |
| schemaless (the proxy path) | 1.1 ms  |
| `items: true`               | 13.2 ms |
| `items: { type: "object" }` | 29.4 ms |
| every field declared        | 7.2 ms  |

Materializing the recorded read activities is 15 µs against those milliseconds,
so read registration is not where the time goes. The permissive object schema
costing four times the fully declared one is worth its own look: a schema that
declares less should not traverse more.

- [ ] Add the one-scalar arm once a lazy view exists to read through. Until then
      it measures nothing new — eager materialization does the same work either
      way, and the table above is already that number.

### Stage 1 — Split the standing handle from the pinned view

**Done, with a scope correction.** The plan assumed one kind of view and that
every consumer reading past its transaction was a bug to fix. Execution
disproved the second half: pinning universally broke 36 tests across the LLM
dialog builtin, the SQLite builtins, piece auto-start, `inSpace` children, the
module byte cache, and pattern scope. Those are not accidents. A query-result
proxy is a _standing handle on a cell_, and long-lived consumers read one after
the run that made it has committed — an LLM tool call dispatched later, a SQLite
result flushed post-commit, a piece started on demand. Re-resolving the
transaction is the mechanism that makes a handle live, not an oversight.

A test pinned that contract directly (`runtime-v2-read-tx-fallback.test.ts`,
"uses a fresh read transaction for top-level query result proxy reads when no tx
is provided"), which settles it: the behavior is intended.

So both readings now exist over one proxy body, and **the transaction decides
which one a caller gets**. `markLazyMaterializationTx` marks a transaction, on
the same wrapper chain as the marks beside it in `reactivity-log.ts`, and
`createQueryResultProxy` reads that mark:

- [x] Unmarked — every caller today — is the standing handle, resolving per
      access exactly as before. Nothing outside the mark changes behavior.
- [x] Marked is the view. It keeps that transaction for every access and every
      child it hands out; reading after the transaction finishes throws
      `StorageTransactionCompleteError` through the transaction's own
      `editable()` guard, with no new error type.

Gating on the transaction rather than on a second entry point is what keeps the
rule single: a call site cannot pin by accident, and everything a marked
transaction reads pins together, including the schema-less subtrees a
schema-observing view will delegate.

- [x] `Cell.pull()` fixed. It built its value inside a scheduler effect whose
      transaction has committed by the time the promise resolves, so a
      schemaless cell resolved a handle over a dead transaction. The effect
      drives the scheduler; the value the caller keeps is read after it.
- [x] Suite green: 1162 passed, 0 failed, against a baseline of 1161 passed and
      1 failed — the `pull()` fix took that one too.

This also settles Stage 3's "pin both or pin neither": both, within a marked
transaction, and neither outside one. A `.get()` under lazy materialization
hands back handles that agree on which instant they describe, while an unmarked
read keeps the live-handle semantics its consumers rely on.

Stage 4 no longer has to invent the mode — it has to decide what else the mark
means, and set it. Today nothing in the runtime marks a transaction, so the
behavior is dormant by construction.

### Stage 2 — The schema-observing view

Build the view standalone, driven directly, with no transaction mode and no
runner involvement.

- [ ] Add the lazy view module beside `query-result-proxy.ts`, taking
      `(runtime, tx, link, schema, cfcLabelView)`.
- [ ] Property read: narrow with `schemaAtPath` using the `emptyProperties` /
      `missingProperty` markers; a marked property is absent from the view.
- [ ] Link resolution per access, combining the link's schema into the narrowed
      one, matching `validateAndTransform`'s ordering.
- [ ] Dispatch: `asCell` / `asStream` mints a `Cell`; absent or `true` schema
      delegates to `createQueryResultProxy`; scalars return values; containers
      return nested views.
- [ ] Apply schema `default` on an absent slot, through the same
      `processDefaultValue` path the traverser uses.
- [ ] `ownKeys`, `has`, and `getOwnPropertyDescriptor` answer from the schema's
      selection intersected with the data's own keys, so a spread of a view
      carries what an eager read would have carried and nothing more.
- [ ] Arrays: `length`, iteration, and the read-only `Array.prototype` methods,
      each element lazily viewed under the narrowed `items` schema.
- [ ] `toCell` on every view, so an existing consumer of a materialized value
      still reaches its cell.
- [ ] `anyOf` / `oneOf` resolution at access, via `canBranchMatch` and the
      existing branch-schema merge.
- [ ] `SchemaMismatchError` with link, path, and failed check.
- [ ] Root guard: type, `required` presence, immediate scalar types.
- [ ] Reads registered with the same granularity the existing proxy uses —
      non-recursive for shape, recursive for materialized values — and
      registered _before_ a refusal throws.
- [ ] CFC label views rebased per descent and merged from dereference traces, as
      both existing paths do.

Completion gate: for a corpus of schema/value pairs, a full walk of the lazy
view produces a value deep-equal to `validateAndTransform`'s result, and the set
of registered reads is a subset of the eager set. Drive the corpus from the
existing traverse replay fixtures where they fit.

### Stage 3 — Snapshot pinning

- [ ] Add a write epoch to the storage transaction, bumped per write.
- [ ] Record the first-write epoch per document entry.
- [ ] Pin: deep-freeze the current root of each already-written document at
      materialization, keyed by epoch.
- [ ] Read resolution at epoch E: `initial` when first-write is later than E,
      otherwise the pin for E.
- [ ] Read activity registration stays on the live transaction, unchanged.
      Commit preconditions carry address, path and version basis rather than the
      value read, so a pinned read emits the same precondition a live one does.
- [ ] Decide whether the schema-less proxy pins with the schema-observing view,
      and apply the same answer to both. A `.get()` result that is part snapshot
      and part live, split by schema, is what today's code produces and what
      this stage exists to end. See the risk on held handles disagreeing.
- [ ] Test that a reader which writes and then reads through a view taken
      earlier sees the pre-write state, and that a view taken after the write
      sees the post-write state.
- [ ] Test that `.get()`, write, `.get()` returns the written value from the
      second call — the read-result cache is dropped on write, so the second
      call builds a view at the new epoch rather than serving the first one.
- [ ] Test that pinning a document does not disturb a subsequent write to it —
      the write rebuilds its spine and the pin still reads the old value.
- [ ] Leave `getRaw()` alone, and say why where it would otherwise attract a
      change: it returns a detached frozen value at call time, so it has no
      lifetime across a write and nothing to pin.

Completion gate: pinning costs nothing measurable when the transaction has no
writes at materialization, which is the lift-argument case; and every handle a
single `.get()` hands back agrees on which instant it describes.

### Stage 4 — The transaction mode

- [ ] Mode on `TransactionWrapper`, with `runWithLazyMaterialization(fn)`.
- [ ] `Cell.get()` dispatches on the mode.
- [ ] Mode inherited through `getTransactionForChildCells`.
- [ ] Mode joins the read-cache `variant`.
- [ ] Sticky schema-refusal mark on the transaction, set by the view and
      readable by the runner; survives `catch` in reader code and `await` in an
      async body.
- [ ] `sample()` and `pull()` behavior under the mode decided and tested —
      `sample()` wraps a non-reactive transaction and must not silently acquire
      laziness it did not ask for.

Completion gate: flipping the mode on a transaction and reading a cell yields a
view; flipping it off yields today's value; neither leaks into the other.

### Stage 5 — Runner integration

- [ ] Flip the mode around argument materialization and the lift body; flip it
      off before result writing.
- [ ] Check the sticky mark after the body returns and after a thrown error;
      dispose of a marked run as a refusal.
- [ ] A refusal writes the undefined result through the ordinary path, is not
      reported as an action error, and is not logged as one.
- [ ] Handlers: the same treatment, or an explicit decision to leave handlers
      eager in this stage, recorded here.
- [ ] Async bodies: a refusal thrown in a continuation is still caught by the
      mark.
- [ ] Verify the reads taken before a refusal re-trigger the node when the
      missing data appears.

Completion gate: the runner test suite passes with the mode on, and a lift whose
argument has a deep mismatch it never touches now runs — asserted directly,
since that is the intended behavior change.

### Stage 6 — Rollout

- [ ] Register an experimental flag per
      [`../development/EXPERIMENTAL_OPTIONS.md`](../development/EXPERIMENTAL_OPTIONS.md),
      default off, and update that document in the same change.
- [ ] Land default-off; measure against the Stage 0 baseline on real patterns.
- [ ] Turn on in development, soak, then default on.
- [ ] Graduate: remove the flag, remove the eager path for lift arguments,
      update this plan's status and archive it.

## Testing

Follow
[`../development/unit-test-coding-style.md`](../development/unit-test-coding-style.md)
for shape, and
[`../development/waiting-in-tests.md`](../development/waiting-in-tests.md) for
anything that waits — no polls, no sleeps, no retry loops. The gates in
[`../../AGENTS.md`](../../AGENTS.md) that do not run under `deno task check`
(`check-no-waitfor`, `check-docs`, `check-skill-facts`, and the dependency
checks) all apply.

Four properties carry most of the confidence:

- **Equivalence.** A full walk of a lazy view equals the eager result, across a
  corpus wide enough to cover `anyOf`, `asCell`, defaults, links, arrays,
  `prefixItems`, and `additionalProperties`.
- **Frugality.** Reading one scalar from a large argument registers reads for
  the path touched and its containers, and for nothing else. Assert on the
  registered read set, not on timing.
- **Refusal.** A touched mismatch refuses, marks the transaction, survives being
  caught by reader code, and leaves behind the dependency that re-triggers the
  node. Assert the re-trigger by writing the missing data and observing the run.
- **Snapshot.** A view taken before a write reads pre-write state; the pin does
  not disturb later writes.

Mutation-test each new test: break the behavior it claims to guard and confirm
it fails. A test over a proxy is unusually easy to write in a form that cannot
fail, because a proxy answers almost anything.

## Risks

**Silent semantic drift in patterns.** The touch-scoped contract lets a lift run
where it previously did not. A pattern relying on whole-argument collapse as a
guard will change behavior. The experimental flag and the soak exist for this;
the Stage 5 gate asserts the change deliberately rather than discovering it.

**Proxy-hostile consumers.** Code that freezes, structurally clones, or
`preventExtensions` a materialized value will now hit a proxy that refuses those
operations. `snapshotQueryResult`
([`query-result-proxy.ts`](../../packages/runner/src/query-result-proxy.ts)) is
the existing escape and should be the documented answer. Auditing the consumers
that survive to the result-writing boundary is part of Stage 5.

**CFC label timing.** Labels join the flow as paths are touched rather than at
materialization, so a run's label set can be narrower — which is more precise,
and is a change. Stage 1 covers the closed-transaction half of the hazard: a
view that escapes its run can no longer reach past the transaction it was taken
against. What it does not cover is a view read late but still inside a live
transaction, after `prepareCfc()` — that invalidates the prepared digest by
design, and Stage 4 needs a test that the invalidation is what happens rather
than a read slipping past a prepared boundary.

**Escaped views.** Stage 1 turns this from a silent degradation into a throw, so
what remains is the migration: a consumer that today reads a proxy after its
transaction closed gets an error where it used to get committed state. Every
such site was reading state the view never stood for, so each is a fix — but
each still has to be found, and the sweep is part of that stage rather than a
surprise later.

**Held handles disagreeing.** Every read surface bottoms out in the same
`V2StorageTransaction.read()`, which serves `doc.current ?? doc.initial` — the
transaction's own uncommitted writes included. So any two reads taken at the
same instant agree, whatever surface they came through, and that stays true: a
fresh `.get()` after a write is pinned at the post-write epoch and sees it.

The question is only about handles held ACROSS a write, and only two kinds of
handle have a lifetime. `getRaw()` has none — it returns a detached frozen value
at call time, so it is already a snapshot of its own instant and cannot drift. A
query-result proxy does have one, and tracks current state. A pinned view has
one and does not.

So the divergence is between two held handles that a single `.get()` can hand
back at once. An eager result is a detached snapshot except where the schema is
absent or `true`, and there `TransformObjectCreator.createObject` embeds a live
query-result proxy — so a `.get()` result is already part snapshot, part live,
and which is which depends on the schema rather than on anything visible at the
call site. Pinning the schema-observing view without pinning the proxy it
delegates to preserves exactly that split.

Nothing catches it. `StorageTransactionInconsistent` is a different check:
`validate()` claims each read document's `initial` attestation against the live
replica, so it fires when the replica moved under the transaction, not when two
of its own handles disagree. Commit preconditions do not catch it either —
`buildReads` emits address, path and version basis, never the value read — so a
pinned read produces exactly the precondition a live read would.

Stage 3 therefore owes one decision, covering the schema-observing view and the
schema-less proxy it delegates to together: pin both or pin neither. Either
answer makes `.get()` consistent with itself. The split is the one shape that
cannot be reasoned about at a call site, and it is what the code does today.

## Not in scope

- Narrowing the **sync selector** so the server ships only what a reader
  touches. That is the larger win for genuinely huge data and depends on this
  work landing first; it belongs with
  [shaped reads and verb results](shaped-reads-and-verb-results.md).
- Making **handlers** lazy, unless Stage 5 records the decision to include them.
- Replacing the schema-less `createQueryResultProxy`. It remains the view for an
  absent or `true` schema, and the lazy view delegates to it.
