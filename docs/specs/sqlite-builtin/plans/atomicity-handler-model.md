# Plan — Handler + SQLite atomicity: the transaction model and what folding can (and cannot) deliver

**Status:** design / investigation. Read-only; **no feature code changed.**
Findings below were confirmed both from the code and with a throwaway runner
probe (`scheduler.subscribe` of two effects, captured tx identities; deleted
after capture).

**Scope.** `atomic-writes.md` (Stages 1–3 landed: engine + server now apply a
commit-folded `sqlite` op inside the one `applyCommit` transaction —
[`v2-sqlite-atomic-test.ts`](../../../../packages/memory/test/v2-sqlite-atomic-test.ts),
[`v2-sqlite-protocol-test.ts:83`](../../../../packages/memory/test/v2-sqlite-protocol-test.ts)).
This document resolves the **runner** question that `atomic-writes.md` §1.4
assumed away: *whose* transaction would the folded `sqlite` op ride, and can a
**handler's cell write** and a `sqliteExecute` actually share one commit. The
answer changes the recommended runner seam and the reactivity/result contracts.

---

## 0. TL;DR (the headline correction)

- **A handler and a `sqliteExecute` never share a transaction today, and cannot
  be made to under the current execution model by "recording the op on the
  transaction."** They run as **two independent scheduler actions**, each in its
  **own** `runtime.edit()` transaction, each producing its **own** commit. The
  handler does not *call* `sqliteExecute`; it writes a cell that the
  `sqliteExecute` **effect node** reads, and the scheduler runs that node
  *later* in a fresh tx. Proven empirically (§1.3).
- Worse than "two commits": today's `sqliteExecute` does the real write in a
  **third** transaction — `enqueuePostCommitEffect` → `flush()` →
  `runtime.editWithRetry(...)`, which runs **after** the effect node's own commit
  resolves ([`extended-storage-transaction.ts:653-657`](../../../../packages/runner/src/storage/extended-storage-transaction.ts);
  [`sqlite-builtins.ts:301-309`](../../../../packages/runner/src/builtins/sqlite-builtins.ts)).
- **What folding the runner write actually buys (recommend, option (c)+(b-seam)):**
  fold the `sqliteExecute` *effect node's* cell writes and its `sqlite` op into
  **one** commit — i.e. atomic unit = **"the effect's own commit"**, not
  "handler + sqlite". This is real, useful atomicity (the row + the effect's
  `{pending:false, requestHash}` result land together-or-not-at-all) and matches
  what the engine/server already support. **Handler+sqlite atomicity is NOT
  provided**; document it as a non-goal for this milestone.
- **True handler-atomicity needs a different execution model** (synchronous,
  in-handler sqlite write API — option (b)), spelled out in §3.4 as the future
  path. Recommended **only if** a concrete pattern requires "mutate this cell and
  insert this row, atomically, from one handler."
- **Reactivity:** with folding, the client `rev`-bump that drives `reactOn: db`
  today **still works** (it is a cell write in the same folded commit). But the
  cleaner long-term driver is the **server** `markSpaceDirty(db.id)` — which
  today explicitly *filters `sqlite` ops out* ([`server.ts:930`](../../../../packages/memory/v2/server.ts)).
  Recommend keeping the client bump for v1, gated switch to server-dirty later
  (§4).
- **`changes`/`lastInsertRowid`:** thread via `AppliedCommit.sqliteResults`
  (option (a)) — `runWrite` already returns them
  ([`exec.ts:96`](../../../../packages/memory/v2/sqlite/exec.ts)), the engine just
  discards them ([`engine.ts:3276`](../../../../packages/memory/v2/engine.ts)).
  Cheap to plumb, preserves today's `sqliteExecute` result contract (§5).

---

## 1. Transaction model (traced + proven)

### 1.1 Every scheduler action runs in its own tx and commits independently

The scheduler runs each subscribed action by minting a fresh transaction,
invoking the action against it, then committing **that** tx:

