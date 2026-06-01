# Plan — `sqliteExecute` as a commit-folded imperative write (`db.exec` semantics)

> ## STATUS (2026-06-01)
>
> **Stage 1 (storage seam) — DONE + green (commit d10d37952).** The runner now
> folds a SQLite write into the commit atomically with cell ops:
> `IStorageTransaction.recordSqliteWrite(space, op)` + `NativeStorageCommit.sqliteOps`
> (interface.ts); `#sqliteOps` stash + `recordSqliteWrite` (claims write space) +
> `getNativeCommit` emission + relaxed empty-commit guards (v2-transaction.ts);
> `commitNative`/`commitOperations` thread `sqliteOps` into `ClientCommit.operations`
> **last**, kept out of doc-pending/touched/notify (v2.ts); both tx wrappers
> delegate (extended-storage-transaction.ts). Tests: `sqlite-commit-fold.test.ts`
> (cell+INSERT atomic, sqlite-only commit, failure rolls back the sibling cell
> write). **Full runner suite 501/0.**
>
> **User decisions locked (this session):** imperative-only (no declarative
> pattern-body write path); **no `reactOn` re-run** after a folded write (no `rev`
> bump); **throw on read-after-write** in the same uncommitted tx rather than make
> pending writes synchronously visible.
>
> **Stage 2 (rewrite `sqliteExecute` as imperative `db.exec`) — NOT STARTED.**
> Deferred from Stage 1 because it's a sprawling cross-layer rewrite best done
> fresh (a half-done version breaks the compile). Notes for the next session:
> - **tx access confirmed:** in a handler, `db` is a tx-bound proxy; recover the
>   cell (`toCell`/`asCellOrUndefined`) and call
>   `cell.tx.recordSqliteWrite(cell.space, {op:"sqlite", db: readDbRef(cell.get()), sql, params: encodeParams(sql, params)})`.
>   No runtime ref needed.
> - **layering hazard (solve first):** the imperative `sqliteExecute` is a runtime
>   op but must be exposed on the `cf` builder object. `built-in.ts` (builder)
>   makes it via `createNodeFactory` today; a plain fn needs runtime helpers from
>   `builtins/sqlite-builtins.ts`, which imports `builder/types.ts` — a potential
>   value-level import cycle. Put the imperative fn in a leaf module (e.g.
>   `builtins/sqlite/execute.ts`) depending only on `cell.ts` + `sqlite/cf-link.ts`
>   + memory types, and re-export from `built-in.ts`. Verify no cycle.
> - **"throw on read-after-write":** no synchronous in-handler read API exists
>   today (reads are the reactive `sqliteQuery` node via post-commit RPC), so the
>   scenario isn't reachable; add the guard if/when a sync read is introduced.
> - **removal + test churn:** drop the reactive node/result cell/RPC/`rev` bump
>   (§6); flip the registry entry to `reactiveOrigin:false`; tests that call
>   `cf.sqliteExecute({...})` declaratively (`sqlite-builtins.test.ts`,
>   `sqlite-cf-link-decode.test.ts`) move to handler calls or drive via
>   `tx.recordSqliteWrite`. `sqlite-cf-link-roundtrip.test.ts` uses
>   `provider.sqliteExecute!` and is unaffected.
> - **Stage 1 is independent and shippable on its own.**

---

**Status:** design / test-first. Stage 1 implemented (see STATUS); Stage 2
pending. Every file:line below was opened and read in the
`feat/sqlite-builtin-impl` worktree.

## 0. Decision and how it differs from the prior plan

**Decided design (this doc):** replace the reactive `sqliteExecute` *node* with a
**synchronous, handler-callable** write that records a `sqlite` op onto the
**caller's (handler's) transaction**, so the SQL write commits **atomically with
the surrounding cell writes** (one commit = cell ops + one sqlite op). On SQL
failure the **whole commit aborts** (abort-only): **no** pending/success/error
result cell, **no** return value, **no** `db.rev` bump, **no** post-commit RPC.
`sqliteQuery` (reactive read) is unchanged.

**This is option (b) from
[`atomicity-handler-model.md`](./atomicity-handler-model.md) §2/§3.4**, *not*
option (c). The prior plan recommended (c) — keep the reactive node, fold the op
into the *effect node's own* commit, keep the `{pending,result,error}` result
cell, thread `changes/lastInsertRowid` via `AppliedCommit.sqliteResults`, keep
the `rev` bump. **This plan deliberately supersedes that recommendation** for the
`sqliteExecute` write surface:

| Aspect | `atomicity-handler-model.md` (c) | This plan (b) |
| --- | --- | --- |
| Atomic unit | effect node's own commit | the **handler's** commit (cell ops + sqlite op) |
| Handler+row atomicity | explicit **non-goal** | **the goal** |
| Result cell | kept (`pending/result/error`) | **removed** |
| Return value (`changes`/`lastInsertRowid`) | threaded via `AppliedCommit.sqliteResults` | **none** (out of scope) |
| `db.rev` bump for `reactOn` | kept (folded) | **removed** (writes no longer reactive-origin) |
| Reactive node | kept | **removed** |

