# 08 — Open questions

Unresolved items for framework-author review, grouped by area.

## API surface

1. **Handle methods vs. free built-ins.** We chose free built-ins
   (`sqliteQuery`/`sqliteExecute`) over methods on the handle (Section
   [01](./01-api.md)). Is ergonomic sugar (`db.query(...)` / `db.execute(...)`)
   worth adding as a thin forwarder, or does that re-blur the read/write
   capability split CFC wants kept separate?
2. **Multi-statement writes.** Should `sqliteExecute` accept multiple statements
   in one `sql`, or one statement per call (clearer atomicity story, easier
   `_cf_link` param mapping)?
3. **Result typing.** Is the author-annotated `rows`/`RowOf<>` approach
   (Section [01](./01-api.md#typescript-and-table-types)) enough, or do we want
   a heavier `cf` codegen step that reads a live schema and emits row types?

## `_cf_link`

4. **Suffix vs. schema-only.** v1 keys off the `*_cf_link` column-name suffix so
   the contract is visible in raw SQL. Is the implicit naming convention
   acceptable, or should link columns be required to come with a `cfLink`
   schema (no behavior from naming alone)?
5. **Schema in stored links.** We strip `schema`/`asCell` from the stored sigil
   (Section [02](./02-cf-link-encoding.md)) and re-attach the element schema
   from `cfLink<T>()` on read. If a query omits `rows`, the decoded cell has no
   schema — acceptable, or should we store a minimal schema reference?

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
9. **DDL ownership.** v1 leaves `CREATE TABLE` to patterns. Should
   `sqliteDatabase({ schema })` own table creation/migration instead, so the
   runtime can validate `_cf_link` columns and (later) CFC labels up front?

## Reactivity

10. **Commit-only inputs as a scheduler primitive.** Section
    [05](./05-reactivity.md) emulates "re-run only on committed inputs" with a
    post-commit `version` bump. Should the scheduler gain a first-class
    `committedReads` annotation, and would `sqliteQuery` then drop the manual
    bump entirely?
11. **Finer invalidation.** Is coarse `db.version` invalidation good enough for
    v1, or do we want table-level version cells (bumped per touched table) out
    of the box, parsed from the write SQL?

## Sources

12. **VM-file API.** What is the improved VM file interface, and can a VM file
    ever be ATTACHed to the space connection for atomicity, or is it always a
    non-atomic post-commit effect (Section [03](./03-database-sources.md))?
13. **On-disk co-location.** Should `cf`-linked on-disk databases be required to
    live where toolshed can ATTACH them (enabling atomicity), or are they always
    read-mostly external datasets?
14. **GC of cell-derived dbs.** When the owning cell is collected, who deletes
    the sibling `.sqlite` file, and when?

## CFC (future)

15. **Row-label projection language.** Section [06](./06-cfc.md) proposes a pure
    declarative projection (`principal(field)`, `jsonArray(field)`) so the
    server can evaluate row labels at commit. Is that expressive enough for real
    policies (e.g. recipients stored as a join table rather than a JSON column)?
16. **Read-time filtering vs. fail-closed.** When a reader lacks clearance for
    some rows, do we silently filter them out of the result set, or fail the
    whole query closed? Filtering leaks row counts; failing closed is coarse.
