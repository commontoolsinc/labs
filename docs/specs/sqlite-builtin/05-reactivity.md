# 05 — Reactivity

SQLite is not itself reactive: nothing in the runtime's read-tracking observes a
`SELECT`. v1 makes queries reactive with an explicit, coarse mechanism —
**parallel reactivity cells that change when a query should be redone** — which
gets us a long way without a query-dependency analyzer.

## The model

- `sqliteQuery` takes a `reactOn` input. The built-in reads it **wholesale under
  an `any` schema**, so the scheduler records a dependency on that value and
  everything it transitively links to. When `reactOn`'s **committed** value
  changes, the scheduler re-runs the query action, which re-issues
  `sqlite.query` and writes fresh rows into its result cell.
- Every database handle exposes a `version: number` field. The **write path
  bumps `db.version` after the write commits durably** (see "Committed, not
  in-flight" below). A query with `reactOn: db.version` therefore re-runs after
  any committed write to that database — the simplest correct default.
- Authors who want tighter invalidation pass a narrower cell as `reactOn` (e.g. a
  per-table or per-topic version cell they bump themselves from the same handler
  that writes), trading precision for manual bookkeeping. v1 does not parse SQL
  to compute fine-grained read sets.

This is deliberately the same shape the runtime uses elsewhere: reactivity is
driven by observing cells, and the SQL layer manufactures a cell (`version`)
whose changes stand in for "the query's underlying data may have changed."

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

Therefore `db.version` must be bumped **on durable commit**, not on the
optimistic local write. Two viable mechanisms, in preference order:

1. **Server-driven (preferred).** When `applyCommitTransaction` applies a
   `sqlite` operation (Section [04](./04-server-execution-and-transactions.md)),
   the server marks the database's reactivity key dirty for the space — exactly
   how cell writes mark entities dirty
   ([`packages/memory/v2/server.ts`](../../../packages/memory/v2/server.ts)
   `markSpaceDirty`). The session push (`session/effect`) carries the new
   `version`, which lands in the handle cell only after the commit is durable.
   The query, watching `db.version`, re-runs. This naturally satisfies
   "committed only," because the value only changes via the server's
   post-commit sync.

2. **Client post-commit bump.** Failing a server hook, the write built-in bumps
   `db.version` from a **post-commit effect** rather than inline — the same
   `enqueueSinkRequestPostCommitEffect` seam `fetchData`/`llm` use
   ([`packages/runner/src/builtins/fetch-data.ts`](../../../packages/runner/src/builtins/fetch-data.ts),
   [`packages/runner/src/cfc/sink-request.ts`](../../../packages/runner/src/cfc/sink-request.ts)).
   The effect runs only after the surrounding transaction commits, so the bump —
   and the dependent re-query — sees committed state.

Either way, the **reactive part waits for fully-committed writes**, which (as
the goals note) may require going through a path other than the regular
scheduler's in-flight propagation.

## A general feature this motivates

The clean way to express "re-run only on committed inputs" is to let an action
**declare specific inputs as commit-only** — the scheduler would refuse to
re-run the action on transient/optimistic changes to those inputs and wait for
the committed value. That is a generally useful scheduler capability beyond
SQLite (any effect that must not act on speculative state benefits). v1 emulates
it with the post-commit `version` bump; a follow-up could promote it to a
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
- Writes to *other* databases do not bump this `db.version`.