The §3.4 viability claim ("the runtime exposes the current action tx to builder
primitives the same way cell `.set()` reaches it") is **verified concretely** in
§2 below: a handler's `db` argument is a query-result proxy whose `toCell` back-
pointer mints a `Cell` bound to the **handler's tx**
([`query-result-proxy.ts:227-229`](../../../../packages/runner/src/query-result-proxy.ts)),
and `Cell` exposes that tx as `cell.tx`
([`cell.ts:346`](../../../../packages/runner/src/cell.ts)). So the ambient tx is
reachable. **This is the riskiest unknown and it checks out** (§2, §6).

The engine + server + wire halves are **already built and tested** and need **no
change**: `SqliteOperation` is in the `Operation` union
([`memory/v2.ts:95-106`](../../../../packages/memory/v2.ts)); `applyCommit`
applies it inside the one commit txn
([`engine.ts:3202-3219,3265-3277`](../../../../packages/memory/v2/engine.ts));
the server attaches the cell-db before `applyCommit` and filters sqlite ops out
of `markSpaceDirty`
([`server.ts:676-711,904-948`](../../../../packages/memory/v2/server.ts));
covered by [`v2-sqlite-atomic-test.ts`](../../../../packages/memory/test/v2-sqlite-atomic-test.ts).

---

## 1. Architecture — the tx → commit → wire trace and the three insertion points

### 1.1 Current path (cell DOC writes only)

A handler/action runs against a single `tx` (`runtime.edit()`), writes cells,
then `tx.commit()`:

- **Handler tx + single commit:** event handler mints `const tx =
  state.runtime.edit(); tx.tx.immediate = true;`
  ([`scheduler/events.ts:429-430`](../../../../packages/runner/src/scheduler/events.ts)),
  runs `handler(tx, event)`, then `tx.commit()`
  ([`events.ts:501`](../../../../packages/runner/src/scheduler/events.ts)). One
  handler invocation = one commit.
- **commit() → getNativeCommit:** `V2Transaction.commit()` calls
  `this.getNativeCommit(writeSpace)`
  ([`storage/v2-transaction.ts:1453-1456`](../../../../packages/runner/src/storage/v2-transaction.ts)),
  early-returns `{ok:{}}` if `operations.length === 0 && !hasSchedulerObservation`
  ([`:1457-1463`](../../../../packages/runner/src/storage/v2-transaction.ts)),
  then `replica.commitNative(native!, this)`
  ([`:1477-1485`](../../../../packages/runner/src/storage/v2-transaction.ts)).
- **getNativeCommit builds `NativeStorageCommitOperation[]` from changed docs
  only:**
  [`v2-transaction.ts:830-869`](../../../../packages/runner/src/storage/v2-transaction.ts)
  iterates `branch.docs`, emits one `set`/`patch`/`delete` per changed writable
  doc, and copies `schedulerObservation` onto the returned `NativeStorageCommit`
  ([`:865-868`](../../../../packages/runner/src/storage/v2-transaction.ts)).
  `NativeStorageCommit` = `{ operations; schedulerObservation? }`
  ([`storage/interface.ts:1176-1179`](../../../../packages/runner/src/storage/interface.ts));
  `NativeStorageCommitOperation` is the runner's OWN op union (set/delete/patch,
  each with `id`/`type`/`scope`)
  ([`interface.ts:1153-1174`](../../../../packages/runner/src/storage/interface.ts)).
- **commitNative normalizes → commitOperations → ClientCommit:**
  `SpaceReplica.commitNative`
  ([`storage/v2.ts:1221-1265`](../../../../packages/runner/src/storage/v2.ts))
  filters `operation.type === DOCUMENT_MIME`
  ([`:1232`](../../../../packages/runner/src/storage/v2.ts)) and maps to the local
  `NativeCommitOperation` ([`v2.ts:925-934`](../../../../packages/runner/src/storage/v2.ts)),
  then `commitOperations(operations, source, schedulerObservation)`
  ([`:1261-1263`](../../../../packages/runner/src/storage/v2.ts)).
- **buildCommit (the wire `Operation[]`):** `commitOperations`
  ([`v2.ts:1488`](../../../../packages/runner/src/storage/v2.ts)) early-returns if
  `operations.length === 0` (unless a scheduler observation)
  ([`:1493-1501`](../../../../packages/runner/src/storage/v2.ts)); otherwise builds
  the `ClientCommit` under the `["commitOperations","buildCommit"]` timing label
  ([`:1503-1531`](../../../../packages/runner/src/storage/v2.ts)), mapping each
  `NativeCommitOperation` to a wire `Operation` (`delete`/`patch`/`set`)
  ([`:1509-1528`](../../../../packages/runner/src/storage/v2.ts)). `ClientCommit`
  and the wire `Operation` union (incl. `SqliteOperation`) are in
  [`memory/v2.ts:95-149`](../../../../packages/memory/v2.ts).
- **wire → server:** `pushCommit` → `session.transact(commit)`
  ([`v2.ts:1591-1614`](../../../../packages/runner/src/storage/v2.ts)).
- **server apply (already handles sqlite):** `#attachCommitSqliteDbs`
  ([`server.ts:676-711`](../../../../packages/memory/v2/server.ts)) attaches the
  cell-db(s) referenced by `op.op === "sqlite"` (≤1 per commit) BEFORE
  `applyCommit` ([`server.ts:904-919`](../../../../packages/memory/v2/server.ts));
  `applyCommit` runs ops in array order and routes `op === "sqlite"` to
  `applySqliteOperation` (no revision)
  ([`engine.ts:3202-3219,3265-3277`](../../../../packages/memory/v2/engine.ts));
  `markSpaceDirty` filters sqlite ops out
  ([`server.ts:929-933`](../../../../packages/memory/v2/server.ts)).

### 1.2 The seam is missing on the runner

