# 03 — Database sources

`sqliteDatabase(source?)` resolves a handle to one of three physical databases.
Only the first is fully specified for v1; the other two are stubbed behind
opaque handles so the API is stable when their backends land.

In all cases the **physical identity of the database is opaque to the pattern**.
Pattern code holds a handle cell; it never names a file or attach alias.

## 03.1 Cell-derived (default)

```ts
const db = sqliteDatabase();                 // bound to the pattern's context cell
const db = sqliteDatabase({ cell: someCell }); // bound to an explicit cell
```

The database is tied to a cell, and its **name is derived from that cell's
entity id** — which is itself causal to creation and opaque to the pattern.

- Cell ids are content-addressed and causally derived
  ([`packages/runner/src/create-ref.ts`](../../../packages/runner/src/create-ref.ts)).
  When `sqliteDatabase()` is called with no argument, the runtime allocates (or
  reuses) a handle cell in the current frame the same way other built-ins
  allocate their result cells, so the identity is stable across re-runs and
  rehydration but never chosen by the pattern.
- The physical file lives in the **same space's storage directory** as the cell.
  Spaces are already stored one-SQLite-file-per-space under `engine-v3/`
  (`{encodeURIComponent(spaceDid)}.sqlite`, see
  [`packages/memory/v2/storage-path.ts`](../../../packages/memory/v2/storage-path.ts)).
  A cell-derived database is a **sibling file** in that directory, named from
  the cell id, e.g. `cell-<entityhash>.sqlite`.
- It is **ATTACHed** to the space engine's connection for the duration of any
  transaction that writes to it, which is what makes cells-plus-rows atomic
  (Section [04](./04-server-execution-and-transactions.md)).

Lifecycle:

- **Create on first use.** The first `sqliteExecute` (typically a `CREATE TABLE`)
  against a fresh handle creates the file. A query against a database with no
  tables yet returns an empty result, not an error, for the "table exists" check
  is deferred to the statement.
- **Schema ownership.** v1 leaves DDL to the pattern (run `CREATE TABLE
  IF NOT EXISTS …` via `sqliteExecute`). A future revision may let
  `sqliteDatabase({ schema })` declare tables up front and run migrations.
- **GC.** Because the file is keyed to a cell, its lifetime can later be tied to
  that cell's lifetime. v1 does not garbage-collect; this is noted in
  [08-open-questions.md](./08-open-questions.md).

This is the recommended source for almost all pattern use: durable, per-space,
and atomic with the pattern's cells.

## 03.2 VM file (stub)

```ts
const db = sqliteDatabase({ vm: vmHandle, path: "/data/app.db" });
```

A database that is a **file inside a VM**. Today VM files are reached through
toolshed `/api` calls, which we intend to improve regardless. For this spec the
source is **stubbed**: it assumes

- an **opaque, cell-based handle to a VM** (`vmHandle: OpaqueRef<VmHandle>`),
  resolved server-side to a concrete VM the same way other opaque
  capability handles are, and
- a **file path within that VM** (`path: string`).

v1 contract: the handle type and call shape are fixed now; the server rejects VM
sources with a `not-implemented` error until the improved VM file API exists.
Atomicity guarantees (Section [04](./04-server-execution-and-transactions.md))
are **not** offered for VM sources in v1 — a VM file cannot be ATTACHed to the
space engine's connection, so writes to it cannot join the space commit
transaction. When implemented, VM-file writes will run as a post-commit effect
(like `fetchData`) with at-least-once semantics, not as part of the atomic
commit. This limitation is intentional and called out so callers don't assume
cross-store atomicity they won't get.

## 03.3 On-disk file via `cf` (stub)

```ts
const db = sqliteDatabase({ disk: diskHandle });
```

A database that is a **plain file on disk**, opaque to the pattern and linked in
out-of-band via `cf` binary calls (the CLI; see the `cf` skill and
[`packages/cli`](../../../packages/cli)). The pattern never sees the path; an
operator runs something like `cf sqlite link ./local.db --into <cell>` to bind a
real file to an opaque `diskHandle` cell, which the pattern then passes to
`sqliteDatabase({ disk })`.

v1 contract: handle type and call shape fixed; server returns `not-implemented`
until the `cf` linking command exists. Like the VM source, an on-disk file the
server can co-locate with the space *could* be ATTACHed and made atomic; whether
to require co-location is an open question
([08-open-questions.md](./08-open-questions.md)). Until then, treat on-disk
writes as non-atomic post-commit effects.

## Source comparison

| | Cell-derived (03.1) | VM file (03.2) | On-disk via `cf` (03.3) |
| --- | --- | --- | --- |
| v1 status | **Implemented** | Stub (opaque handle) | Stub (opaque handle) |
| Identity | Cell entity id | VM handle + path | `cf`-linked disk handle |
| Co-located with space | Yes | No | Maybe |
| Atomic with cell writes | **Yes** (ATTACH) | No (post-commit effect) | TBD |
| Typical use | Pattern-owned data | Sandboxed app data | Operator-provided datasets |
