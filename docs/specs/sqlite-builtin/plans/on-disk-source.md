# Plan — Phase 7: injected on-disk SQLite source via `cf` (read-only v1)

> Spec: [03-database-sources.md §03.3](../03-database-sources.md),
> [implementation-plan.md Phase 7](../implementation-plan.md),
> open questions Q12 (cross-space reactivity), Q13/Q14 (co-location / cross-space
> dirty — these GATE writes; **v1 is read-only**).

## Goal (v1, read-only)

An operator points a pattern's `SqliteDb` input at a plain on-disk SQLite file:

```bash
cf piece link <piece> <field> sqlite:/abs/path/reference-data.db
```

- The handle id is **content-derived from `(serviceSpace, absPath)`** via
  `createRef` → idempotent: linking the same path twice resolves to the same
  handle cell.
- The `{ disk: { path } }` source descriptor is **server-side state keyed by the
  handle id** — never in the cell's readable value (the value stays the opaque
  `{ id, tables, rev }`).
- The server, when attaching a db for a handle id, checks the disk registry
  first; if present it attaches **that file read-only** instead of the
  cell-derived per-`(space,id)` path. No descriptor → unchanged cell-derived
  fallback.
- Pending-until-connected falls out of an empty input (Phase 1/3 — unchanged).
- **Read-only:** `db.exec` against an injected on-disk db is rejected (Q13/Q14).
  Reactivity (`reactOn`) for injected dbs is deferred (Q12).

## Mechanism

Three independent seams, each unit-testable:

1. **Read-only ATTACH** (`packages/memory/v2/sqlite/exec.ts`). `attachDatabase`
   gains an optional `{ readOnly?: true }`. A read-only attach uses SQLite's
   `file:<path>?mode=ro&immutable=0` URI form (with `?vfs` default) so writes to
   the alias fail at the engine. `@db/sqlite`'s `ATTACH DATABASE ? AS alias`
   binds the path as a parameter; we bind the `file:…?mode=ro` URI string.

2. **Disk-source registry** (`packages/memory/v2/sqlite/disk-source.ts`, new). A
   small `DiskSourceRegistry`: `register(id, {path})` / `get(id)`. Held on the
   `Server` instance (`#diskSources`). The attach path (`#onCellDb`) consults it:
   - registered → attach `descriptor.path` **read-only** (skip the
     cell-derived path + skip `ensureTables`, since v1 does not migrate external
     files), then run the op.
   - not registered → existing cell-derived behavior (unchanged).
   The write path (`sqliteExecute` / `#attachCommitSqliteDbs`) rejects any op
   whose db id is in the registry with a clear `read-only` error.

3. **Handle-id derivation + `sqlite:` scheme parsing** (CLI). A pure helper
   `parseSqliteSource(ref)` recognizes `sqlite:<absPath>`, validates the path is
   absolute, and `deriveDiskHandleId(serviceSpace, absPath)` = `createRef({ disk:
   { path } }, { space, scheme: "sqlite" })` → deterministic id. Unit-tested for
   idempotency + non-absolute rejection.

### Transport for registration (cf → server)

`cf` and toolshed are separate processes; the descriptor must cross that
boundary. Add a v2 protocol request `sqlite.register-disk-source`
(`{ id, path }`) mirroring `sqlite.query`/`sqlite.execute`, dispatched on the
server to `DiskSourceRegistry.register`. This is the minimal honest transport
reusing the existing websocket session.

## RED → GREEN

### RED tests

- **memory** `test/v2-sqlite-disk-source-test.ts`:
  - read-only ATTACH of a seeded on-disk file: query returns its rows; a write
    to that alias throws.
  - `DiskSourceRegistry` register/get round-trip; unknown id → undefined.
- **memory** server-level (extend disk-source test or attach test): seed a real
  on-disk sqlite file in a temp dir, `register(id, {path})`, run `sqliteQuery`
  through the server → rows returned from the on-disk file (NOT a cell-derived
  empty db); `sqliteExecute` for that id → rejected `read-only`.
- **cli** `commands/piece-sqlite-link-test.ts` (new, or extend a piece test):
  - `parseSqliteSource("sqlite:/abs/x.db")` → `{ path: "/abs/x.db" }`;
    non-`sqlite:` → null; `sqlite:relative` → throws.
  - `deriveDiskHandleId(space, path)` idempotent: same `(space, path)` → same id;
    different path → different id.
- **runner integration** `integration/sqlite-disk-source-query.test.ts`
  (mirrors `sqlite-db-query-decode.test.ts`, self-contained `Deno.serve`): seed
  an on-disk file, register it via the client, query through a pattern/handle →
  rows; unlinked input → pending. (If the full pattern-input wiring proves to
  need the deferred cell-link step, downgrade to a server-level memory test and
  note it.)

### GREEN steps

1. `attachDatabase` read-only option + exec test green.
2. `DiskSourceRegistry` + server `#diskSources`, `#onCellDb` consults it,
   write-path rejection. Server query/exec tests green.
3. v2 protocol `sqlite.register-disk-source` + dispatch.
4. CLI `parseSqliteSource` + `deriveDiskHandleId` + `cf piece link` special-case.
5. Integration test green (or downgraded per note).

## Deferred (with reason)

- **Writes / atomicity to on-disk dbs** — gated on Q13/Q14 (co-location): an
  external file generally cannot join the space commit transaction atomically.
  v1 attaches read-only and rejects `db.exec`.
- **Reactivity (`reactOn`) for injected handles** — gated on Q12: the post-commit
  dirty signal would have to cross from the pattern's space to the service space
  that owns the handle cell; mechanism undefined. Injected datasets are
  read-mostly, so `reactOn` is omitted for v1.
- **Full `cf piece link` cell wiring in a service space** — creating the handle
  cell in a dedicated operator/service space and writing the sigil link to the
  pattern input touches a product decision (which space, who authorizes,
  persistence of the registry across restarts). If this exceeds a focused change,
  ship the deterministic-id helper + scheme parse + server registry and write the
  remaining cell-link wiring up here rather than forcing it.
</content>
</invoke>