`grep` for `recordSqliteWrite` / `sqliteOps` in `packages/runner/src/` returns
**nothing**. There is no way today to fold a sqlite op into a runner commit. The
current `sqliteExecute` does its write in a **separate, post-commit RPC** —
`tx.enqueuePostCommitEffect(...)` → `flush()` → `provider.sqliteExecute!(...)`
RPC inside a fresh `runtime.editWithRetry`
([`builtins/sqlite-builtins.ts:301-333`](../../../../packages/runner/src/builtins/sqlite-builtins.ts)).
The engine atomicity is therefore currently **unused by the runner**.

### 1.3 The three insertion points (decided design)

Mirror the `schedulerObservation` side channel
([`v2-transaction.ts:817-828,865-868`](../../../../packages/runner/src/storage/v2-transaction.ts);
[`interface.ts:549-550`](../../../../packages/runner/src/storage/interface.ts)).
Keep the sqlite op a **separate field**, never inside `operations[]`, so no
`id`-assuming path (`applyPending`/`confirmPending`/`dropPending`/`touched`/
`buildReads`/`buildPatchOperation`) ever sees an idless op.

**(a) Stash on the transaction** — `storage/interface.ts` +
`storage/v2-transaction.ts`:
- `interface.ts`: add to `IStorageTransaction` (next to
  `setSchedulerObservation`, [:549](../../../../packages/runner/src/storage/interface.ts))
  an optional `recordSqliteWrite?(op: SqliteOperation): void;`, and add
  `sqliteOps?: readonly SqliteOperation[];` to `NativeStorageCommit`
  ([:1176-1179](../../../../packages/runner/src/storage/interface.ts)). Re-export
  / import `SqliteOperation` from `@commonfabric/memory/v2`.
- `v2-transaction.ts`: add `#sqliteOps: SqliteOperation[] = []`;
  `recordSqliteWrite(op)` asserts writable exactly like `setSchedulerObservation`
  ([`:817-823`](../../../../packages/runner/src/storage/v2-transaction.ts)) and
  pushes onto `#sqliteOps`. The single-write rule (server enforces ≤1 cell-db per
  commit, [`server.ts:687-690`](../../../../packages/memory/v2/server.ts)) can be
  asserted here too for a friendlier client-side error.

**(b) Emit from getNativeCommit** —
`v2-transaction.ts:830-869`: in the same place it copies
`schedulerObservation` ([:865-868](../../../../packages/runner/src/storage/v2-transaction.ts)),
also return `...(this.#sqliteOps.length ? { sqliteOps: [...this.#sqliteOps] } : {})`.
**Crucially, the `commit()` early-return guard** at
[`v2-transaction.ts:1457-1463`](../../../../packages/runner/src/storage/v2-transaction.ts)
(`operations.length === 0 && !hasSchedulerObservation`) **must also treat a
`sqliteOps`-only commit as non-empty** — otherwise a handler that ONLY does a
sqlite write (no cell write) silently drops it. Same guard in `commitNative`
([`v2.ts:1257`](../../../../packages/runner/src/storage/v2.ts)) and
`commitOperations` ([`v2.ts:1493`](../../../../packages/runner/src/storage/v2.ts)).

**(c) Map to wire SqliteOperation in buildCommit** —
`v2.ts`: `commitNative` ([:1221-1264](../../../../packages/runner/src/storage/v2.ts))
currently drops everything non-`DOCUMENT_MIME` via the
[:1232](../../../../packages/runner/src/storage/v2.ts) filter and passes only the
doc `NativeCommitOperation[]` to `commitOperations`. Thread
`transaction.sqliteOps` through (a new param to `commitOperations`, or read it in
`buildCommit`), and in `buildCommit`
([:1503-1531](../../../../packages/runner/src/storage/v2.ts)) **append**
`...sqliteOps.map((o) => ({ op: "sqlite" as const, db: o.db, sql: o.sql,
params: o.params }))` to `ClientCommit.operations` **after** the cell ops (§5
ordering). The sqlite ops MUST NOT be added to the `operations: NativeCommitOperation[]`
that feed `applyPending`/`confirmPending`/`touched`
([:1532-1556](../../../../packages/runner/src/storage/v2.ts)) — they only enter
the **wire** `operations` array. (Also handle the `schedulerObservationBatch`
path at [:1452-1486](../../../../packages/runner/src/storage/v2.ts), which builds
its own `ClientCommit` with `operations: []` — a sqlite op must never ride a
scheduler-observation-only commit; assert mutual exclusivity, matching
[`engine.ts:3098-3102`](../../../../packages/memory/v2/engine.ts).)

---

## 2. API / call shape — getting the tx, and the new signature

### 2.1 Why the reactive-node shape cannot deliver this (evidence)

Today `sqliteExecute` is a build-time **node factory**:
`createNodeFactory({ type:"ref", implementation:"sqliteExecute" })`
([`builder/built-in.ts:184-187`](../../../../packages/runner/src/builder/built-in.ts)),
registered as an effect module
([`builtins/index.ts:57-58`](../../../../packages/runner/src/builtins/index.ts))
whose `action` runs **later, in the scheduler's own fresh tx** — not the
handler's. Existing tests call it in the **pattern body** (declarative), e.g.
[`sqlite-builtins.test.ts:59-64,134-138`](../../../../packages/runner/test/sqlite-builtins.test.ts).
A dependent effect provably receives a different tx than the action that wrote
its input (`atomicity-handler-model.md` §1.3). So the node form can never share
the handler's commit.

### 2.2 The ambient handler tx IS reachable (verified)

