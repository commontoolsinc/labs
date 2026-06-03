# 08 — Open questions

Unresolved items for framework-author review, grouped by area. Items resolved
during design are marked **[resolved]** with the decision.

## API surface

1. **[resolved — handle methods]** The original draft chose free built-ins
   (`sqliteQuery`/`sqliteExecute`) over methods on the handle. **As built**, the
   handle is a `SqliteDb` cell variant exposing `db.query` (reactive read) and
   `db.exec` (imperative write) directly (Section [01](./01-api.md)). The
   read/write capability split is preserved at the type level — `.query` and
   `.exec` are distinct methods CFC can gate separately — and the reactive
   `sqliteExecute` built-in was removed (`db.exec` folds the write into the
   caller's commit instead). A free `sqliteQuery<Row>(...)` function remains as an
   equivalent alias for `db.query<Row>(...)`.
2. **Multi-statement writes.** Should `db.exec` accept multiple statements in one
   `sql`, or one statement per call (clearer atomicity story, easier `_cf_link`
   param mapping)? Still open.
3. **[resolved] Transformer support for `sqliteQuery<Row>`.** Routine: the
   transformer already lowers type arguments to schemas for `toSchema<T>`,
   `generateObject`, and `lift`. Add a registry entry + a schema-injection rule —
   see [`packages/ts-transformers/docs/adding-type-arg-schema-lowering.md`](../../../packages/ts-transformers/docs/adding-type-arg-schema-lowering.md)
   and Phase 5 of the [implementation plan](./implementation-plan.md). Not a
   gating risk.

## `_cf_link`

4. **[resolved] Suffix vs. schema — as built.** The `*_cf_link` suffix drives the
   **write** path (which params encode as links) and the storage type (`TEXT`),
   and is self-documenting in raw SQL. **Decode-to-`Cell` on read is driven by the
   typed `db.query<Row>` schema** (a `Cell<T>` field → `asCell`), *not* by the
   suffix alone: an **untyped** query returns the raw sigil-link string regardless
   of the column name (Section [02](./02-cf-link-encoding.md)). So the suffix is
   the storage/write marker and `<Row>` is the read-decode driver — they are
   complementary, not a fallback chain.
5. **Schema in stored links.** We strip `schema`/`asCell` from the stored sigil
   (Section [02](./02-cf-link-encoding.md)) and re-attach the element schema from
   the `Row` on read. If `Row` does not cover a column (untyped query), the decoded
   cell has no schema — acceptable, or should we store a minimal schema
   reference?

## Transactions & storage

6. **[resolved] ATTACH model → one sibling `.sqlite` file per cell-derived db**
   (Option A), ATTACHed on demand. Considered: tables inside the space's own db
   (rejected — co-mingles untrusted pattern schema with the authoritative store),
   and one shared per-space "patterns" db (viable, but forces full SQL
   parse-and-rewrite for table-name namespacing). A wins because:
   - SQLite's only namespace primitive is the attached-db alias, so the file
     boundary gives per-pattern namespacing **for free** — unqualified names
     resolve to the (solely) attached pattern db, **no identifier rewriting**.
   - `@db/sqlite` exposes **no authorizer** (confirmed — see Section
     [04](./04-server-execution-and-transactions.md)), so a shared db would need
     a full parser anyway; A needs only a tokenizer-level guard.
   - Best isolation, file-delete/`backup()` GC and export.
   **Depends on** the core-table-rename flag (below) to remove `main` shadowing,
   and an attach/detach LRU cache for the attach limit. Trade-off accepted:
   per-file WAL reconciliation (Q7) is per-written-db rather than a single pair.
7. **[resolved — V1 cut] WAL crash reconciliation → detect + quarantine.** Normal
   operation is atomic; only a crash *during* a multi-file COMMIT can leave
   `main` and a pattern db disagreeing for one `seq`. V1: write a
   `_cf_commit_watermark(seq)` inside the same txn (no hot-path cost) and
   **persist each commit's `sqlite` ops in the commit record** (small, avoids a
   later migration). On open, compare the watermark to the space's committed
   `seq`; on mismatch, **quarantine that pattern db** (fail its queries with a
   clear error + loud log) rather than serve divergent data.
   *Deferred (fast-follow):* auto-repair — replay missing seqs' persisted ops for
   a behind db, truncate orphaned in-doubt writes for an ahead one. Rejected:
   per-commit checkpoint+fsync of both files (doesn't actually close the crash
   window and kills WAL throughput).
