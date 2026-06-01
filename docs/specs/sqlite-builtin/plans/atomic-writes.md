# Plan — Atomic SQLite writes (fold `sqlite` op into the cell commit)

**Status:** design / test-first. Read-only investigation; no feature code changed
yet.

**Goal.** Make a SQLite write land in the **same** memory-v2 commit transaction
as the cell writes around it, so a commit either lands fully (cells + rows) or
not at all. Today (`feat/sqlite-builtin-impl`) `sqliteExecute` runs as a
**separate RPC** (`sqlite.execute`) in a post-commit effect — outside the cell
commit, so cells + rows are **not** atomic.

This plan is the detailed, test-first elaboration of **Phase 2 / Milestone M2a**
in [`../implementation-plan.md`](../implementation-plan.md) (lines 139–190) and
the write half of spec [`../04-server-execution-and-transactions.md`](../04-server-execution-and-transactions.md)
("Writes: folded into `transact`", lines 105–143). It supersedes the
IMPLEMENTATION_LOG decision "Two RPC verbs now … not yet commit-folded".

---

## 0. What exists today (grounding, file:line)

The single SQLite transaction per commit already exists; the work is to route a
SQLite statement into it without corrupting the revision/head/snapshot/dirty
machinery that the loop is built around.

- **One transaction per commit.**
  `Engine.applyCommit`
  ([`packages/memory/v2/engine.ts:1510`](../../../packages/memory/v2/engine.ts))
  wraps `applyCommitTransaction` in
  `engine.database.transaction(applyCommitTransaction).immediate(engine, options)`.
  Everything inside that callback runs in one `BEGIN IMMEDIATE … COMMIT`.
- **The apply loop.** `applyCommitTransaction`
  ([`engine.ts:3068`](../../../packages/memory/v2/engine.ts)) iterates
  `commit.operations` (line 3191), calls `writeOperation` per op (line 3192),
  and pushes the returned `AppliedRevision` into `revisions[]` (line 3200).
  After the loop it:
  - `updateBranchHead` (3203),
  - `materializeSnapshots(engine, branch, revisions)` (3204),
  - `schedulerWriteAddressesForRevisions(space, revisions)` →
    `markSchedulerReadersDirtyForWrites` (3206–3217),
  - returns `{ seq, branch, revisions, … }` (3231).
- **`writeOperation`** ([`engine.ts:3241`](../../../packages/memory/v2/engine.ts))
  is a `switch (operation.op)` over `"set" | "patch" | "delete"` (line 3258);
  each case writes a row to `revision` + upserts `head` and returns an
  `AppliedRevision` (interface at [`engine.ts:711`](../../../packages/memory/v2/engine.ts):
  `{ id, scope?, scopeKey?, branch, seq, opIndex, commitSeq, op, document?, patches? }`).
- **Revisions are consumed by id/op/patches.**
  - `materializeSnapshots` ([`engine.ts:3823`](../../../packages/memory/v2/engine.ts))
    keys on `revision.id` + `revision.scopeKey` and calls
    `maybeMaterializeSnapshot`.
  - `schedulerWriteAddressesForRevisions` ([`engine.ts:3762`](../../../packages/memory/v2/engine.ts))
    reads `revision.op`, `revision.patches`, `revision.id`, `revision.scope`.
  - `AppliedCommit.revisions` is returned to the runner (used by
    `confirmPending`, [`runner storage v2.ts:1804`](../../../packages/runner/src/storage/v2.ts)
    — but `confirmPending` keys off the **operations the client sent**, not the
    returned revisions; it does not iterate `applied.revisions`).
  A `sqlite` op has **no entity id, scope, or revision row** → it must not enter
  `revisions[]`.
- **Server `transact`.** `Server.transact`
  ([`server.ts:822`](../../../packages/memory/v2/server.ts)) opens the engine
  (834), calls `Engine.applyCommit` (859), then `markSpaceDirty(space,
  message.commit.operations.map(op => toDirtyKey(op.id, declaredScope(op.scope))))`
  (872–881). That `.map` dereferences `op.id` — a `sqlite` op has none, so this
  must filter `sqlite` ops out.