- A handler argument is a **query-result proxy** bound to the handler's `tx`
  ([`runner.ts:2840-2854`](../../../../packages/runner/src/runner.ts) →
  `readJavaScriptArgument` →
  `getAsQueryResult([], tx, writableProxy)`
  [`runner.ts:2348-2352`](../../../../packages/runner/src/runner.ts)).
- Recovering the `db` Cell from that proxy mints a Cell **bound to the handler's
  tx**: `prop === toCell` returns `() => createCell(runtime, link, tx, ...)`
  ([`query-result-proxy.ts:227-229`](../../../../packages/runner/src/query-result-proxy.ts)).
- A `Cell` exposes its tx: `tx: IExtendedStorageTransaction | undefined`
  ([`cell.ts:346`](../../../../packages/runner/src/cell.ts)); `cell.set()` etc.
  all read `this.tx` ([`cell.ts:879,893,901`](../../../../packages/runner/src/cell.ts)).
- The sqlite codec already recovers a Cell from a cell-or-`toCell` value
  (`asCellOrUndefined`,
  [`builtins/sqlite/cf-link.ts:25-35`](../../../../packages/runner/src/builtins/sqlite/cf-link.ts)).

**Therefore** an in-handler `sqliteExecute(db, sql, params)` can: recover `db`'s
Cell, read `db.get()` for the `SqliteDbRef` (`{id,tables}`,
[`sqlite-builtins.ts:104-113`](../../../../packages/runner/src/builtins/sqlite-builtins.ts)),
take `tx = dbCell.tx`, and call `tx.recordSqliteWrite({op:"sqlite",db,sql,params})`
on the **handler's own tx**. No new runtime plumbing for "the current action tx"
is required — the tx travels on the handle Cell.

> **Caveat to call out loudly:** this binding only holds when `db` reaches the
> handler as a **tx-bound cell/proxy** (i.e. declared `asCell` / `Writable<>` in
> the handler's argument schema, like `SqliteDatabase` already is — see the
> `toCell` back-pointer note at
> [`api/index.ts:2148-2153`](../../../../packages/api/index.ts)). If a pattern
> passes a **plain dereferenced value** (no `toCell`), `cell.tx` is unavailable
> and the call cannot fold. The signature MUST therefore require the handle
> (`Cell`/proxy), and the implementation MUST throw a clear error if it cannot
> recover a tx-bound Cell. This is the one hard precondition.

### 2.3 Chosen mechanism and signature

Make `sqliteExecute` a **plain builder function** (not a node factory, not a
method on the handle) callable from handler/imperative context:

```ts
// api/index.ts — replace SqliteExecuteFunction
export type SqliteExecuteFunction = (
  db: Opaque<SqliteDatabase>,
  sql: string,
  params?: ReadonlyArray<unknown> | Record<string, unknown>,
) => void;            // abort-only: no result, no OpaqueRef
```

(Positional `(db, sql, params)` matches the `db.exec("INSERT …", […])` shape in
`atomicity-handler-model.md` §3.4. A single-object arg is equally fine; the
load-bearing change is `=> void` and "callable in a handler".) Replace the old
object-param `OpaqueRef<{pending,result,error}>` form at
[`api/index.ts:2180-2191`](../../../../packages/api/index.ts).

**Runtime implementation** (`builtins/sqlite-builtins.ts`): drop the
`createNodeFactory`/`RawBuiltinResult` shape entirely for execute; export a plain
function that (1) recovers the `db` Cell via `asCellOrUndefined`, (2) reads
`tx = dbCell.tx` (throw if absent), (3) `db = readDbRef(dbCell.get())`, (4)
`encodedParams = encodeParams(sql, params)` (reuse as-is,
[`sqlite-builtins.ts:71-95`](../../../../packages/runner/src/builtins/sqlite-builtins.ts)),
(5) `tx.recordSqliteWrite({ op:"sqlite", db, sql, params: encodedParams })`.
No result cell, no `enqueuePostCommitEffect`, no `editWithRetry`, no `rev` bump.

**Builder / factory exposure:** `factory.ts:170` injects `sqliteExecute` into the
`commonfabric` object
([`builder/factory.ts:168-170`](../../../../packages/runner/src/builder/factory.ts)).
Keep it injected as the plain function (replace the
`createNodeFactory(...) as SqliteExecuteFunction` export at
[`built-in.ts:184-187`](../../../../packages/runner/src/builder/built-in.ts) with
a direct re-export of the runtime function, or wire it like `navigateTo`'s
sibling helpers). Remove the `addModuleByRef("sqliteExecute", …)` registration
([`builtins/index.ts:56-59`](../../../../packages/runner/src/builtins/index.ts))
since there is no longer a module/node.

**Registry guard interaction (keep green):** the guard test asserts every
callable injected into `factory.ts`'s `commonfabric` object is present in
`COMMONFABRIC_RUNTIME_EXPORTS_BY_NAME`
([`ts-transformers/test/core/commonfabric-runtime-registry.test.ts:185-203`](../../../../packages/ts-transformers/test/core/commonfabric-runtime-registry.test.ts)).
Because `sqliteExecute` stays injected (just as a plain fn), it **must stay in
the registry** ([`commonfabric-runtime-registry.ts:196-201`](../../../../packages/ts-transformers/src/core/commonfabric-runtime-registry.ts)).
But its semantics change: a folded write is **not** reactive-origin (it produces
no cell/OpaqueRef to read). Change its entry to `reactiveOrigin: false` (compare
`patternTool` at [:126-131](../../../../packages/ts-transformers/src/core/commonfabric-runtime-registry.ts),
which is a `call` with `reactiveOrigin:false`). Keep `callKind:"runtime-call"`.
If the transformer's call-kind detection needs a non-reactive runtime call to be
left as a plain call (not wrapped as a reactive origin), audit `ast/call-kind.ts`
(referenced by the guard test's failure hint,
[:200](../../../../packages/ts-transformers/test/core/commonfabric-runtime-registry.test.ts))
— a RED transformer test is **not** required by this milestone (the brief scopes
tests to runner/storage), but the registry guard test and any
reactive-origin-classification test must be updated to expect `false`.

