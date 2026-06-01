# 03 — Database sources

A handle resolves to one of three physical databases. They split by **who
chooses the source**:

- **Pattern-chosen** sources come from the `sqliteDatabase(...)` builder — the
  pattern owns the database (cell-derived default, or VM file).
- **Injected** sources are wired into a pattern *input* from outside; the
  pattern is source-agnostic and an operator connects a database via `cf`
  (on-disk).

Only the cell-derived source is fully specified for v1; the others are stubbed
so the API is stable when their backends land.

In all cases the **physical identity of the database is opaque to the pattern**.
The handle's readable value is empty (Section [01](./01-api.md#the-handle-type));
the source descriptor lives as server-side state keyed by the handle cell's id.
Pattern code holds an opaque handle; it never names a file or attach alias.

## 03.1 Cell-derived (default)

```ts
const db = sqliteDatabase({ tables }); // bound to a cell the runtime allocates here
```

The database is tied to a cell the runtime allocates for this call, and its
**name is derived from that cell's entity id** — which is itself causal to
creation and opaque to the pattern.

- There is **no way to point the database at an arbitrary cell**. A pattern
  cannot pass "some other cell" as the database's identity; doing so would
  re-introduce ambient authority (a pattern naming a cell it was never granted).
  The handle is always the one the runtime allocates for the call (cell-derived)
  or one injected into an input from outside (Section 03.3).
- Cell ids are content-addressed and causally derived
  ([`packages/runner/src/create-ref.ts`](../../../packages/runner/src/create-ref.ts)).
  The runtime allocates (or reuses) the handle cell in the current frame the same
  way other built-ins allocate their result cells, so the identity is stable
  across re-runs and rehydration but never chosen by the pattern.
- **One file per database** (Q6 → Option A). The physical file lives in the
  **same space's storage directory** as the cell. Spaces are already stored
  one-SQLite-file-per-space under `engine-v3/`
  (`{encodeURIComponent(spaceDid)}.sqlite`, see
  [`packages/memory/v2/storage-path.ts`](../../../packages/memory/v2/storage-path.ts)).
  A cell-derived database is a **sibling file** in that directory, named from
  the cell id, e.g. `cell-<entityhash>.sqlite`. Per-file gives the cleanest
  isolation, lets the file boundary act as the SQL namespace (no identifier
  rewriting), and makes GC/export a file operation (`backup()` / delete).
- It is **ATTACHed** to the space engine's connection (via an attach/detach LRU
  cache) for the duration of any transaction that touches it — which is what
  makes cells-plus-rows atomic. Isolation against the core store relies on the
  file boundary, the core-table-rename flag, and a tokenizer-level statement
  guard, all detailed in Section
  [04](./04-server-execution-and-transactions.md#isolation-namespacing--the-statement-guard).

Lifecycle:

- **Create/migrate from the declared schema.** The runtime creates the file and
  reconciles tables from `sqliteDatabase({ tables })` (Section
  [01](./01-api.md#schema-ownership--the-database-owns-its-tables)) — patterns do
  not run `CREATE TABLE`. Migration scope and SQLite `ALTER` limits are tracked
  in [08-open-questions.md](./08-open-questions.md).
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

## 03.3 On-disk file, injected via `cf` (stub)

A database that is a **plain file on disk**, opaque to the pattern. The pattern
does **not** select it with the builder; instead it declares a database
**input** and an operator connects a file to it via `cf`:

```tsx
// The pattern is source-agnostic — it just consumes whatever is wired into `db`.
pattern<{ db: SqliteDatabase }>(({ db }) => {
  const rows = sqliteQuery({ db, sql: "SELECT … FROM lookup", reactOn: db });
  // Until connected, `rows.pending` stays true (Section 05 / Example 07-#5).
});
```

```bash
# Operator wires an on-disk SQLite file into the piece's `db` input.
cf piece link <piece-id> db sqlite:/abs/path/reference-data.db
```

How the `sqlite:` scheme works (it reuses `cf piece link`'s source parsing —
[`parseLink`](../../../packages/cli/commands/piece.ts) — alongside existing
schemes like `of:`, `did:key:`, and the `data:` URI links the runtime already
resolves):

1. `cf` recognizes the `sqlite:` scheme and **create-if-absents a handle cell**
   whose id is **content-derived from `(space DID, absolute path)`** — the same
   content-addressing as
   [`createRef`](../../../packages/runner/src/create-ref.ts). The cell lives in
   an operator/service space; the source descriptor (`{ disk: { path } }`) is
   stored as server-side registration state (webhook-ingress style), not in the
   cell's readable value.
2. `cf` then writes a **normal sigil link** from the piece's `db` input field to
   that handle cell. Because the id is deterministic, this is a genuine
   cell-to-cell link, not a special value-write — and linking the same path
   twice resolves to the same handle, so multiple pieces share one handle cell.

**Pending-until-connected** falls out of reactivity: an unpopulated `db` input
is an empty cell, so `sqliteQuery` reports `pending: true`; when `cf` writes the
link, the input cell changes, the query action re-runs, and it connects. (A
populated-but-unreachable database surfaces `error` instead.)

v1 contract: the `sqlite:` registration is **stubbed** — the server returns
`not-implemented` until on-disk attach + the `cf` command exist. Like the VM
source, an on-disk file the server can co-locate with the space *could* be
ATTACHed and made atomic; whether to require co-location is an open question
([08-open-questions.md](./08-open-questions.md)). Until then, treat on-disk
writes as non-atomic post-commit effects. Reactive re-query for injected
service-space handles also carries a cross-space dirty-signal wrinkle (Section
[05](./05-reactivity.md)); injected datasets are usually read-mostly
(`reactOn` omitted), so this does not block v1.

## Source comparison

| | Cell-derived (03.1) | VM file (03.2) | On-disk via `cf` (03.3) |
| --- | --- | --- | --- |
| v1 status | **Implemented** | Stub (builder) | Stub (injected input) |
| Chosen by | Pattern (`sqliteDatabase()`) | Pattern (`sqliteDatabase({ vm })`) | Operator (`cf piece link sqlite:`) |
| Identity | Handle cell entity id | VM handle + path | Handle cell id from `(space, path)` |
| Co-located with space | Yes | No | Maybe |
| Atomic with cell writes | **Yes** (ATTACH) | No (post-commit effect) | TBD |
| Typical use | Pattern-owned data | Sandboxed app data | Operator-provided datasets |
