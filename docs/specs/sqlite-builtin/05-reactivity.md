# 05 — Reactivity

SQLite is not itself reactive: nothing in the runtime's read-tracking observes a
`SELECT`. v1 makes queries reactive with an explicit, coarse mechanism — **the
handle cell itself stands in for "this database changed"** — which gets us a
long way without a query-dependency analyzer.

## The model

- `sqliteQuery` takes a `reactOn` input. The built-in reads it **wholesale under
  an `any` schema**, so the scheduler records a dependency on that value and
  everything it transitively links to. When `reactOn`'s **committed** value
  changes, the scheduler re-runs the query action, which re-issues
  `sqlite.query` and writes fresh rows into its result cell.
- Pass **the whole `db` handle** as `reactOn`. The built-in recovers its handle
  cell (via `toCell`, Section [01](./01-api.md#the-handle-type)) and subscribes
  to it. The **write path marks that handle cell dirty after the write commits
  durably** (see "Committed, not in-flight"), so `reactOn: db` means "any
  committed write to this database re-runs the query." There is **no readable
  `version` field** — nothing for code to depend on out of band; the handle cell
  is the token.
- Authors who want tighter invalidation pass a narrower cell as `reactOn` (e.g. a
  per-table or per-topic cell they bump themselves from the same handler that
  writes), trading precision for manual bookkeeping. v1 does not parse SQL to
  compute fine-grained read sets.

This is deliberately the same shape the runtime uses elsewhere: reactivity is
driven by observing cells, and the handle cell's post-commit dirtying stands in
for "the query's underlying data may have changed."

## Committed, not in-flight

The query must re-run against **fully-committed** data, never optimistic
in-flight writes. This matters because:

- The scheduler lets an action see its *own* uncommitted writes within a
  transaction, and propagates to other readers only after commit (per the
  scheduler's transaction model and own-commit-source skip in
  [`packages/runner/src/scheduler/`](../../../packages/runner/src/scheduler/)).
- A SQLite write only becomes visible to a `sqlite.query` once its commit
  transaction has actually run on the server. Re-running the query against an
  optimistic local state would read rows that don't exist server-side yet.

Therefore the handle cell must be dirtied **on durable commit**, not on the
optimistic local write. Two viable mechanisms, in preference order:

1. **Server-driven (preferred).** When `applyCommitTransaction` applies a
   `sqlite` operation (Section [04](./04-server-execution-and-transactions.md)),
   the server marks the **handle cell's entity** dirty — exactly how cell writes
   mark entities dirty
   ([`packages/memory/v2/server.ts`](../../../packages/memory/v2/server.ts)
   `markSpaceDirty`, which already works per entity id). The session push
   (`session/effect`) reaches the query only after the commit is durable, so the
   re-run sees committed state. For the cell-derived default the handle cell
   lives in the same space as the commit, so this is a same-space dirty signal.
2. **Client post-commit bump.** Failing a server hook, the write built-in
   touches the handle cell from a **post-commit effect** rather than inline — the
   same `enqueueSinkRequestPostCommitEffect` seam `fetchData`/`llm` use
   ([`packages/runner/src/builtins/fetch-data.ts`](../../../packages/runner/src/builtins/fetch-data.ts),
   [`packages/runner/src/cfc/sink-request.ts`](../../../packages/runner/src/cfc/sink-request.ts)).
   The effect runs only after the surrounding transaction commits, so the
   dependent re-query sees committed state.

Either way, the **reactive part waits for fully-committed writes**, which (as
the goals note) may require going through a path other than the regular
scheduler's in-flight propagation.

**Injected service-space handles (cross-space wrinkle).** For a `cf`-injected
on-disk database (Section [03.3](./03-database-sources.md)), the handle cell
lives in an operator/service space while the SQLite write rides the *pattern's*
space commit — so the post-commit dirty signal must cross spaces. That is an
extra mechanism beyond same-space `markSpaceDirty`; it lands with the rest of
the injected-source stub. Injected datasets are usually read-mostly (`reactOn`
omitted), so this does not block v1.

## A general feature this motivates

The clean way to express "re-run only on committed inputs" is to let an action
**declare specific inputs as commit-only** — the scheduler would refuse to
re-run the action on transient/optimistic changes to those inputs and wait for
the committed value. That is a generally useful scheduler capability beyond
SQLite (any effect that must not act on speculative state benefits). v1 emulates
it with the post-commit handle-cell dirtying; a follow-up could promote it to a
first-class scheduler annotation (e.g. `committedReads`), at which point
`sqliteQuery` would declare `reactOn` as commit-only and drop the manual bump.
Tracked in [08-open-questions.md](./08-open-questions.md).

## What does *not* trigger re-run

- Changes to the **contents of cells referenced by `_cf_link` columns** do not,
  by themselves, re-run the query — the query only re-reads rows. A decoded
  `Cell` in a result row is, however, a normal reactive cell: a `derive` that
  reads it will update when *it* changes, independent of the query. This keeps
  query re-execution coarse while still letting per-cell reactivity flow through
  normally.
- Writes to *other* databases dirty *their* handle cells, not this one.