- Reactive computations/effects:
  [`action-run.ts:308`](../../../../packages/runner/src/scheduler/action-run.ts)
  `const tx = state.runtime.edit({ changeGroup: … })`, then
  [`:93`](../../../../packages/runner/src/scheduler/action-run.ts)
  `harness.invoke(() => args.action(args.tx))`, then
  [`:128`](../../../../packages/runner/src/scheduler/action-run.ts)
  `state.tx.commit()`.
- Event handlers: [`events.ts:429`](../../../../packages/runner/src/scheduler/events.ts)
  `const tx = state.runtime.edit(); tx.tx.immediate = true;`, then
  [`:565`](../../../../packages/runner/src/scheduler/events.ts)
  `harness.invoke(() => action(tx))` (where
  `action = (tx) => handler(tx, event)`,
  [`events.ts:134`](../../../../packages/runner/src/scheduler/events.ts)), then
  [`:501`](../../../../packages/runner/src/scheduler/events.ts) `tx.commit()`.

So **a handler's cell writes go into the event handler's tx** and commit when
that handler's `tx.commit()` resolves. **One handler invocation = one commit.**

### 1.2 A builtin/effect (fetchData / sqliteExecute) is a *separate* node, not part of the handler

`sqliteExecute` is registered as a standalone reactive node with
`isEffect: true`
([`builtins/index.ts:57-58`](../../../../packages/runner/src/builtins/index.ts)),
wired into the scheduler via
[`runner.ts:3649`](../../../../packages/runner/src/runner.ts)
`this.runtime.scheduler.subscribe(action, populateDependencies, { isEffect })`.
A handler **does not invoke** the builtin. To "trigger a sqlite write," a handler
(or any upstream) writes the builtin's **input cell** (`db`/`sql`/`params`); that
write dirties the effect node; the scheduler later runs the node's action in a
**new** `runtime.edit()` tx (§1.1). The handler's commit and the effect's commit
are different transactions, ordered: **handler commits first, the effect runs
after** (it is a dependent of the cell the handler wrote).

### 1.3 Empirical proof (probe, deleted)

A throwaway probe subscribed two effects: a *writer* (reads `source`, writes
`intermediate` — the handler analogue) and an *effect* (reads `intermediate`,
writes `effectOut` — the `sqliteExecute` analogue), then committed a change to
`source` and let the scheduler settle. Captured the tx identity each action
received:

```
PROBE writer tx id: tx#3
PROBE effect tx id: tx#4
PROBE same tx?  false
PROBE intermediate: 6   effectOut: 600     (both ran, in different txns)
```

The dependent effect provably receives a **different transaction** than the
action that wrote its input. This is the exact handler→`sqliteExecute`
relationship.

### 1.4 The third transaction: today's `sqliteExecute` defers the actual write past its own commit

Even within the effect node's run, the SQL is **not** issued during the action.
The action sets `{pending:true}` and enqueues a post-commit effect
([`sqlite-builtins.ts:301`](../../../../packages/runner/src/builtins/sqlite-builtins.ts)).
Post-commit effects flush **only after the action tx commits**
([`extended-storage-transaction.ts:653-657`](../../../../packages/runner/src/storage/extended-storage-transaction.ts):
`const result = await promise; if (result.ok) for (const effect of outbox) await
effect.flush(...)`). The `flush` opens **yet another** tx via
`runtime.editWithRetry`
([`sqlite-builtins.ts:309`](../../../../packages/runner/src/builtins/sqlite-builtins.ts))
to issue the `sqlite.execute` RPC and write the result/rev-bump back.

**Net: a handler that "triggers a sqlite write" produces ≥2 commits today (handler
commit; effect-node commit), and the row itself lands via a 3rd RPC after the 2nd
commit.** The atomicity the engine/server provide (cell op + sqlite op in one
`applyCommit`) is currently **unused by the runner** — there is no runner code
that emits a folded commit (Stage 4/5 of `atomic-writes.md` is **not yet
implemented**: `grep` finds **no** `recordSqliteWrite` / `sqliteOps` /
`sqliteAttachments` in `runner/src/storage/`).

