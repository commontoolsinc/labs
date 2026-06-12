# Chapter 8 — The Reactive Runtime

Chapter 7 ended with a frozen graph object. This chapter is about the
machine that runs it: what a `Cell` really is, how the scheduler decides
what to re-execute, and how writes become transactions. This is the heart of
the system — `packages/runner` (with public types in `packages/api`).

## What a Cell actually is

A `Cell` (`packages/runner/src/cell.ts`) holds no data. It is a **typed
pointer plus a transaction context**:

```
Cell = {
  link: { space, id, path, schema },   // a NormalizedLink — WHERE and WHAT SHAPE
  tx,                                  // which transaction reads/writes go through
  ...                                  // kind: cell | stream | readonly | ...
}
```

- `space` — the DID of the space the document lives in.
- `id` — the entity id (`of:<hash>` URI) of the document.
- `path` — a property path *within* the document (`["items", 2, "title"]`).
- `schema` — the JSON schema (from Chapter 7) describing what's expected at
  that path — including `asCell`/`default`/`scope` annotations.

Every cell operation is now obvious from the shape: `.key("title")` returns
a sibling cell with one more path segment and the narrowed schema.
`.asSchema()` reinterprets the same location under a different schema.
`.get()` resolves the link against the local replica of the space *through
the current transaction*. Path-granular reactivity (Chapter 2) falls out:
dependencies are recorded as (id, path) pairs, so writing `item.done`
doesn't disturb readers of `item.title`.

Entity ids are content-derived: `createRef(source, cause)` hashes the
creation context (`packages/runner/src/create-ref.ts`), so the "same" cell
created by the same graph node gets the same id deterministically — which is
what lets a server re-instantiate a piece and arrive at the same cells.

**Links between documents** are stored as serializable references (sigil
links: `{ "/": { documentId, path, ... } }`). When a read encounters one, it
resolves through to the target — transparently crossing documents and even
spaces. This is the mechanism behind `cf piece link` (Chapter 5), and also
behind the "selection" gotcha (Chapter 6, #7): writing to a cell that
*contains* a link writes through to the link's target, by design.

## The scheduler: reads are subscriptions, literally

The runtime's event loop is the scheduler
(`packages/runner/src/scheduler.ts`). Every graph node — each `computed`,
`lift`, handler, render binding — is an **action**. The cycle:

1. **Run inside a transaction.** Each action executes with a fresh
   transaction whose journal records every (space, id, path) it read — the
   *reactivity log*. No annotations needed; reading through the transaction
   is what subscribes you.
2. **Commit.** The transaction's writes are applied (next section).
3. **Re-subscribe.** The action's actual read-set replaces its old one. The
   scheduler maintains a reverse index — "this (id, path) is read by these
   actions" — so dependencies follow the data the action *really* touched
   this run, branch by branch.
4. **React.** When any write lands (locally, or arriving from the server —
   the scheduler doesn't care), the index marks the affected actions dirty
   and queues them.

Two execution strategies exist (`scheduler/pull-execution.ts`,
`push-execution.ts`): **push** re-runs anything dirty immediately; **pull**
(the default) is lazy — only computations that something observable (a UI
sink, an effect, an explicit `.pull()`) depends on get re-run, so an
unobserved derived value costs nothing.

Cycles and pathologies are contained by bounded iteration — an action that
keeps dirtying itself (e.g. a `computed` that writes upstream, gotcha #2)
gets cut off with the "Too many iterations" error rather than hanging the
runtime.

The dirtying machinery is also why *remote* changes feel local: a synced
update from another user lands in the replica as a write notification, hits
the same trigger index, and re-runs the same actions. The pattern code
cannot tell the difference.

## Transactions: atomicity and optimism

Every action runs in an `IExtendedStorageTransaction`
(`packages/runner/src/storage/`):

- **Reads** go through the transaction so they (a) see a consistent
  snapshot plus the transaction's own pending writes, and (b) get journaled
  for reactivity and conflict detection.
- **Writes** are buffered in the journal, not applied. A transaction may
  write to **one space** (reads may span spaces).
- **Commit** applies the writes to the local replica *optimistically* —
  subscribers re-run immediately — and ships them to the server
  asynchronously (Chapter 9).

If the server later rejects the commit (someone else won a race), the
replica rolls the optimistic writes back, emits a `revert` notification
(dependents re-run with the restored state), and the runtime retries the
action against fresh data (`Runtime.editWithRetry`; the scheduler retries
reactive actions a bounded number of times). This is the mechanism behind
the Part I promise "optimistic but converge; you may see a write lose and
re-apply."

Note the layering discipline: the scheduler only knows "transactions commit
or conflict"; *how* conflicts are detected is entirely the storage layer's
business (Chapter 9). That separation is what lets the same runtime run
against an in-process store (tests, CLI) or a remote server, unchanged.

## Executing a pattern graph

Instantiating a piece (`packages/runner/src/runner.ts` and `builder/`) ties
the previous three sections together:

1. The pattern's `argumentSchema` is applied to the argument cell — this is
   where `default:` values materialize and `asCell` decides whether a node
   receives a value or a writable handle.
2. Each `Node` in the graph becomes a scheduled action: `javascript` nodes
   (lifts/computeds/handlers) wrap their compiled implementation (fetched
   via the `implementationRef` function cache); `pattern` nodes recurse into
   sub-patterns; `isolated` nodes run in the stronger sandbox.
3. Handler nodes register as **stream** consumers: nothing runs until
   something `.send()`s to the stream; then the handler executes as a
   one-shot action with the event as input, in its own transaction.
4. The `result` tree is written so the piece's result cell contains links to
   the right internal cells — which is why other pieces can link to a
   piece's outputs (Chapter 5): the outputs *are* addressable cells.

There's no diffing and no re-render pass anywhere in this story. The UI
(Chapter 11) is just one more subscriber: a VNode tree whose dynamic slots
are cells, with a renderer that patches the DOM when those cells change.

## Spaces in the runtime

The runtime's `StorageManager` opens one **provider per space**, each
wrapping a local **replica** (confirmed state + pending optimistic
versions per document). All cells with the same `space` share that replica;
cross-space links just mean an action's read-set spans replicas. Identity
and authorization for opening a space session are Chapter 10's subject; the
sync protocol that keeps replicas honest is next.

---

**Next:** [Chapter 9 — Storage and sync](09-storage-and-sync.md): what
happens to a commit after it leaves the replica.