8. **Connection contention.** `@db/sqlite` is a single synchronous connection
   per `Database`. Long queries block the space. Do we need a separate read
   connection (WAL readers don't block writers), a statement timeout, or a
   query cost limit for v1?
8a. **[resolved — V1 cut] Attach limit & core-table shadowing (Option A).**
   - **Attach limit:** `@db/sqlite` exposes no `sqlite3_limit` binding, so
     `SQLITE_LIMIT_ATTACHED` is fixed at the compiled default (assume 10). V1:
     design within 10 with an **attach/detach LRU cache** — attach a pattern db
     on demand, evict (`DETACH DATABASE`) the least-recently-used near the limit,
     managed at **transaction boundaries** (attach before `BEGIN`, detach only
     when idle). A commit almost always touches one pattern db (2 schemas), far
     under the limit; reject/split a transaction that would span more at once.
     A one-time startup **probe only logs** the real limit (no dependency on
     headroom).
   - **Core-table shadowing:** V1 ships **without** the core-table rename. Cheap
     mitigations now: the statement guard rejects schema-qualified references,
     `ATTACH`/`DETACH`/`PRAGMA`, and multiple statements; patterns may **not
     declare** a table whose name collides with the core set, and the guard
     **rejects statements that reference a core-table identifier**. Residual,
     documented pre-production gap: tokenizer-level reference checking has minor
     false positives/negatives (e.g. a column literally named `commit`).
     *Deferred (production hardening, behind a flag):* rename the engine's core
     tables to include the space DID (e.g. `commit__<did>`), which removes
     shadowing structurally and drops the name-based guarding. Kept out of the
     feature's critical path because it's an invasive core-store migration.
9. **[resolved — V1 cut] DDL ownership + migration scope → additive-only.** The
   database owns DDL via `sqliteDatabase({ tables })` (Section
   [01](./01-api.md#schema-ownership--the-database-owns-its-tables)); patterns do
   not run `CREATE TABLE`. On open, the runtime diffs declared `tables` against
   `PRAGMA table_info`: **create missing tables**, **`ADD COLUMN`** for new
   nullable/defaulted columns, and validate `_cf_link` columns are `TEXT`. Any
   **destructive or ambiguous** change (drop/rename/retype, constraint/PK change)
   → **refuse to open the db with an explicit "unsupported migration" error**.
   Rationale: a *declarative* diff can't distinguish a rename from a drop+add, so
   auto-applying destructive ops is unsafe; `ADD COLUMN` also can't add `NOT
   NULL` without a default (documented).
   *Deferred (post-V1):* keep erroring by default, but let a database opt in to a
   **migration callback** — author-supplied logic invoked when the on-disk schema
   version is older than the declared one, to perform the reshape (table-rebuild,
   data copy) explicitly. This preserves "no silent destructive migration" while
   giving an escape hatch for evolving older databases.

## Reactivity

10. **[resolved — commit-fold rev bump]** Earlier designs emulated "re-run only
    on committed inputs" with a *separate* post-commit handle-cell dirtying (and
    contemplated a first-class `committedReads` scheduler annotation). **As
    built**, `db.exec` bumps the handle cell's `rev` **inside its own write
    commit** (Section [05](./05-reactivity.md)). The scheduler's existing
    own-commit propagation then notifies `reactOn: db` queries exactly when the
    write commits durably — no separate post-commit signal, and no new scheduler
    primitive needed for the cell-derived case. (A `committedReads` annotation may
    still be worth it as a general feature, but `sqliteQuery` does not need it.)
    This same read-modify-write also resolves the **multi-tab write mutex**: two
    concurrent `db.exec` commits conflict on the handle cell's revision and
    serialize (one retries) — for free, with no separate mutex primitive.
    *Future hardening (not needed for the cell-derived case):* a server-driven
    `markSpaceDirty(handle-id)` emitted when a folded `sqlite` op commits would be
    a more robust signal than the value-`rev` bump, and is the natural mechanism
    for the cross-space injected-handle case (Q12).
11. **Finer invalidation.** Is coarse `reactOn: db` (whole-database) invalidation
    good enough for v1, or do we want table-level handle cells (dirtied per
    touched table) out of the box, parsed from the write SQL? Still open;
    `reactOn` already accepts a narrower cell the author bumps manually.
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

## Authorization of the SQLite verbs

18. **Per-resource authz for `sqlite.query`, the folded `sqlite` write op, and
    `sqlite.register-disk-source`.** These are gated only by "a session exists on
    this space" — the same bar as a normal read — and the write/registration
    paths carry no per-cell/per-row policy.
    - **Implemented defenses:** server-side DDL validation (no `sqlType`
      injection — C1); a `(space, id)`-keyed disk-source registry (no cross-space
      hijack — C2); and an injected disk path that must be absolute, must exist,
      is `realpath`-canonicalized, and is rejected if it resolves **inside** the
      engine store directory (no reading core/other-space `.sqlite` files).
    - **Chosen v1 model:** `cf` is a **trusted operator** (operator access), so
      `register-disk-source` is not yet gated to a distinct operator capability,
      and an injected on-disk path is otherwise unconfined (any readable host
      file the operator names).
    - **Follow-up:** observe **CFC labels** for per-resource authorization here
      (operator vs. pattern, per-row clearance), and confine on-disk sources to
      an operator allowlist directory. **TODO before relying on this in a
      multi-tenant VM:** review how `fuse` authorizes callables and what
      `cf-harness` does inside a VM, and align the SQLite verbs' authorization
      with that model.
    - **Related — forgeable `_cf_link` (review H1).** A stored `_cf_link` is an
      **absolute** sigil link (id + space + scope), and any writer to a cell-db
      can set a link column to point anywhere — including another space. A typed
      `db.query<Row>` decodes it to a live `Cell`. Decoding must **not** by
      itself confer cross-space read authority: the resolved target has to remain
      subject to the reader's normal cell read policy (the CFC work above). v1
      does not add a separate space-constraint at decode time (which could also
      break legitimate cross-space links); closing this is part of wiring read
      policy through `getCellFromLink` for SQLite-sourced links.

## Ergonomics / minor follow-ups

19. **Friendlier client-side "≤1 cell-db per commit" error.** The server enforces
    at most one cell-db per commit and rejects a second with a `ProtocolError`
    (Section [04](./04-server-execution-and-transactions.md)). Two `db.exec` calls
    to the *same* handle in one handler are fine; calls to *two different* dbs in
    one handler trip the limit only at commit time. A client-side assertion in the
    write seam (`recordSqliteWrite`) could surface this earlier with a clearer
    message. Nicety, not a correctness issue.
20. **Two schema paths disagree on the `SqliteDb` brand.** The schema-generator's
    object-formatter stamps `asCell: ["sqlite"]` for a `SqliteDb` field, but the
    ts-transformer's capability analysis (used for handler-state schemas) infers
    `asCell: ["readonly"]` from SqliteDb's read-only method surface — it does not
    recognize the "sqlite" brand. This is **benign today**: `db.exec` reaches the
    transaction via the materialized handle regardless of the wrapper brand
    (proven e2e), and `db.query` is build-time only. But the inconsistency is a
    latent trap; the capability analysis should learn the "sqlite" brand so both
    paths agree.
