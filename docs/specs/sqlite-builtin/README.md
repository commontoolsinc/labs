# SQLite Builtins for Patterns

## Status

Draft — seeking framework author review. Targets a v1 that ships reading +
writing with reactive re-query, with CFC (Contextual Flow Control) integration
deferred to a follow-up phase (Section [06](./06-cfc.md)).

## Overview

This spec introduces a pair of built-in functions that let patterns run SQLite
queries against databases hosted alongside the space. Patterns already reach
external state through reactive built-ins like `fetchData` and `generateText`
(see [`packages/runner/src/builtins/fetch-data.ts`](../../../packages/runner/src/builtins/fetch-data.ts)
and [`packages/runner/src/builtins/llm.ts`](../../../packages/runner/src/builtins/llm.ts)).
SQLite access follows the same shape: a parameterized request in, a reactive
`{ pending, result, error }` out.

Two capabilities are exposed, with **separate built-ins for read and write** so
they can be protected independently once CFC lands:

- **`sqliteQuery`** — read-only `SELECT` queries. Reactive: re-runs when a
  declared reactivity input changes.
- **`sqliteExecute`** — writes (`INSERT`/`UPDATE`/`DELETE`/DDL). Effectful;
  participates in the same transaction as the cell writes around it.

Both operate on an opaque **database handle** — a branded, otherwise-empty
`SqliteDatabase` value that patterns only forward, never read. It is produced by
a `sqliteDatabase(...)` builder (cell-derived or VM sources), or **injected as a
pattern input** for on-disk databases linked via `cf` (Section
[03](./03-database-sources.md)). The handle's table schema and DDL are owned by
the database, declared once.

Two cross-cutting rules make cell references first-class inside SQLite:

- Writing a cell reference into a column whose name ends in `_cf_link` (and is
  declared `string`) **opaquely encodes it as a full sigil link**. Any other
  attempt to write a cell reference throws. (Section [02](./02-cf-link-encoding.md))
- Reading a `_cf_link` column **transparently decodes** the stored string back
  into a live `Cell`.

## Design goals

1. **Reuse the existing reactive-builtin machinery.** Scheduler integration,
   post-commit effects, request hashing/deduplication, and the CFC write-policy
   sink are all already solved for `fetchData`/`llm`. SQLite access plugs into
   the same seams rather than inventing parallel infrastructure.
2. **Server-side execution.** Queries run inside toolshed, which already hosts
   the space and owns the SQLite engine
   ([`packages/memory/v2/engine.ts`](../../../packages/memory/v2/engine.ts)).
   The runtime reaches them over the **existing space-scoped websocket** — no
   new connection, no new auth path.
3. **Atomic writes across cells and SQLite.** SQLite writes ride the *same*
   commit transaction that applies cell writes, so a commit either lands fully
   (cells + rows) or not at all, in normal operation. (Section
   [04](./04-server-execution-and-transactions.md))
4. **Reactivity that waits for durable writes.** A query re-runs only against
   fully-committed state, never in-flight/optimistic writes. (Section
   [05](./05-reactivity.md))
5. **Cell references survive the round-trip.** A cell written into a `_cf_link`
   column reads back as the same cell, across spaces.
6. **A path to per-column and per-row CFC.** The schema surface is designed so
   confidentiality/integrity labels can be attached per column, and per-row
   labels can be derived from field values, without reworking the API. (Section
   [06](./06-cfc.md))

## Non-goals for v1

- **CFC enforcement.** v1 carries the schema annotations but does not enforce
  them. Confidentiality and integrity checks land in the follow-up phase.
- **Read-after-write within a single transaction.** A `sqliteQuery` issued in
  the same transaction as a not-yet-committed `sqliteExecute` is defined to
  fail (Section [04](./04-server-execution-and-transactions.md)). Simulating
  the pending write is out of scope.
- **Full VM-file and on-disk source implementations.** Both are stubbed behind
  opaque handles (Section [03](./03-database-sources.md)); only the
  cell-derived default source is fully specified for v1.
- **Auto-derived TypeScript types from the SQL string.** Tables are declared on
  the database and result rows via the `sqliteQuery<Row>` type argument; we do
  not parse SQL to infer parameter/result types (Section
  [01](./01-api.md#typescript-and-table-types--why-these-boundaries)).

## Document map

| File | Contents |
| --- | --- |
| [01-api.md](./01-api.md) | TypeScript-facing API: `sqliteDatabase`, `sqliteQuery`, `sqliteExecute`; the new-builtin-vs-new-Cell-type decision; table-type helpers. |
| [02-cf-link-encoding.md](./02-cf-link-encoding.md) | `_cf_link` column encode/decode rules and the throw conditions. |
| [03-database-sources.md](./03-database-sources.md) | The three database sources: cell-derived (default), VM file (stub), on-disk via `cf` (stub). |
| [04-server-execution-and-transactions.md](./04-server-execution-and-transactions.md) | Protocol extension, server-side execution, ATTACH, atomic cells+SQLite commits, WAL crash recovery. |
| [05-reactivity.md](./05-reactivity.md) | Reactive re-query via parallel reactivity cells; committed-vs-transient inputs. |
| [06-cfc.md](./06-cfc.md) | Future per-column and per-row CFC labels. |
| [07-examples.md](./07-examples.md) | End-to-end usage examples. |
| [08-open-questions.md](./08-open-questions.md) | Unresolved design questions for review. |
| [implementation-plan.md](./implementation-plan.md) | Ordered workstreams, milestones, and dependency/gating map for building the feature. |

## At a glance

```tsx
import { sqliteDatabase, sqliteQuery, sqliteExecute, table, cfLink, handler, derive } from "commonfabric";

// A database tied to this pattern's own cell (default source). Tables (and the
// _cf_link columns) are declared once, here; the runtime owns DDL/migration.
const db = sqliteDatabase({
  tables: {
    messages: table({
      id: "integer primary key",
      author_cf_link: cfLink<User>(),
      body: "text",
      ts: "integer",
    }),
  },
});

// Reactive read. Passing the whole `db` means "any committed write re-runs".
const recent = sqliteQuery({
  db,
  sql: "SELECT id, author_cf_link, body FROM messages ORDER BY ts DESC LIMIT 20",
  reactOn: db,
});

// Effectful write, atomic with any surrounding cell writes.
const post = handler<{ body: string }, { author: Cell<User> }>(
  ({ body }, { author }) => {
    sqliteExecute({
      db,
      sql: "INSERT INTO messages (author_cf_link, body, ts) VALUES (?, ?, ?)",
      params: [author, body, Date.now()], // `author` (a Cell) → full sigil link
    });
  },
);

return derive(recent.result, (rows) => rows ?? []);
```