### 1.5 Runner commit assembly (where a folded op would have to be injected)

A tx's writes become `ClientCommit.operations` via
`SpaceReplica.commitNative` ([`v2.ts:1221`](../../../../packages/runner/src/storage/v2.ts))
← `V2Transaction.getNativeCommit`
([`v2-transaction.ts:830`](../../../../packages/runner/src/storage/v2-transaction.ts),
iterates `branch.docs`, emits `set`/`patch`/`delete` per changed doc). The
side-channel precedent is `setSchedulerObservation`/`getSchedulerObservation`
([`v2-transaction.ts:817/826`](../../../../packages/runner/src/storage/v2-transaction.ts));
`getNativeCommit` copies `schedulerObservation` onto the native commit
([`:832,867`](../../../../packages/runner/src/storage/v2-transaction.ts)). The
wire op type already exists: `SqliteOperation { op:"sqlite"; db; sql; params? }`
([`packages/memory/v2.ts:95`](../../../../packages/memory/v2.ts)), part of the
`Operation` union ([`:106`](../../../../packages/memory/v2.ts)).

---

## 2. Is handler + sqlite atomicity achievable? (answer the three options)

> Can a handler's cell write and a `sqliteExecute` land in the same commit?

**No — not for the *reactive-node* `sqliteExecute`.** Concretely, evaluating the
three options from the brief:

**(a) "`sqliteExecute` records the op on the *currently committing* transaction."**
There is no shared "currently committing transaction" between the handler and the
node. When the `sqliteExecute` action runs, the tx it receives
(`action-run.ts:308`) is the **effect node's own** tx, created *after* the
handler's tx already committed (§1.3). Recording the op on *that* tx folds it
with the **effect node's** cell writes (its result cell), **not** with the
handler's writes. The handler's tx is closed and gone by then. So (a) is
**achievable only as "fold into the effect's own commit,"** which is option (c),
not "handler + sqlite." There is no hook by which a dependent effect can reach
back into the already-committed triggering transaction.

**(b) A handler-time/synchronous sqlite write API distinct from the reactive
node.** *This* can deliver true handler+sqlite atomicity, because the write would
be recorded **on the handler's own tx** (`events.ts:429`) during `action(tx)`,
before that tx commits — exactly the seam `recordSqliteWrite` was designed for,
but attached to the **handler's** transaction rather than an effect node's. It
requires a new builder primitive (e.g. `db.insert(...)` callable inside a
handler) and is a different execution model from the reactive `sqliteExecute`
node. See §3.4.