- **ATTACH helpers** ([`packages/memory/v2/sqlite/exec.ts`](../../../packages/memory/v2/sqlite/exec.ts)):
  `aliasForDbId(id)` (15), `attachDatabase(db, alias, path)` (37) — **throws if
  `db.inTransaction`** (43), `detachDatabase` (53) — same guard (55),
  `ensureTables(db, tables, alias)` (105), `runWrite(db, sql, params)` (87,
  calls `assertWriteSafe`). The existing RPC path `Server.#onCellDb`
  ([`server.ts:642`](../../../packages/memory/v2/server.ts)) does
  attach → ensureTables → op → detach, **synchronously, one db at a time**, with
  `#cellDbPath(engine, space, id)` (672) giving the sibling/temp file.
- **Runner commit assembly.** A transaction's writes become
  `ClientCommit.operations` via `SpaceReplica.commitNative`
  ([`runner storage v2.ts:1221`](../../../packages/runner/src/storage/v2.ts)) →
  `commitOperations` (1488) → `buildCommit` (1504, maps to wire ops at 1509).
  The source is `NativeStorageCommit`
  ([`runner storage interface.ts:1176`](../../../packages/runner/src/storage/interface.ts):
  `{ operations, schedulerObservation? }`), built by
  `V2Transaction.getNativeCommit`
  ([`runner storage v2-transaction.ts:830`](../../../packages/runner/src/storage/v2-transaction.ts)).
- **The side-channel precedent.** The transaction already carries an
  out-of-band payload onto the commit: `setSchedulerObservation` /
  `getSchedulerObservation`
  ([`v2-transaction.ts:817`/`826`](../../../packages/runner/src/storage/v2-transaction.ts))
  store `#schedulerObservation`, which `getNativeCommit` copies into the native
  commit (832, 867). **This is the exact seam to reuse for `sqlite` ops.**
- **Optimistic apply.** `commitOperations` runs `applyPending(operation,
  localSeq)` for every operation **before** the server confirms
  ([`runner storage v2.ts:1552`](../../../packages/runner/src/storage/v2.ts)),
  and `applyPending` ([v2.ts:1795](../../../packages/runner/src/storage/v2.ts))
  does `this.record(id, scope).pending.push(...)`. A `sqlite` op has no
  client-side SQLite and no `id` → it must be **excluded from the optimistic
  path**.
- **Today's non-atomic builtin.** `sqliteExecute`
  ([`packages/runner/src/builtins/sqlite-builtins.ts:239`](../../../packages/runner/src/builtins/sqlite-builtins.ts))
  sets `pending`, then in `tx.enqueuePostCommitEffect` (290) calls
  `provider.sqliteExecute!(db, sql, params)` — a separate RPC **after** the cell
  commit. This is what we replace.

---

## 1. Design decisions

### 1.1 A `sqlite` op is not a revision — skip it in the loop (do NOT push a revision)

`writeOperation`'s `case "sqlite"` executes SQL and returns a sentinel that the
loop **does not** push into `revisions[]`. Concretely:

- Change the apply loop ([`engine.ts:3191`](../../../packages/memory/v2/engine.ts))
  so that `sqlite` ops are handled out-of-band of `revisions[]`. Two equivalent
  options; **prefer (a)** for the smallest blast radius:
  - **(a) Branch in the loop.** `if (operation.op === "sqlite") {
    applySqliteOperation(engine, operation, aliasMap); continue; }` before
    calling `writeOperation`. `writeOperation` keeps its current 3-case `switch`
    and its `AppliedRevision` return type unchanged.
  - **(b) Nullable return.** `writeOperation` gains `case "sqlite"` returning
    `null`; the loop does `if (revision) revisions.push(revision)`. Wider type
    churn (`AppliedRevision | null`) for no benefit — rejected.
- Net effect: `materializeSnapshots`, `schedulerWriteAddressesForRevisions`,
  `head`, `revision`, and the returned `AppliedCommit.revisions` **never see** a
  `sqlite` op. No `id`/`scope`/`patches` access on a row that lacks them.
- The commit `original` blob (encoded at [`engine.ts:3160`](../../../packages/memory/v2/engine.ts)
  `encodeMemoryBoundary(commit)`) **already persists the full `commit`**,
  including any `sqlite` ops, in the `commit` table — this satisfies the spec-04
  "persist the commit's `sqlite` ops in the commit record" requirement for free
  (Q7 / watermark groundwork). No new column needed.