`sqliteQuery` / `sqliteDatabase` entries and their `reactiveOrigin:true`
stay unchanged ([:184-195](../../../../packages/ts-transformers/src/core/commonfabric-runtime-registry.ts)).

---

## 3. Fatal-error handling — SQL failure aborts (non-retryable) and propagates

### 3.1 Current classification (the spin risk)

- `editWithRetry` retries on **any** commit error up to `DEFAULT_MAX_RETRIES = 5`
  ([`runtime.ts:652-696`](../../../../packages/runner/src/runtime.ts);
  [`runtime.ts:144`](../../../../packages/runner/src/runtime.ts)) — it does **not**
  distinguish `ConflictError` from `TransactionError`
  ([`runtime.ts:678-685`](../../../../packages/runner/src/runtime.ts)).
- The scheduler's event path commits **without** retry/await and re-runs the
  event only on rejection of dependent speculative state
  ([`events.ts:494-501`](../../../../packages/runner/src/scheduler/events.ts)).
- A server error surfaces through `pushCommit`'s catch →
  `toRejectedError(error, commit)`
  ([`v2.ts:1615-1648,2027-2060`](../../../../packages/runner/src/storage/v2.ts)).
  `toRejectedError` only classifies as `ConflictError` when the error is named
  `ConflictError` or the message contains `"stale confirmed read"` /
  `"pending dependency"` ([:2032-2048](../../../../packages/runner/src/storage/v2.ts));
  **everything else becomes a generic `TransactionError`**
  ([:2050-2059](../../../../packages/runner/src/storage/v2.ts)).

A SQL failure (the engine throws inside `applySqliteOperation`/`runWrite`,
[`engine.ts:3265-3277`](../../../../packages/memory/v2/engine.ts)) is **not** a
`ConflictError` and **not** the stale/pending strings, so it falls into the
`TransactionError` branch. Good news: it is **not** misclassified as a conflict.

### 3.2 What must change

1. **Abort is already correct for the handler path.** Because the folded write
   rides the **handler's** `tx`, a SQL failure rejects `tx.commit()`
   ([`events.ts:501`](../../../../packages/runner/src/scheduler/events.ts)); the
   cell writes in the same `ClientCommit` are rejected together (server rolls
   back the whole `applyCommit` transaction —
   [`engine.ts:1520-1524`](../../../../packages/memory/v2/engine.ts), proven by
   [`v2-sqlite-atomic-test.ts:64-106`](../../../../packages/memory/test/v2-sqlite-atomic-test.ts)).
   The event path does not loop on a rejected commit (no `editWithRetry`); it
   surfaces via the normal rejection/dirtying path. **So for the handler call
   site, abort-only is satisfied without a retry-classification change.**
2. **Guard the `editWithRetry` callers** that DO loop (e.g. `runner.ts:1540`,
   `acl-manager.ts:47`, `pattern-manager.ts:627`). If any handler-equivalent
   write path that can carry a folded sqlite op goes through `editWithRetry`, a
   SQL failure would **spin 5×** then surface — wasteful and wrong (a SQL
   constraint error is deterministic; retrying re-runs the identical op). The fix
   is to make a SQL/sqlite-op failure a **non-retryable** class:
   - In `toRejectedError`, recognize the engine's sqlite failure (it throws a
     plain `Error` from `runWrite`; classify by a stable marker — e.g. the server
     should tag sqlite-apply failures with `name:"SqliteError"` or a message
     prefix, then `toRejectedError` maps it to a `name:"TransactionError"` with a
     `fatal:true`/non-retryable marker). **Verify the exact thrown shape** at the
     server boundary before finalizing the matcher (it currently re-wraps via
     `respondTypedError`, [`server.ts:949-955`](../../../../packages/memory/v2/server.ts)).
   - In `editWithRetry`, **do not retry** when the rejection is the fatal/sqlite
     class ([`runtime.ts:678-685`](../../../../packages/runner/src/runtime.ts)) —
     return the error immediately.
3. **Out of scope (stated in the brief):** making the abort *throw* back into the
   handler synchronously (CFC-safe error propagation). For now the guarantee is
   "the commit aborts; nothing lands." No result cell records the error.

> The minimal viable change for the **decided** call site (handler) is **#1
> (already true)**; **#2 is required only to keep non-handler `editWithRetry`
> callers from spinning** and should be implemented to avoid a 5× retry on a
> deterministic SQL failure. Confirm the engine error's wire shape first.

---

## 4. `_cf_link` encoding + ordering

### 4.1 Encode at record time, reuse `encodeParams`

Param encoding (Cell → sigil string for `_cf_link` columns; throw for a cell
bound to a non-link column) must happen **at record time**, reusing the existing
`encodeParams`/`encodeCfLinkValue`
([`sqlite-builtins.ts:71-95`](../../../../packages/runner/src/builtins/sqlite-builtins.ts);
[`sqlite/cf-link.ts:42-54`](../../../../packages/runner/src/builtins/sqlite/cf-link.ts)).
The recorded `SqliteOperation.params` are therefore already the **wire** form
(`SqliteParamsWire`, [`memory/v2.ts:314`](../../../../packages/memory/v2.ts)) — no
live Cell crosses into `getNativeCommit`/`buildCommit`. This matches `SetOperation`
values, which are likewise plain wire values by the time they reach buildCommit.