**(c) Accept that the atomic unit is "the effect's own commit."** The
`sqliteExecute` node folds its `sqlite` op + its own result-cell write into one
commit. Handler+sqlite atomicity is **not** provided; only
*sqlite-op-in-a-commit* (atomic with that effect's bookkeeping). **Recommended
for this milestone** (§3) — it is the honest mapping of the reactive model onto
the engine/server capability that already exists, and it removes the current
3rd-transaction RPC.

**Which tx does the `sqliteExecute` action receive, and are the handler's writes
in it?** It receives the **effect node's** transaction
(`action-run.ts:308`/`:93`). The handler's cell writes are **not** in it — they
were committed earlier in the handler's transaction (`events.ts:501`). Confirmed
empirically (§1.3).

---

## 3. Recommended design

### 3.1 Recommendation summary

1. **Adopt option (c): fold `sqliteExecute`'s `sqlite` op into its *own* effect
   commit.** Atomic unit = the effect node's commit (row + `{pending:false,
   requestHash}` result). Replaces the post-commit RPC and its 3rd transaction.
2. **Document loudly that handler+sqlite atomicity is a non-goal** of the
   reactive builtin. Point patterns that truly need it at the future synchronous
   API (§3.4).
3. **Wire the runner seam exactly as `atomic-writes.md` §1.4 specifies — but bind
   it to the action's tx, which is the effect node's tx, not a handler's.** The
   plumbing is identical; only the *guarantee* is narrower than the spec's
   headline.

### 3.2 The exact runner seam (Stage 4/5 — not yet implemented; this is the spec)

- **`storage/interface.ts`** ([near `setSchedulerObservation` in
  `IExtendedStorageTransaction`, and `NativeStorageCommit` at
  [:1176](../../../../packages/runner/src/storage/interface.ts)]) — add
  `recordSqliteWrite(op: SqliteOperation): void` to the tx interface, and
  `sqliteOps?: readonly SqliteOperation[]` to `NativeStorageCommit`. **Keep
  `sqliteOps` a separate field**, not a member of `operations[]`, so the
  `id`-assuming paths (`applyPending`, `confirmPending`, `dropPending`,
  `touched`, `buildReads`, `markSpaceDirty`) never see an idless op.
- **`storage/v2-transaction.ts`** — `#sqliteOps: SqliteOperation[] = []`;
  `recordSqliteWrite` (assert writable like `setSchedulerObservation`,
  [:817](../../../../packages/runner/src/storage/v2-transaction.ts)); in
  `getNativeCommit` ([:830-868](../../../../packages/runner/src/storage/v2-transaction.ts))
  return `{ operations, sqliteOps: this.#sqliteOps.length ? […] : undefined, … }`.
  **`getNativeCommit` is the merge point** for the side channel (mirrors the
  `schedulerObservation` copy at [:867](../../../../packages/runner/src/storage/v2-transaction.ts)).
- **`storage/v2.ts` `commitNative`** ([:1221](../../../../packages/runner/src/storage/v2.ts))
  → `buildCommit` ([:1504](../../../../packages/runner/src/storage/v2.ts)) —
  read `nativeCommit.sqliteOps`, append the wire `{op:"sqlite",db,sql,params}`
  **last** to `ClientCommit.operations` (spec-04 ordering). Treat a
  `sqliteOps`-only commit as **non-empty** (the `operations.length === 0`
  early-return must not drop it). **Keep `sqliteOps` out of the `operations[]`
  passed to `applyPending`/`confirmPending`** — they only enter the **wire**
  operations array in `buildCommit`.
- **`buildCommit` only** emits the sqlite wire op — **never `applyPending`**
  (no client-side SQLite; the op has no `id`/`scope` to optimistically apply).