### 1.2 ATTACH happens in `Server.transact`, before `Engine.applyCommit`

ATTACH/DETACH cannot run inside a transaction (`attachDatabase` enforces this,
[`exec.ts:43`](../../../packages/memory/v2/sqlite/exec.ts)), and
`applyCommit` opens the transaction. So `Server.transact` must, **before** line
859:

1. Scan `commit.operations` for `op === "sqlite"`; collect distinct `db` refs.
2. For each distinct db: `attachDatabase(engine.database,
   aliasForDbId(db.id), this.#cellDbPath(engine, space, db.id))` and, if
   `db.tables`, `ensureTables(engine.database, db.tables, alias)` (DDL is owned
   by the runtime and qualified by the internal alias — same as `#onCellDb`).
3. Build an **alias map** `Map<dbId, alias>` and pass it into `applyCommit` via a
   new optional field on `ApplyCommitOptions`
   ([`engine.ts:701`](../../../packages/memory/v2/engine.ts)), e.g.
   `sqliteAttachments?: ReadonlyMap<string, string>`. Thread it into
   `applyCommitTransaction` (destructure at [3068](../../../packages/memory/v2/engine.ts))
   and into the `sqlite` branch.
4. `try { commit = applyCommit(...) } finally { for (const alias of
   attached) detachDatabase(engine.database, alias) }` — detach **after** the
   transaction has committed or rolled back (the connection is idle again).

Refactor `Server.#onCellDb` and the new code to share a single
`#attachCellDb(engine, space, db)` helper that does
attach + ensureTables and returns the alias, so the attach/ensureTables logic is
not duplicated (CT-style "unify helper").

**The `sqlite` branch in the engine** does
`runWrite(engine.database, qualify(op.sql, aliasMap.get(op.db.id)), op.params)`.
Because the cell-db is the **only** attached db for this commit and `main` lacks
the pattern tables, an **unqualified** author statement resolves to it (SQLite:
`main → temp → attached-in-order`) — **no rewriting**, consistent with spec 04
("File boundary = namespace", lines 33–37). `runWrite` re-applies
`assertWriteSafe` inside the transaction (defense in depth; the client also
guards). DDL is never in the author statement (guard rejects it); table creation
already happened at attach time.

### 1.3 Multi-db within one commit (isolation rule)

The existing isolation rule is **attach one db at a time** so unqualified names
are unambiguous (IMPLEMENTATION_LOG "CROSS-DB AMBIGUITY"; `#onCellDb` doc
comment, [`server.ts:626`](../../../packages/memory/v2/server.ts)). A folded
commit could in principle carry `sqlite` ops for **>1** cell-db, which would
re-introduce ambiguity if all are attached simultaneously.

**V1 decision (pick one, recommend A):**

- **A. Reject multi-db commits (simplest, safe).** If a commit's `sqlite` ops
  reference more than one distinct `db.id`, throw a `ProtocolError`
  ("a commit may write to at most one SQLite database"). A single handler
  writing to one table is the overwhelmingly common case; this preserves the
  unambiguous-unqualified-name invariant with zero new machinery. Document the
  limit; revisit if a real pattern needs cross-db atomicity.
- **B. Qualify every folded statement with its alias.** Attach all referenced
  dbs, and have the engine **prefix** the author's table token with the alias
  (`INSERT INTO cf_x.messages …`). This needs a tokenizer rewrite (the very
  thing spec 04 avoids) and the author guard rejects qualified refs, so the
  rewrite must run *after* the guard on a trusted, internal qualification.
  Higher risk — defer.

Recommend **A** for this milestone; note B as the future multi-db path. (One db
== two schemas is still fine: a single attach, multiple statements against the
same alias.)

### 1.4 Runner: carry the `sqlite` op on the transaction (reuse the observation seam)

Mirror `setSchedulerObservation`:

- **`v2-transaction.ts`** — add `#sqliteOps: SqliteOperation[] = []`, a
  `recordSqliteWrite(op)` method (asserts writable, like
  `setSchedulerObservation` at [817](../../../packages/runner/src/storage/v2-transaction.ts)),
  and in `getNativeCommit` ([830](../../../packages/runner/src/storage/v2-transaction.ts))
  append them to the native commit's operations (or carry on a parallel
  `sqliteOps` field — see below). Add `recordSqliteWrite` to
  `IExtendedStorageTransaction`
  ([`storage/interface.ts`](../../../packages/runner/src/storage/interface.ts),
  near `setSchedulerObservation`).