### 4.2 Ordering: append sqlite op AFTER cell ops

The engine applies `commit.operations` **in array order**
([`engine.ts:3202`](../../../../packages/memory/v2/engine.ts):
`for (const [opIndex, operation] of commit.operations.entries())`). A `_cf_link`
param is an **absolute sigil link** carrying id+space+scope
([`cf-link.ts:49-53`](../../../../packages/runner/src/builtins/sqlite/cf-link.ts))
— it stores a **reference string**, not the referenced cell's value, so the
`sqlite` op does **not** read the just-written cell's contents at apply time.
**Therefore ordering does not affect correctness of `_cf_link` rows.** Append the
sqlite op **last** anyway (spec-04 ordering, matching
`atomicity-handler-model.md` §3.2), so the cell `set` ops materialize first
within the same transaction — consistent and future-proof if any later read-back
is added. A test (§5d) pins this.

---

## 5. Test-first plan (RED first, runner/storage-level — NO transformer)

All tests use a **unique space per test**
(`Identity.fromPassphrase("sqlite-exec-fold-" + crypto.randomUUID())`) because the
server keys the cell-db temp file by `(space, db.id)`
([`server.ts:717-718`](../../../../packages/memory/v2/server.ts); `reactivity.md`
§1c). Extend [`packages/runner/test/sqlite-builtins.test.ts`](../../../../packages/runner/test/sqlite-builtins.test.ts)
(or add `packages/runner/test/sqlite-commit-fold.test.ts`) and reuse the
`createTrustedBuilder` + emulated `StorageManager` setup
([`sqlite-builtins.test.ts:9-37`](../../../../packages/runner/test/sqlite-builtins.test.ts)).
For the seam assertion, instrument `SpaceReplica.commitNative` via
`runtime.storageManager.open(space).replica` and capture
`transaction.getNativeCommit(space)` (exactly the probe technique in
`atomicity-handler-model.md` §6) — but now assert on the **single handler
commit**, not an effect-node commit.

### RED tests (write these first; they fail today)

**(a) cell.set + sqliteExecute commit together, both visible.** In one tx (or one
handler invocation), write a sibling cell AND call `sqliteExecute(db, "INSERT
INTO notes (body) VALUES (?)", ["hi"])`; commit. Assert: exactly **one**
`commitNative` carried both — `getNativeCommit(space).operations` includes the
cell `set` AND `getNativeCommit(space).sqliteOps.length === 1` (the NEW field).
Then assert the row is queryable (via `provider.sqliteQuery!` or a `sqliteQuery`
read) AND the sibling cell value is present. *Fails today:* `sqliteOps` field does
not exist and `sqliteExecute` is a node that never records onto the tx.

**(b) failing INSERT aborts the whole commit (sibling rollback).** Declare a table
with a constraint (e.g. `body text not null` or a UNIQUE), write a sibling cell in
the same tx, and `sqliteExecute` an INSERT that **violates** it; commit. Assert:
`tx.commit()` returns an **error** (rejected), the sibling cell write did **not**
land (re-read in a fresh tx → undefined/previous), and the table has **0** rows.
*Fails today:* no folding, so a sibling cell write would commit independently of
the (separately-RPC'd) row write. (Engine-level rollback is already proven by
[`v2-sqlite-atomic-test.ts:64-106`](../../../../packages/memory/test/v2-sqlite-atomic-test.ts);
this test proves the **runner** wires it.)

**(c) sqlite-op-only commit is not dropped.** A tx that does ONLY
`sqliteExecute(...)` (no cell write) commits and the row lands. *Fails today / 
guards the early-return:* exercises the `operations.length === 0 && !schedulerObs`
guards at [`v2-transaction.ts:1457-1463`](../../../../packages/runner/src/storage/v2-transaction.ts),
[`v2.ts:1257,1493`](../../../../packages/runner/src/storage/v2.ts).

**(d) ordering: sqlite op is last in `ClientCommit.operations`.** Capture the wire
`ClientCommit` (instrument `session.transact` or assert on the mapped operations
in `buildCommit` via the `commitNative` capture) and assert the `op:"sqlite"`
entry comes **after** all `op:"set"/"patch"/"delete"` entries.

**(e) `_cf_link` param folded correctly.** Declare a table with an `author_cf_link`
column (`cf.cfLink()`, [`sqlite-builtins.test.ts:40-49`](../../../../packages/runner/test/sqlite-builtins.test.ts));
pass a **Cell** as that param. Assert the recorded/wire `SqliteOperation.params`
contains the **encoded sigil-link string** (not a live Cell), i.e. `encodeParams`
ran at record time. Reuse the roundtrip expectations from
[`sqlite-cf-link-roundtrip.test.ts:59`](../../../../packages/runner/test/sqlite-cf-link-roundtrip.test.ts).
Also assert a Cell bound to a **non-link** column **throws** at the call site
(reusing `encodeParams`'s `TypeError`,
[`sqlite-builtins.ts:75-77`](../../../../packages/runner/src/builtins/sqlite-builtins.ts)).

**(f) (precondition guard) plain value db handle throws.** Call `sqliteExecute`
with a `db` that is NOT a tx-bound cell/proxy (no recoverable `cell.tx`); assert a
clear error (the §2.2 caveat). Locks the one hard precondition.