- **`builtins/sqlite-builtins.ts` `sqliteExecute`** — replace
  `enqueuePostCommitEffect`(+RPC) ([:301-333](../../../../packages/runner/src/builtins/sqlite-builtins.ts))
  with `tx.recordSqliteWrite({ op:"sqlite", db, sql, params: encodedParams })`
  **inside the action**, then set the result cell `{ pending:false, requestHash }`
  (success ⇔ the action's commit success). Keep the committed-state dedup
  ([:294](../../../../packages/runner/src/builtins/sqlite-builtins.ts)). Update
  the file header (currently "writes are a separate RPC, not folded",
  [:17-18](../../../../packages/runner/src/builtins/sqlite-builtins.ts)).
- **Keep `sqliteAttachments` plumbing out of the runner** — it is server-only
  (server attaches before `applyCommit`,
  [`server.ts:907`](../../../../packages/memory/v2/server.ts)). The runner only
  needs to emit the wire op; **do not** put attach logic in `applyPending`.

The engine/server halves are **done** (`applyCommit` accepts `sqliteAttachments`,
[`engine.ts`](../../../../packages/memory/v2/engine.ts); `applySqliteOperation`,
[`engine.ts:3265`](../../../../packages/memory/v2/engine.ts);
`#attachCommitSqliteDbs` + filtered `markSpaceDirty`,
[`server.ts:907,927-933`](../../../../packages/memory/v2/server.ts)).

### 3.3 What this guarantees (and what it does not)

- **Guarantees:** the row and the `sqliteExecute` result cell update land in one
  memory-v2 commit; if the commit is rejected, neither lands; no orphan
  3rd-transaction RPC. This is the M2a deliverable, correctly scoped to the
  reactive model.
- **Does NOT guarantee:** that a *handler's* cell mutation is atomic with the row.
  A handler write commits in the handler's tx; the row commits later in the
  effect node's tx. If the handler commit succeeds and the effect commit later
  fails (e.g. SQL guard violation), the cell change has already landed.

### 3.4 True handler-atomicity (the different execution model) — defer unless needed

To make "a handler mutates a cell AND inserts a row, atomically in one commit"
real, the write must be recorded on the **handler's own transaction**
(`events.ts:429`) *during* `handler(tx, event)`, before `tx.commit()`
(`events.ts:501`). That requires a **synchronous, handler-callable** primitive
(option (b)), e.g.:

```ts
const insertNote = cf.handler({...}, {...}, (ev, { counter, db }) => {
  counter.set(counter.get() + 1);          // → handler tx
  db.exec("INSERT INTO notes (body) VALUES (?)", [ev.body]); // → SAME handler tx
});
```

where `db.exec(...)` calls `tx.recordSqliteWrite(...)` on the **ambient handler
tx** (the runtime exposes the current action tx to builder primitives the same
way cell `.set()` reaches it). Then `getNativeCommit` folds the op into the
handler's `ClientCommit`, the server attaches + folds, and the cell + row land in
**one** commit — genuinely atomic. This is **additive** to the reactive node, not
a replacement (the reactive `sqliteExecute` stays for declarative/derived
writes). It is a larger surface (new builder API, schema/CTS support, deciding
how a non-reactive write fits the pattern model) and should be a separate
milestone, justified by a concrete pattern need. **Recommendation: ship §3.2
(option c) now; build §3.4 only when a pattern demands transactional
handler-writes.**

---

## 4. Reactivity interaction

**Does the post-commit handle-`rev` bump still work if folded?** The current
mechanism ([`reactivity.md`](./reactivity.md); `sqlite-builtins.ts:315-321`)
bumps `db.rev` inside the success `editWithRetry` of the post-commit flush —
i.e. it depends on the **separate RPC path** existing. If §3.2 removes the RPC
and folds the op into the action's commit, the natural replacement is to bump
`db.rev` **in the same action** (it is just another cell write on the action's
tx, folded into the same commit as the row). That **still works**: the bump is a
real value change to the handle entity, which `reactOn: db` reads, so the query
re-runs — and now the bump rides the *same* commit as the row (strictly better:
no window where the row is committed but the handle is not). Keep the client bump
for v1.

**Should the server `markSpaceDirty(db.id)` drive reactON instead?** This is the
cleaner long-term design (spec §05 mechanism 1), but today the server
**explicitly excludes** `sqlite` ops from the dirty set
([`server.ts:930`](../../../../packages/memory/v2/server.ts):
`.filter((op) => op.op !== "sqlite")`) — precisely because a `sqlite` op has no
`id`. To use it, the server would, after the folded commit, additionally
`markSpaceDirty(space, [toDirtyKey(<handle entity id>)])` for each db touched by
a `sqlite` op. Two caveats (both from `reactivity.md` §4):
1. **Id-form mismatch.** `db.id` is the bare causal id (`handle.entityId?.["/"]`,
   no `of:` prefix; `sqlite-builtins.ts:138`), while `markSpaceDirty` keys on the
   storage entity id form used at `server.ts:623`/`932`. Needs normalization +
   a test or it silently dirties nothing.
2. **No value diff.** A dirty signal with no value change leans on the
   notification path treating the entity as changed; the client `rev` bump is an
   unambiguous value change. The client path is the **proven** one.

**Recommendation:** keep the **client `rev` bump (folded into the same commit)**
for v1. Switch to **server `markSpaceDirty(handle-id)`** as a hardening once (a)
the id-normalization is fixed and tested and (b) we want to drop the `rev` field
from the handle. Note that `db.id` **is** the handle entity id, so the server
hook is feasible — it is the *id form*, not the *identity*, that needs work.

---

## 5. The `changes` / `lastInsertRowid` contract

With folding, `applyCommit` returns `seq`/`revisions`, **not** the SQLite write
result. `AppliedCommit` ([`engine.ts:741`](../../../../packages/memory/v2/engine.ts))
has **no** `sqliteResults` field today, and `applySqliteOperation` returns `void`,
discarding `runWrite`'s `{ changes, lastInsertRowid }`
([`engine.ts:3276`](../../../../packages/memory/v2/engine.ts)) — even though
`runWrite` **does** compute and return them
([`exec.ts:96`](../../../../packages/memory/v2/sqlite/exec.ts)).

**Recommend option (a): thread results via `AppliedCommit.sqliteResults`.**
Rationale: it **preserves today's `sqliteExecute` result contract**
(`{ result: { changes, lastInsertRowid } }`,
[`sqlite-builtins.ts:241`](../../../../packages/runner/src/builtins/sqlite-builtins.ts)),
the existing builtin test asserts `e.result?.changes === 1`
([`sqlite-builtins.test.ts:80`](../../../../packages/runner/test/sqlite-builtins.test.ts)),
and the cost is tiny: `applySqliteOperation` returns the value `runWrite` already
produces; the apply loop collects them (indexed by op position) into a new
`AppliedCommit.sqliteResults?: { changes: number; lastInsertRowid: number }[]`;
`Server.transact` passes them through; the runner surfaces them onto the
`sqliteExecute` result cell on commit success.

Option (b) (report pending-only / drop counts) is simpler but **breaks the
existing test and contract** and provides strictly less to patterns (no
`lastInsertRowid` for follow-up inserts). Choose (b) only if we decide the result
counts are not part of the supported API. **Default: (a).**

---

## 6. First deterministic failing test (runner-level)

Because §2 establishes handler+sqlite atomicity is **not** the guarantee, the
runner test asserts the **documented weaker guarantee**: a `sqliteExecute`
effect, when folded (§3.2), emits its `sqlite` op **into the same
`ClientCommit.operations` as its result-cell write** — i.e. one commit carries
both. Assert at the **commit-assembly seam** (deterministic; no server, no
reactivity, no flaky cross-effect ordering).

**File:** new `packages/runner/test/sqlite-atomic-commit.test.ts` (or extend
[`sqlite-builtins.test.ts`](../../../../packages/runner/test/sqlite-builtins.test.ts)).
**Isolation:** unique space per test (`Identity.fromPassphrase("sqlite-atomic-" +
crypto.randomUUID())`) — the cell-db temp file is keyed by `(space, db.id)`
(`reactivity.md` §1c).

**Mechanism:** instrument `SpaceReplica.commitNative` to capture each commit's
`getNativeCommit(space)` — exactly how the §1.3 probe worked. Access via
`runtime.storageManager.open(space).replica` (the provider exposes `.replica`;
`commitNative` lives on `SpaceReplica`,
[`v2.ts:944,1221`](../../../../packages/runner/src/storage/v2.ts)).

```ts
it("a folded sqliteExecute emits the sqlite op in the SAME commit as its result write", async () => {
  const sp = (await Identity.fromPassphrase("sqlite-atomic-" + crypto.randomUUID())).did();
  const provider: any = (runtime.storageManager as any).open(sp);
  const replica = provider.replica;
  const orig = replica.commitNative.bind(replica);
  const commits: Array<{ setIds: string[]; sqliteCount: number }> = [];
  replica.commitNative = (transaction: any, ...rest: any[]) => {
    const nc = transaction.getNativeCommit?.(sp);
    commits.push({
      setIds: (nc?.operations ?? []).map((o: any) => `${o.op}:${o.id}`),
      sqliteCount: nc?.sqliteOps?.length ?? 0,           // NEW field (§3.2)
    });
    return orig(transaction, ...rest);
  };

  const pat = cf.pattern(() =>
    cf.sqliteExecute({
      db: cf.sqliteDatabase({
        tables: { notes: cf.table({ id: "integer primary key", body: "text" }) },
      }),
      sql: "INSERT INTO notes (body) VALUES (?)",
      params: ["folded"],
    })
  );
  const resultCell = runtime.getCell(sp, "atomic-exec", pat.resultSchema, tx);
  const result = runtime.run(tx, pat, {}, resultCell);
  tx.commit();

  const cancel = (result as any).sink(() => {});
  try {
    await waitUntil<ExecState>(runtime, result, (v) => v.pending === false);
  } finally { cancel?.(); await runtime.idle(); }

  // THE ASSERTION: exactly one commit carried the sqlite op, and that SAME
  // commit also carried the effect's result-cell write (sqliteExecute result).
  const folded = commits.find((c) => c.sqliteCount === 1);
  expect(folded, "a commit must carry the folded sqlite op").toBeDefined();
  expect(folded!.setIds.length, "sqlite op must ride with the result write").toBeGreaterThan(0);
  // And NO commit should carry a sqlite op without an accompanying cell write,
  // and there must be NO separate post-commit RPC commit for the row.
});
```

**Why this fails today and passes after §3.2.** Today `getNativeCommit` has no
`sqliteOps` field, and `sqliteExecute` never calls `recordSqliteWrite` — the row
goes out via a separate post-commit RPC, so `c.sqliteCount` is always `0` and
`folded` is `undefined` → **fails**. After §3.2, the effect's action records the
op on its own tx and writes its result cell on the same tx → one native commit
with `sqliteCount === 1` **and** `setIds.length > 0` → **passes**.

**Why assert at the seam, not via a handler.** Per §1–§2 a handler cannot share
the commit, so a handler-based "both land in one commit" assertion would be
asserting a guarantee the design does not provide. The seam test asserts the
**actual** atomic unit (the effect's own folded commit) deterministically.

**Optional second test (the documented non-guarantee, to lock it in):** a handler
that writes a cell and dirties a `sqliteExecute` input — assert the cell write and
the sqlite op land in **different** commits (capture as above; expect the cell
`set` in commit *i* and the `sqlite` op in commit *j > i*). This pins the
"handler+sqlite is two commits" contract so a future reader does not assume
otherwise.

**Server-loopback / engine atomicity** are already covered
([`v2-sqlite-protocol-test.ts:83,105`](../../../../packages/memory/test/v2-sqlite-protocol-test.ts);
[`v2-sqlite-atomic-test.ts`](../../../../packages/memory/test/v2-sqlite-atomic-test.ts)).
The runner seam test is the missing link.

---

## 7. How this augments `atomic-writes.md`

- **Corrects §1.4's implicit premise.** `atomic-writes.md` says "the op rides the
  same transaction's commit" and frames the headline as handler+row atomicity.
  This document shows the runner has **no single transaction** spanning a handler
  and a `sqliteExecute`; the seam binds to the **effect node's** tx. The plumbing
  in §1.4/§2 is correct; the **guarantee** must be restated as "atomic with the
  effect's own commit" (option c), with true handler-atomicity deferred to a new
  synchronous primitive (§3.4).
- **Confirms Stages 1–3 landed; Stages 4–5 are not implemented** (no
  `recordSqliteWrite`/`sqliteOps` in `runner/src/storage/`). §3.2 is the precise
  spec for those stages.
- **Resolves §6's open Stage-5 contract question** in favor of (a)
  (`AppliedCommit.sqliteResults`), with rationale (§5).
- **Aligns with `reactivity.md`:** keep the client `rev` bump, now folded into
  the same commit; server `markSpaceDirty(handle-id)` is the deferred hardening
  (§4).