- **`storage/interface.ts`** — extend `NativeStorageCommit`
  ([1176](../../../packages/runner/src/storage/interface.ts)) with
  `sqliteOps?: readonly SqliteOperation[]` (keep it off `operations[]` so the
  existing `operations.filter(type === DOCUMENT_MIME)` normalize at
  [v2.ts:1232](../../../packages/runner/src/storage/v2.ts) is untouched), OR add
  a `"sqlite"` variant to `NativeStorageCommitOperation`
  ([1153](../../../packages/runner/src/storage/interface.ts)). **Prefer a
  separate `sqliteOps` field**: it keeps the optimistic-apply / dirty-key code
  (which assumes every op has an `id`) from ever seeing a `sqlite` op, and is the
  least invasive (decision 1.6).
- **`storage/v2.ts` `commitNative`** ([1221](../../../packages/runner/src/storage/v2.ts))
  — read `transaction.sqliteOps`, append them (ordered **last**, per spec 04
  line 150) to the `operations` array passed to `commitOperations`, but **tag
  them so `applyPending` skips them** (decision 1.6). The
  `operations.length === 0` early-return (1257) must treat a commit with only
  `sqlite` ops as non-empty.
- **`commitOperations` `buildCommit`** ([1504](../../../packages/runner/src/storage/v2.ts))
  — emit the `sqlite` wire op (`{ op: "sqlite", db, sql, params }`) into
  `ClientCommit.operations` (last).
- **Builtin `sqliteExecute`** ([sqlite-builtins.ts:239](../../../packages/runner/src/builtins/sqlite-builtins.ts))
  — replace the `enqueuePostCommitEffect` RPC (290–315) with
  `tx.recordSqliteWrite({ op: "sqlite", db, sql, params: encodedParams })`
  **inside the action**, so the op rides the same transaction's commit. The
  result cell can no longer carry server `{ changes, lastInsertRowid }` from a
  separate RPC; instead set `{ pending: false, requestHash }` once the op is
  recorded (the write's success is the commit's success). If the
  `changes`/`lastInsertRowid` return value is needed by patterns, surface it via
  `AppliedCommit` (the engine `sqlite` branch can stash per-op results on the
  returned commit) — **defer unless a test needs it**; record as a follow-up.

### 1.5 Optimistic apply — skip `sqlite` ops on the client

The client has no SQLite. The runner must **not** call `applyPending` for a
`sqlite` op (it would crash on the missing `id`, and there is nothing to apply).

- In `commitOperations`' `applyPending` loop
  ([v2.ts:1552–1556](../../../packages/runner/src/storage/v2.ts)) skip ops with
  `op === "sqlite"` (or, cleaner, keep `sqlite` ops out of the `operations[]`
  used for `applyPending`/`confirmPending`/`touched`/notification and only merge
  them into the **wire** `ClientCommit.operations` in `buildCommit`). The latter
  is the reason decision 1.4 prefers a separate `sqliteOps` field: `applyPending`,
  `confirmPending` ([1804](../../../packages/runner/src/storage/v2.ts)),
  `dropPending`, `touched`/sink notifications, and `buildReads` all iterate
  `operations[]` and assume `id`/`scope`.