### GREEN steps (in order)

1. Add `SqliteOperation` import + `recordSqliteWrite?` to `IStorageTransaction`
   and `sqliteOps?` to `NativeStorageCommit` (`storage/interface.ts`). → (a)/(c)
   type-compile.
2. Implement `#sqliteOps` + `recordSqliteWrite` + emit in `getNativeCommit`
   (`v2-transaction.ts`); relax the three empty-commit guards to count
   `sqliteOps`. → (c) green; (a) partially.
3. Thread `sqliteOps` through `commitNative`/`commitOperations` and append the
   wire `op:"sqlite"` **last** in `buildCommit`, keeping them out of
   `applyPending`/`confirmPending`/`touched` (`v2.ts`). → (a), (d) green.
4. Rewrite `sqliteExecute` as a plain function recording onto `db.tx`
   (`builtins/sqlite-builtins.ts`); recover Cell via `asCellOrUndefined`; reuse
   `encodeParams`. → (a), (e), (f) green.
5. Re-wire the builder export (`built-in.ts`/`factory.ts`), drop the module
   registration (`builtins/index.ts`), update `api/index.ts`
   `SqliteExecuteFunction` and `builder/types.ts`. → patterns compile to the new
   call shape.
6. Update the transformer registry entry to `reactiveOrigin:false` and fix the
   registry/classification tests
   (`commonfabric-runtime-registry.ts` + `…registry.test.ts`). → guard green.
7. (Optional, recommended) Non-retryable SQL-error classification in
   `toRejectedError`/`editWithRetry`. → (b) deterministic (no 5× spin on the
   non-handler callers); confirm engine error wire shape first.

---

## 6. Removal list (drop the reactive form; keep `sqliteQuery` intact)

**Delete / rewrite:**
- `builtins/sqlite-builtins.ts`: delete the reactive `sqliteExecute(...)` node
  (the `RawBuiltinResult`/`action`, `ExecuteState`, `makeResultCell` use for
  execute, `enqueuePostCommitEffect` + `provider.sqliteExecute!` RPC +
  `editWithRetry` + `db.rev` bump)
  ([:239-336](../../../../packages/runner/src/builtins/sqlite-builtins.ts)).
  Replace with the plain folding function. **Keep** `encodeParams`/
  `parseInsertColumns`/`readDbRef` ([:71-113](../../../../packages/runner/src/builtins/sqlite-builtins.ts))
  and the entire `sqliteQuery` node ([:147-237](../../../../packages/runner/src/builtins/sqlite-builtins.ts)).
  Update the file header (currently "writes are a separate RPC, not folded …",
  [:16-19](../../../../packages/runner/src/builtins/sqlite-builtins.ts)).
- `builtins/index.ts`: remove the `addModuleByRef("sqliteExecute", raw(...,
  {isEffect:true}))` registration
  ([:56-59](../../../../packages/runner/src/builtins/index.ts)); keep
  `sqliteQuery` (effect) and `sqliteDatabase`
  ([:48-55](../../../../packages/runner/src/builtins/index.ts)).
- `builder/built-in.ts`: replace the `createNodeFactory(...)` export for
  `sqliteExecute` ([:184-187](../../../../packages/runner/src/builder/built-in.ts))
  with a plain-fn re-export. Keep `sqliteDatabase`/`sqliteQuery` factories
  ([:174-182](../../../../packages/runner/src/builder/built-in.ts)).
- `api/index.ts`: change `SqliteExecuteFunction` to `(db, sql, params?) => void`
  ([:2180-2191](../../../../packages/api/index.ts)); keep the `sqliteExecute`
  declaration ([:2453](../../../../packages/api/index.ts)) and `SqliteDatabase`/
  `SqliteQueryFunction` unchanged.
- `builder/types.ts`: keep `sqliteExecute: SqliteExecuteFunction` in
  `BuilderFunctionsAndConstants` ([:321](../../../../packages/runner/src/builder/types.ts))
  — the type just changes shape via `api/index.ts`.
- `ts-transformers/src/core/commonfabric-runtime-registry.ts`: flip the
  `sqliteExecute` entry to `reactiveOrigin:false`
  ([:196-201](../../../../packages/ts-transformers/src/core/commonfabric-runtime-registry.ts)).

**Update tests:**
- `packages/runner/test/sqlite-builtins.test.ts`: the "executes a write through
  the builtin" test ([:52-81](../../../../packages/runner/test/sqlite-builtins.test.ts))
  asserts the old `{pending,result:{changes}}` contract — rewrite to the folded
  call shape (no result cell). The "re-runs a reactOn:db query after a sibling
  write" test ([:116-159](../../../../packages/runner/test/sqlite-builtins.test.ts))
  relied on the `rev` bump; either drive re-query a different way or move it to a
  query-only assertion (the `rev`-bump reactive loop is removed).
- `packages/runner/test/sqlite-cf-link-decode.test.ts`
  ([:119,175](../../../../packages/runner/test/sqlite-cf-link-decode.test.ts)) and
  `sqlite-cf-link-roundtrip.test.ts`
  ([:59](../../../../packages/runner/test/sqlite-cf-link-roundtrip.test.ts)):
  update the `cf.sqliteExecute({...})` call sites to the new shape; keep the
  encode/decode assertions (codec is unchanged).
- `ts-transformers/test/core/commonfabric-runtime-registry.test.ts`: still passes
  (sqliteExecute stays injected + registered); add/adjust any
  reactive-origin-classification expectation to `false`.

