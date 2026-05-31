# 08 — Open questions

Unresolved items for framework-author review, grouped by area. Items resolved
during design are marked **[resolved]** with the decision.

## API surface

1. **Handle methods vs. free built-ins.** We chose free built-ins
   (`sqliteQuery`/`sqliteExecute`) over methods on the handle (Section
   [01](./01-api.md)). Is ergonomic sugar (`db.query(...)` / `db.execute(...)`)
   worth adding as a thin forwarder, or does that re-blur the read/write
   capability split CFC wants kept separate?
2. **Multi-statement writes.** Should `sqliteExecute` accept multiple statements
   in one `sql`, or one statement per call (clearer atomicity story, easier
   `_cf_link` param mapping)?
3. **Transformer support for `sqliteQuery<Row>`.** Result typing relies on the
   ts-transformer lowering the `Row` type argument into a runtime schema, the
   way `toSchema<T>()` works (Section
   [01](./01-api.md#sqlitequeryrowparams--reactive-read)). This must be added to
   the transformer's type-arg-lowering list — confirm feasibility and effort
   with the ts-transformers owner. Without it the generic is erased and carries
   no runtime decode/CFC info.

## `_cf_link`

4. **[resolved] Suffix vs. schema-only.** Keep both: the `*_cf_link` suffix is
   the self-documenting fallback (legible in raw SQL); the database table schema
   (`cfLink<T>()`) and `sqliteQuery<Row>` `Cell<T>` fields refine it with element
   type and CFC labels and take precedence. The suffix is not required when a
   schema covers the column, but remains the default driver when none does.
5. **Schema in stored links.** We strip `schema`/`asCell` from the stored sigil
   (Section [02](./02-cf-link-encoding.md)) and re-attach the element schema from
   the table schema or `Row` on read. If neither covers a column, the decoded
   cell has no schema — acceptable, or should we store a minimal schema
   reference?

## Transactions & storage

6. **ATTACH model.** One sibling `.sqlite` file per cell-derived db, ATTACHed
   on demand — vs. tables inside the space's own db (namespaced), vs. one shared
   "patterns" db per space. Per-file gives isolation and easy GC; a shared db
   simplifies ATTACH and transaction coordination. Which wins?
7. **WAL crash reconciliation.** The `_cf_commit_watermark` + in-doubt rollback
   sketch (Section [04](./04-server-execution-and-transactions.md)) needs a
   precise algorithm: how to revert SQLite-side changes for an in-doubt `seq`
   when only forward WAL frames exist. Do we instead checkpoint+fsync both files
   under a single coordinating lock per commit and accept the latency?
8. **Connection contention.** `@db/sqlite` is a single synchronous connection
   per `Database`. Long queries block the space. Do we need a separate read
   connection (WAL readers don't block writers), a statement timeout, or a
   query cost limit for v1?
9. **[resolved] DDL ownership.** The database owns table creation/migration via
   `sqliteDatabase({ tables })` (Section
   [01](./01-api.md#schema-ownership--the-database-owns-its-tables)); patterns do
   not run `CREATE TABLE`. **Still open:** the *migration* algorithm — how far to
   reconcile a changed `tables` declaration given SQLite's limited `ALTER`
   (add-column is easy; drop/rename/retype need table-rebuild). Define the
   supported migration set and the failure mode for unsupported changes.

## Reactivity

10. **Commit-only inputs as a scheduler primitive.** Section
    [05](./05-reactivity.md) emulates "re-run only on committed inputs" with the
    post-commit handle-cell dirtying. Should the scheduler gain a first-class
    `committedReads` annotation, and would `sqliteQuery` then drop the manual
    bump entirely?
11. **Finer invalidation.** Is coarse `reactOn: db` (whole-database) invalidation
    good enough for v1, or do we want table-level handle cells (dirtied per
    touched table) out of the box, parsed from the write SQL?
12. **Cross-space dirty signal for injected handles.** A `cf`-injected on-disk
    handle cell lives in a service space while its writes ride the pattern's
    space commit (Section [05](./05-reactivity.md)). The post-commit dirty signal
    must cross spaces — define that mechanism, or restrict injected sources to
    read-only (no `reactOn`).

## Sources

13. **VM-file API.** What is the improved VM file interface, and can a VM file
    ever be ATTACHed to the space connection for atomicity, or is it always a
    non-atomic post-commit effect (Section [03](./03-database-sources.md))?
14. **On-disk co-location.** Should `cf`-linked on-disk databases be required to
    live where toolshed can ATTACH them (enabling atomicity), or are they always
    read-mostly external datasets? (Partly informed by the `sqlite:` injection
    model in Section [03.3](./03-database-sources.md), which fixes *addressing*
    but not co-location.)
15. **GC of cell-derived dbs.** When the owning cell is collected, who deletes
    the sibling `.sqlite` file, and when?

## CFC (future)

16. **Row-label projection language.** Section [06](./06-cfc.md) proposes a pure
    declarative projection (`principal(field)`, `jsonArray(field)`) so the
    server can evaluate row labels at commit. Is that expressive enough for real
    policies (e.g. recipients stored as a join table rather than a JSON column)?
17. **Read-time filtering vs. fail-closed.** When a reader lacks clearance for
    some rows, do we silently filter them out of the result set, or fail the
    whole query closed? Filtering leaks row counts; failing closed is coarse.