- Net: optimistic local state never reflects the SQLite write; it appears only
  after the server confirms the commit (consistent with spec Phase 3 "queries
  re-run after committed writes, never on optimistic state").

### 1.6 Read-after-write within the same transaction stays unsupported

Spec 04 (lines 145–154) says a `sqlite.query` issued in a transaction that has
pending uncommitted `sqlite` writes must fail with `read-after-write-unsupported`.

- **In scope for this milestone: confirm nothing breaks.** The current
  `sqliteQuery` builtin issues its read as a **separate RPC in a post-commit
  effect** ([sqlite-builtins.ts:201](../../../packages/runner/src/builtins/sqlite-builtins.ts)),
  i.e. after the commit — so there is no in-transaction read of a pending write
  to break. Folding writes does **not** introduce one.
- The explicit `read-after-write-unsupported` guard (tracking pending-writes per
  db on the transaction and rejecting an in-tx query) is **Phase 2 item 3** and
  can land with this work or immediately after; it is a guard, not a correctness
  prerequisite for atomicity. Note it as a small follow-up so reviewers don't
  assume it is already enforced.

---

## 2. Staged change list (file:line)

**Stage 1 — protocol type (memory).**
- [`packages/memory/v2.ts:89`](../../../packages/memory/v2.ts) — add
  `SqliteOperation { op: "sqlite"; db: SqliteDbRef; sql: string; params?:
  SqliteParamsWire }` and widen `Operation` to include it. (`SqliteDbRef` /
  `SqliteParamsWire` already exist, [v2.ts:297, 301](../../../packages/memory/v2.ts).)
  Update `parseClientMessage`'s transact bounds-checks
  ([server.ts ~1837](../../../packages/memory/v2/server.ts)) to cap `sql` length
  / validate `sqlite` ops the same way the existing verbs are capped.

**Stage 2 — engine apply (memory).**
- [`engine.ts:701`](../../../packages/memory/v2/engine.ts) `ApplyCommitOptions` —
  add `sqliteAttachments?: ReadonlyMap<string, string>` (dbId → alias).
- [`engine.ts:3068`](../../../packages/memory/v2/engine.ts)
  `applyCommitTransaction` — destructure `sqliteAttachments`; in the op loop
  ([3191](../../../packages/memory/v2/engine.ts)) handle `op === "sqlite"` via a
  new `applySqliteOperation(engine, op, alias)` and `continue` (decision 1.1).
  Update the empty-operations / scheduler-batch guards (3087–3097) so a commit
  with only `sqlite` ops is valid (it is not a scheduler-only commit).
- `applySqliteOperation` (new, near `writeOperation`) — look up `alias =
  sqliteAttachments.get(op.db.id)`, throw a clear `ProtocolError` if missing
  (means `Server.transact` didn't attach — invariant), then
  `runWrite(engine.database, op.sql, op.params)` (the db is the only attachment;
  unqualified names resolve to it). Optionally advance a `_cf_commit_watermark`
  row in the attached db (Q7 groundwork — see §4).

**Stage 3 — server attach/detach + transact (memory).**
- [`server.ts:822`](../../../packages/memory/v2/server.ts) `Server.transact` —
  before `applyCommit` (859): scan `commit.operations` for `sqlite` ops, enforce
  the ≤1-db rule (decision 1.3.A), attach + ensureTables each via a shared
  `#attachCellDb` helper, build the alias map, pass as
  `sqliteAttachments`; wrap `applyCommit` in `try/finally` that detaches.
- [`server.ts:872`](../../../packages/memory/v2/server.ts) `markSpaceDirty` —
  filter out `sqlite` ops before `.map(op => toDirtyKey(op.id, …))` (a `sqlite`
  op has no `id`). Marking the **handle cell** dirty for reactivity is Phase 3,
  not this milestone.
- Refactor `#onCellDb` ([642](../../../packages/memory/v2/server.ts)) to reuse
  `#attachCellDb` (unify; the RPC `sqlite.execute` path can remain for the
  not-yet-migrated read verb and as a transitional fallback).

**Stage 4 — runner transaction seam.**
- [`storage/interface.ts:1176`](../../../packages/runner/src/storage/interface.ts)
  — `NativeStorageCommit.sqliteOps?: readonly SqliteOperation[]`; add
  `recordSqliteWrite` to `IExtendedStorageTransaction`.
- [`storage/v2-transaction.ts:817`](../../../packages/runner/src/storage/v2-transaction.ts)
  — `#sqliteOps`, `recordSqliteWrite`, include in `getNativeCommit`
  ([830](../../../packages/runner/src/storage/v2-transaction.ts)).
- [`storage/v2.ts:1221`](../../../packages/runner/src/storage/v2.ts)
  `commitNative` — carry `sqliteOps` through; treat a `sqliteOps`-only commit as
  non-empty (1257). Keep them out of the `operations[]` used for
  `applyPending`/`confirmPending`/notify; merge into wire
  `ClientCommit.operations` (last) in `buildCommit`
  ([1509](../../../packages/runner/src/storage/v2.ts)).

**Stage 5 — runner builtin.**
- [`builtins/sqlite-builtins.ts:239`](../../../packages/runner/src/builtins/sqlite-builtins.ts)
  `sqliteExecute` — replace the post-commit RPC (290–315) with
  `tx.recordSqliteWrite({ op: "sqlite", db, sql, params: encodedParams })`;
  set the result cell to `{ pending: false, requestHash }` on record. Keep the
  committed-state dedup (286). Update the file header note (currently says
  "writes are a separate RPC, not folded").

**Stage 6 — read-after-write guard (small follow-up, may defer).**
- Track per-db pending writes on the transaction; reject an in-tx `sqlite.query`
  with `read-after-write-unsupported` (spec 04). Today's query is a post-commit
  effect, so this is additive hardening, not a blocker.

---

## 3. First deterministic failing test (engine layer first)

Write at the **engine layer** — the lowest level that exercises the one-commit
transaction — then add a server-loopback test. Engine tests already drive
`applyCommit(engine, {...})` and read back via `read(engine, {...})`
([`packages/memory/test/v2-engine-test.ts:87,129`](../../../packages/memory/test/v2-engine-test.ts)).

New file: `packages/memory/test/v2-sqlite-atomic-test.ts`. It must fail today
(no `sqlite` op kind; no attach plumbing on `applyCommit`) and pass after the
change.

```ts
import { assertEquals, assertThrows } from "@std/assert";
import { toFileUrl } from "@std/path";
import { applyCommit, open, read } from "../v2/engine.ts";
import { aliasForDbId, attachDatabase, detachDatabase, ensureTables, runQuery }
  from "../v2/sqlite/exec.ts";
import { table } from "../v2/sqlite/schema.ts";

// Drive applyCommit with BOTH a cell op and a sqlite op, sharing one txn.
async function freshEngine() {
  const path = await Deno.makeTempFile({ suffix: ".sqlite" });
  return { engine: await open({ url: toFileUrl(path) }), path };
}

const DB_ID = "of:atomic-db";
const TABLES = { messages: table({ id: "integer primary key", body: "text" }) };

Deno.test("commit with a cell op + a sqlite op lands both atomically", async () => {
  const { engine } = await freshEngine();
  const alias = aliasForDbId(DB_ID);
  // The server attaches before applyCommit; the test stands in for that step.
  attachDatabase(engine.database, alias, await Deno.makeTempFile({ suffix: ".sqlite" }));
  ensureTables(engine.database, TABLES, alias);
  try {
    applyCommit(engine, {
      sessionId: "session:a",
      principal: "did:key:alice",
      space: "did:key:space",
      sqliteAttachments: new Map([[DB_ID, alias]]),   // NEW option
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [
          { op: "set", id: "entity:c", value: { value: { ok: true } } },
          { op: "sqlite", db: { id: DB_ID, tables: TABLES },          // NEW op kind
            sql: "INSERT INTO messages (body) VALUES (?)", params: ["hi"] },
        ],
      },
    });
    // Cell landed:
    assertEquals(read(engine, { id: "entity:c" }), { value: { ok: true } });
    // Row landed in the SAME committed db:
    assertEquals(runQuery(engine.database, "SELECT body FROM messages"),
      [{ body: "hi" }]);
  } finally { detachDatabase(engine.database, alias); }
});

Deno.test("a failing commit rolls back BOTH the cell and the row", async () => {
  const { engine } = await freshEngine();
  const alias = aliasForDbId(DB_ID);
  attachDatabase(engine.database, alias, await Deno.makeTempFile({ suffix: ".sqlite" }));
  ensureTables(engine.database, TABLES, alias);
  try {
    // Force a failure AFTER the sqlite write within the same txn. Cleanest
    // deterministic trigger: a SECOND sqlite op whose SQL violates the guard
    // (assertWriteSafe throws inside applySqliteOperation) — ordered after a
    // good INSERT, so the engine has already executed the row write when it
    // throws and must roll the whole txn back.
    assertThrows(() =>
      applyCommit(engine, {
        sessionId: "session:a",
        principal: "did:key:alice",
        space: "did:key:space",
        sqliteAttachments: new Map([[DB_ID, alias]]),
        commit: {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [
            { op: "set", id: "entity:c", value: { value: { ok: true } } },
            { op: "sqlite", db: { id: DB_ID }, sql:
              "INSERT INTO messages (body) VALUES (?)", params: ["hi"] },
            { op: "sqlite", db: { id: DB_ID }, sql: "DROP TABLE messages" }, // guard throws
          ],
        },
      })
    );
    // Neither side committed:
    assertEquals(read(engine, { id: "entity:c" }), null);
    assertEquals(runQuery(engine.database, "SELECT count(*) AS n FROM messages"),
      [{ n: 0 }]);
  } finally { detachDatabase(engine.database, alias); }
});
```

Why this is the right first test:
- It exercises the **actual atomic boundary** (`applyCommit`'s `.immediate()`
  txn), not a proxy. The rollback case proves the row write participates in the
  same `BEGIN…COMMIT`: a throw after the INSERT rolls back the INSERT **and** the
  cell `set`.
- It is deterministic: no scheduler, no websocket, no reactivity. The forced
  failure is a guard throw on a trailing op, which is in-txn and synchronous.
- The alternative forced-failure trigger is a **seq conflict** (a stale
  `reads.confirmed` entry → `ConflictError` in `validateConfirmedReads`,
  [engine.ts:3353](../../../packages/memory/v2/engine.ts)) which throws *before*
  any write; that proves "nothing lands" but not "the row was written then rolled
  back". Prefer the trailing-guard-throw variant for a true post-write rollback,
  and optionally add the seq-conflict variant too (matches implementation-plan
  line 185 "a rejected commit (seq conflict) leaves neither").

**Second test (server loopback):** extend
[`packages/memory/test/v2-sqlite-protocol-test.ts`](../../../packages/memory/test/v2-sqlite-protocol-test.ts)
or add `v2-sqlite-atomic-protocol-test.ts`: build a `TransactRequest` whose
`commit.operations` contains a cell `set` + a `sqlite` op, send via
`session.transact(commit)`, then assert the cell is readable (`graph.query` /
watch) **and** `session.sqliteQuery(db, …)` returns the row. This proves the
attach-before-`applyCommit` plumbing in `Server.transact` end to end over the
loopback transport (same harness as the existing protocol test, lines 35–45).

**Third (runner):** a builtin/pattern test that a handler doing a cell write +
`sqliteExecute` produces both after commit — last, since it depends on scheduler
settling (the IMPLEMENTATION_LOG flagged cross-effect reactivity as flaky;
keep this test to the deterministic single-commit shape).

---

## 4. WAL atomicity caveat (cross-file) & Q7 watermark

- The engine runs `PRAGMA journal_mode = WAL` (`PRAGMAS`,
  [`engine.ts`](../../../packages/memory/v2/engine.ts)). The main space db and the
  attached cell-db are **separate files**. A shared-connection `BEGIN…COMMIT`
  gives **normal-operation** atomicity (no-crash path: both files' frames are
  written under one logical commit), but **cross-file atomicity is NOT guaranteed
  across a crash mid-COMMIT** — one file's WAL frame may be durable while the
  other's is not (spec 04 lines 156–168; Q7 in
  [`../08-open-questions.md`](../08-open-questions.md) lines 53–64).
- **In scope for this milestone:** normal-operation atomicity (the failing test
  above proves it). The crash-window mitigation — `_cf_commit_watermark(seq)`
  written inside the commit txn + persisting the commit's `sqlite` ops, then
  **detect + quarantine** on open if watermark ≠ committed `seq` — is spec
  **Phase 6**, and the implementation-plan explicitly lands two of its pieces
  early in Phase 2 (lines 286–295).
  - The "persist the commit's `sqlite` ops" half is **already satisfied**: the
    `commit` row stores `encodeMemoryBoundary(commit)` (the whole `ClientCommit`,
    [engine.ts:3160,3186](../../../packages/memory/v2/engine.ts)), which includes
    `sqlite` ops. No migration needed.
  - The watermark write (advancing a `_cf_commit_watermark` row in the attached
    db inside `applySqliteOperation`) is a **1–2 line addition** to this work and
    is recommended to land here so Phase 6's detect/quarantine needs no schema
    migration later. The **detect-on-open + quarantine** logic itself is
    **deferred** to Phase 6 (out of scope here) — note it clearly so reviewers
    don't expect crash recovery from this milestone.

---

## 5. Risks, rollback boundary, augmentation

**Rollback boundary (correctness).** The atomic unit is exactly
`engine.database.transaction(applyCommitTransaction).immediate(...)`
([engine.ts:1514](../../../packages/memory/v2/engine.ts)). ATTACH/DETACH sit
**outside** it (in `Server.transact`); the cell-db file persists across detach.
Because the cell-db is attached to the same connection for the duration of the
txn, its writes are inside the `BEGIN…COMMIT` and roll back with the cell
revisions. A throw anywhere in the op loop (guard violation, conflict, SQL
error) aborts the whole transaction → no `head`/`revision` rows, no SQLite row.

**Risks.**
- **`id`-assuming code paths.** `markSpaceDirty` (server, 872),
  `applyPending`/`confirmPending`/`dropPending`/`touched`/`buildReads` (runner)
  all assume every op has an `id`. **Mitigation:** keep `sqlite` ops on a
  separate `sqliteOps` channel (decision 1.4/1.6) and only merge into the wire
  `operations[]` at `buildCommit`; filter in `markSpaceDirty`. This is the single
  biggest correctness risk and the reason for the channel split.
- **ATTACH inside a txn.** If any code attaches after `BEGIN`, `attachDatabase`
  throws ([exec.ts:43](../../../packages/memory/v2/sqlite/exec.ts)). Guaranteed
  avoided by attaching in `Server.transact` before `applyCommit`. The
  `applySqliteOperation` branch must **not** attach.
- **Multi-db ambiguity.** Mitigated by the ≤1-db rule (decision 1.3.A); enforce
  with a `ProtocolError` and a test.
- **Lost write-result.** Folding removes the per-call `{ changes,
  lastInsertRowid }` the separate RPC returned. If a pattern reads it, surface it
  via `AppliedCommit`; otherwise the result cell just reflects commit success.
  Flag as a follow-up; don't block atomicity on it.
- **Direct-write path.** `Server.writeDocument`
  ([server.ts:596](../../../packages/memory/v2/server.ts)) and the
  scheduler-observation commit paths also call `applyCommit`; they never carry
  `sqlite` ops, so the new optional `sqliteAttachments` defaults to
  empty/undefined and they are unaffected. Verify no caller breaks on the new
  optional field (it is optional → safe).

**How this augments `implementation-plan.md`.** This document is the test-first,
file:line expansion of **Phase 2 (M2a)** (plan lines 139–190). It (a) pins the
"`sqlite` op is not a revision" decision to the **skip-in-loop / separate-channel**
design, (b) specifies the **attach-in-`transact` + alias-map** plumbing the plan
left implicit ("ensure the db is ATTACHed … already inside the open transaction"
is *not* literally possible — ATTACH must precede `BEGIN`; this plan corrects
that), (c) reuses the **`setSchedulerObservation` seam** for the runner side
rather than extending `commitOperations` directly, and (d) carries the **Q7
watermark write** forward (Phase 6 groundwork) while deferring detect/quarantine.
Phase 3 (reactivity: mark the handle cell dirty) and the explicit
read-after-write guard remain separate follow-ups noted above.

---

## 6. Implementation note — Stages 1–3 landed; Stage 5 contract finding

Stages 1–3 (engine + server) are implemented and tested (engine-layer atomicity
+ rollback; server-loopback folded commit + rollback). See IMPLEMENTATION_LOG.

**Stage 5 contract decision (surfaced during implementation, not in §1–§5):**
folding `sqliteExecute` into the commit removes the synchronous write result —
`applyCommit` returns `seq`/revisions, not SQLite `changes`/`lastInsertRowid`.
Before wiring Stage 5, choose:
- **(a)** thread results: `applySqliteOperation` returns `{changes,
  lastInsertRowid}`, collect into a new `AppliedCommit.sqliteResults` (indexed by
  op), return through `Server.transact` → runner; the builtin writes them to its
  result cell. Preserves today's `sqliteExecute` contract.
- **(b)** drop counts: the folded `sqliteExecute` reports only `{pending:false}`
  on commit success (success ⇔ commit success). Simpler; changes the
  `sqliteExecute` result shape and its test.

Recommend (a) if any pattern needs `changes`/`lastInsertRowid`; otherwise (b).