**Keep intact (DO NOT touch):**
- `sqliteQuery` node + its `provider.sqliteQuery!` RPC
  ([`sqlite-builtins.ts:147-237`](../../../../packages/runner/src/builtins/sqlite-builtins.ts)).
- Storage provider `sqliteQuery` method
  ([`storage/interface.ts:240-245`](../../../../packages/runner/src/storage/interface.ts);
  [`v2.ts:863-868,1047-1053`](../../../../packages/runner/src/storage/v2.ts)).
- **Decide on the storage `sqliteExecute` provider method** (`interface.ts:247-252`;
  `v2.ts:871-876,1056-1062`): the folded path no longer uses it (writes go
  through the commit, not the RPC). It can be **removed** once no caller remains,
  but `packages/runner/test/sqlite-storage.test.ts:38,54` and
  `sqlite-cf-link-roundtrip.test.ts:59` call `provider.sqliteExecute!` directly
  for storage-level coverage. Either keep the provider method (harmless, still
  proxies to `session.sqliteExecute`) or delete it AND migrate those storage
  tests to assert via a folded commit. **Recommendation: keep the provider method
  for now** (out of the critical path; deleting it is a separate cleanup), to
  avoid widening the blast radius. The engine still exposes `sqlite.execute` as an
  RPC for direct/testing use ([`memory/v2.ts:337-350`](../../../../packages/memory/v2.ts)).
- All engine/server/wire sqlite code (`memory/v2.ts`, `engine.ts`, `server.ts`,
  `sqlite/exec.ts`) — already complete and tested.

---

## 7. Risks / open questions

1. **Handler-tx access (was the riskiest unknown — RESOLVED).** The handler's
   `db` argument is a tx-bound proxy; `value[toCell]()` mints a Cell carrying the
   handler's tx ([`query-result-proxy.ts:227-229`](../../../../packages/runner/src/query-result-proxy.ts)),
   exposed as `cell.tx` ([`cell.ts:346`](../../../../packages/runner/src/cell.ts)).
   **No new "ambient current-action-tx" runtime plumbing is needed.** The single
   hard precondition: `db` must arrive as a cell/proxy (it does, since
   `SqliteDatabase` is `asCell` with a `toCell` back-pointer,
   [`api/index.ts:2148-2153`](../../../../packages/api/index.ts)). Test (f) pins
   the failure mode for a plain value. Confirm the **writableProxy** path
   ([`runner.ts:2347-2352`](../../../../packages/runner/src/runner.ts)) yields a
   writable-tx-bound cell for handler args (it does for `.set()`-able cells).
2. **Retry classification (open).** A SQL failure is currently a generic
   `TransactionError` ([`v2.ts:2050-2059`](../../../../packages/runner/src/storage/v2.ts)),
   NOT a conflict — good. But `editWithRetry` retries it 5×
   ([`runtime.ts:678-685`](../../../../packages/runner/src/runtime.ts)). The
   handler event path does **not** use `editWithRetry`
   ([`events.ts:494-501`](../../../../packages/runner/src/scheduler/events.ts)), so
   the decided handler call site is fine; the non-handler `editWithRetry` callers
   need the non-retryable marker (§3.2 #2). **Open:** the exact thrown shape of an
   engine sqlite failure at the client boundary (verify the
   `respondTypedError`/`session.transact` rejection,
   [`server.ts:949-955`](../../../../packages/memory/v2/server.ts);
   [`v2.ts:1611-1616`](../../../../packages/runner/src/storage/v2.ts)) before
   writing the matcher.
3. **`schedulerObservationBatch` vs sqlite op (mutual exclusivity).** The batch
   path builds a `ClientCommit` with `operations: []`
   ([`v2.ts:1452-1486`](../../../../packages/runner/src/storage/v2.ts)); the engine
   rejects mixing semantic ops with a batch
   ([`engine.ts:3098-3102`](../../../../packages/memory/v2/engine.ts)). Ensure a
   sqlite op never rides a batch/observation-only commit; assert it.
4. **≤1 cell-db per commit.** The server enforces one cell-db per commit
   ([`server.ts:687-690`](../../../../packages/memory/v2/server.ts)). If a single
   handler calls `sqliteExecute` twice against the **same** db, that is fine (same
   id → same alias); against **two different** dbs it will be rejected
   server-side. Consider a friendlier client-side assertion in `recordSqliteWrite`.
5. **Loss of `changes`/`lastInsertRowid` and result cell** is an intended,
   stated trade-off (brief: no return value). Patterns that needed
   `lastInsertRowid` for follow-up inserts must restructure (e.g. deterministic
   ids). Call this out in the API doc and `IMPLEMENTATION_LOG`.
6. **Reactivity for `reactOn: db`.** Removing the `rev` bump means a `sqliteQuery`
   with `reactOn: db` no longer auto-re-runs after a folded write through the
   handle's value change. The folded commit does NOT currently dirty the handle
   entity (server filters sqlite ops out of `markSpaceDirty`,
   [`server.ts:929-933`](../../../../packages/memory/v2/server.ts)). **Open
   question:** how does `reactOn: db` re-query after a folded write? Options:
   re-introduce a handle write in the same handler commit (a `rev`-like bump as a
   normal cell op), or the deferred server `markSpaceDirty(handle-id)` hardening
   (`reactivity.md` §4; `atomicity-handler-model.md` §4). **This must be decided
   before patterns rely on read-after-folded-write reactivity** — it is the main
   user-visible behavioral gap created by dropping the reactive node.
