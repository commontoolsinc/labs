# Plan — `reactOn: db` reactive re-query (the reverted feature, done right)

**Status:** design / test-first. Read-only investigation; **no feature code
changed**. Findings below were established empirically with throwaway
`_probe_*` tests on `feat/sqlite-builtin-impl` (deleted after capture).

**Goal.** Make `sqliteQuery({ db, sql, reactOn: db })` re-run after a committed
`sqliteExecute` write, so the query reflects new rows. This is **Phase 3 / M2b**
of [`../implementation-plan.md`](../implementation-plan.md) (lines 194–218) and
the reactive half of spec [`../05-reactivity.md`](../05-reactivity.md). It
supersedes the IMPLEMENTATION_LOG section "Reactivity loop (reactOn: db) —
ATTEMPTED, NOT yet reliable (corrected)" (lines 234–252), whose stated root
cause (a scheduler/dep-registration defect) is **wrong** — see §1.

---

## 0. TL;DR

- The reactivity mechanism — client post-commit **handle-cell bump** +
  `reactOn: db` read — **works, deterministically.** Proven 5/5 with a clean
  temp dir.
- The prior "deterministic failure" was a **test-isolation artifact**: the
  emulated server backs each cell-db with a **deterministic, persistent temp
  file** keyed by `(space, db.id)`. Re-running the suite accumulated rows in
  that file, so the query's *expected* result (`[{body:"hi"}]`) drifted to
  `[{body:"hi"},{body:"hi"},…]` and the assertion failed — even though the
  re-query fired correctly every time (the `requestHash` changed every run).
- **Chosen mechanism:** reinstate the client post-commit handle-bump (the
  reverted approach), unchanged in shape, plus a **proper isolated test**. The
  server-driven `markSpaceDirty` variant is documented as a future hardening but
  is **not** needed for v1 and carries its own risks (§4).

---

## 1. Root cause (empirically determined)

### 1a. The mechanism is sound — link-reached reactivity fires

Probe (effect subscribed via `runtime.scheduler.subscribe(action, undefined,
{ isEffect: true })`) that reads an `inputs` cell whose `reactOn` field is a
**link** to a separate `handle` cell, then mutates the handle via a *separate*
`runtime.editWithRetry`:

- The effect **re-runs** when the handle is written by the separate
  transaction. ✅
- `txToReactivityLog(tx)` for that run records reads on the **handle's entity
  id** reached via `value.reactOn → /link@1` — i.e. the dependency *is*
  registered through the link. The trigger index (`scheduler/trigger-index.ts`
  `addActionReads`, keyed on `space/scope/id` + paths) therefore subscribes the
  effect to the handle entity, and `processPullStorageNotification`
  ([`scheduler/pull-notifications.ts`](../../../packages/runner/src/scheduler/pull-notifications.ts))
  schedules it on the commit notification.
- This held for **both** `inputsCell.get()` (no schema) **and**
  `inputsCell.asSchema({type:"object",additionalProperties:true}).get()`. So,
  contra IMPLEMENTATION_LOG's candidate causes, *the no-schema whole read
  already registers the link dependency.* fetch-data's full-schema read
  (fetch-data.ts:32–70) is about **materializing nested values as plain objects
  vs proxies**, not about dep registration — the dep is recorded by the
  link-following read either way (`traverse.ts` records a `READ_FOR_SCHEDULING`
  on each linked doc address it follows: traverse.ts:866/906/932/1015/1128).

### 1b. The real builtin re-query fires too — proven 5×

Probe driving the **real** builtins through a pattern (query-only; the row was
written out-of-band via `runtime.storageManager.open(space).sqliteExecute(...)`,
then the handle bumped via `editWithRetry`):

```
RUN 1..5 (clean /tmp each run):
  first:  []                 hash: thX810…
  wrote a row server-side
  second: [{"body":"hi"}]    hash: eRKY4Ful…
  → 1 passed, 0 failed  (×5)
```

The query flipped `[]` → `[{body:"hi"}]` on **every** run. The `requestHash`
changed (`thX810…` → `eRKY4Ful…`) every run, proving (a) the effect re-ran and
(b) the dedup gate (`result.requestHash === hash`, sqlite-builtins.ts:197)
correctly let the fresh request through because `reactOn` (the bumped handle)
feeds the hash (sqlite-builtins.ts:188–193).

### 1c. Why it "failed deterministically" before — temp-file pollution

`Server.#cellDbPath`
([`packages/memory/v2/server.ts:672–679`](../../../packages/memory/v2/server.ts))
backs an emulated (in-memory) store's cell-db with a **deterministic temp
file**:

```ts
return Path.join(Deno.env.get("TMPDIR") ?? "/tmp", `cf-cell-${tag}.sqlite`);
// tag = `${hashToken(space)}-${hashToken(id)}`
```

For a **builtin-level** test the `db.id` is the handle cell's **causal entity
id** (`handle.entityId?.["/"]`, sqlite-builtins.ts:130), which is **stable
across runs** because the space (passphrase) and the pattern are identical →
**identical filename → rows persist on disk across Runtime instances and across
suite re-runs.** Confirmed: `/tmp/claude-501/cf-cell-…-fid1_….sqlite` files
remain after the test and grow.

Running the same probe **without** cleaning `/tmp`: `first` started at `[]`,
then `[hi]`, then `[hi,hi]`, … incrementing by one row per run — exactly the
"passed once, then deterministically failed" signature in the log. Cleaning
`/tmp` before each run → 5/5 green. **This is the root cause.**

The memory-layer protocol test already learned this lesson:
[`packages/memory/test/v2-sqlite-protocol-test.ts:15,36`](../../../packages/memory/test/v2-sqlite-protocol-test.ts)
uses a **unique `db.id` per test** (`of:test-db-${crypto.randomUUID()}`) "so the
(deterministic, persistent) cell-db file does not leak data across tests or
across suite runs." The reverted builtin test had no equivalent isolation.

---

## 2. Chosen mechanism — client post-commit handle-bump (reinstate, with a real test)

Reinstate the reverted change (commit `73bc10f60` undid it) essentially
verbatim — it was correct. Touch-points in
[`packages/runner/src/builtins/sqlite-builtins.ts`](../../../packages/runner/src/builtins/sqlite-builtins.ts):

1. **`SqliteDbRef` type (line 29).** Add the reactivity token:
   ```ts
   type SqliteDbRef = { id: string; tables?: Record<string, unknown>; rev?: number };
   ```
2. **`sqliteDatabase` seed (line 131).** Seed `rev: 0` so the field exists and
   the first query's hash is stable:
   ```ts
   handle.withTx(tx).set({ id, tables: options?.tables, rev: 0 });
   ```
3. **`sqliteExecute` flush (line ~289 / inside the post-commit `flush`,
   after the success `editWithRetry`).** Capture the handle cell before
   enqueueing (`const dbCell = inputsCell.key("db");`) and, in the **same**
   success `editWithRetry` that writes the execute result, bump it:
   ```ts
   const cur = dbCell.withTx(wtx).get() as { rev?: number } | undefined;
   dbCell.withTx(wtx).set({ ...(cur ?? {}), rev: (cur?.rev ?? 0) + 1 });
   ```
   Verified facts that make this correct:
   - `inputsCell.key("db")` is a **link to the handle cell**; `.set()` resolves
     with `"writeRedirect"` (cell.ts:902), so the write lands on the **handle
     entity** — the very entity the query's `reactOn: db` read subscribes to.
     (Probe: `result.key("db")` resolves to link id `of:fid1:…` path `["db"]`,
     and writing through it re-triggered the query.)
   - The bump rides the success `editWithRetry`, i.e. a **post-commit**
     transaction that runs only after the SQLite write is durable on the server
     (the write itself is the `sqlite.execute` RPC inside the same `flush`). So
     the re-query reads **committed** state — satisfying spec §05 "Committed,
     not in-flight." There is **no** readable semantic `version` exposed; `rev`
     is purely the reactivity token (spec §05 "the handle cell is the token").
   - `reactOn` feeds `computeInputHashFromValue` (sqlite-builtins.ts:192), so a
     bumped `rev` yields a new `requestHash`, defeating the committed-state
     dedup (line 197) and forcing a real re-issue. ✅

No scheduler changes are required. No `sqlite-query.ts` change is required
(that file does not exist yet at the builtin layer; the read is already
wholesale via `inputsCell.withTx(tx).get()`, sqlite-builtins.ts:172, which §1a
proved is sufficient for dep registration).

---

## 3. First deterministic failing test (write this first)

**File:** add to
[`packages/runner/test/sqlite-builtins.test.ts`](../../../packages/runner/test/sqlite-builtins.test.ts)
(replace the `NOTE:` comment block at lines 116–120 that documents the gap).

**Isolation — mandatory, this is what the prior attempt missed.** The cell-db
temp file is keyed by `(space, handle.id)` and the handle id is the *stable
causal entity id*, so two runs of the same pattern in the same space collide.
Pick **one** of these (prefer the first — least magic, matches the existing
suite's signer-based setup):

- **(A) Unique space per test.** In `beforeEach`, derive the space from a
  per-test random passphrase: `const signer = await
  Identity.fromPassphrase("sqlite-reacton-" + crypto.randomUUID());` and use
  `signer.did()` as the space for that test's `StorageManager.emulate({ as:
  signer })` + `runtime.getCell(space, …)`. Different space → different
  `hashToken(space)` → different temp file → no cross-run leakage. (The current
  module-level `const signer`/`space` is shared; this test needs its own.)
- **(B) Clean the temp file in `beforeEach`/`afterEach`:**
  `for (const e of Deno.readDirSync(Deno.env.get("TMPDIR") ?? "/tmp")) if
  (e.name.startsWith("cf-cell-")) Deno.removeSync(join(dir, e.name));` — coarser
  (nukes sibling tests' files); only use if (A) is awkward.

**Pattern shape** (mirrors the proven probe — query must settle empty first,
then a write + the implicit handle bump flips it):

```ts
it("reactOn: db re-runs the query after a committed sibling write", async () => {
  const pat = cf.pattern(() => {
    const db = cf.sqliteDatabase({
      tables: { notes: cf.table({ id: "integer primary key", body: "text" }) },
    });
    const exec = cf.sqliteExecute({
      db, sql: "INSERT INTO notes (body) VALUES (?)", params: ["hi"],
    });
    const q = cf.sqliteQuery({ db, sql: "SELECT body FROM notes", reactOn: db });
    return { exec, q };
  });
  const resultCell = runtime.getCell(space, "sqlite-reacton", pat.resultSchema, tx);
  const result = runtime.run(tx, pat, {}, resultCell);
  tx.commit();

  // Observe the WHOLE result so BOTH effects (exec + q) stay live in pull mode.
  const cancel = (result as any).sink(() => {});
  try {
    const qCell = (result as any).key("q");
    // The query must eventually reflect the sibling write’s row.
    const q = await waitUntil<QueryState>(
      runtime, qCell,
      (v) => v.pending === false && Array.isArray(v.result) && v.result.length === 1,
      120,
    );
    expect(q.error).toBeUndefined();
    expect(q.result).toEqual([{ body: "hi" }]);
  } finally {
    cancel?.();
    await runtime.idle();   // drain before dispose — see segfault note
  }
});
```

**Why this fails before the fix and passes after.** Without the `rev` bump, the
query may settle `[]` and never re-run after `exec` commits (whether it sees the
row on first run depends on effect ordering — see §6 "phantom green" risk),
so `length === 1` times out. With the bump, the committed write dirties the
handle → the query re-runs → `[{body:"hi"}]`. (Note: assert `length === 1`,
**not** `> 0`, so accumulation from any leakage still fails loudly rather than
masking a regression.)

**Wait/idle approach (reliable pull-mode driver).** Reuse the existing
`waitUntil` helper (sqlite-builtins.test.ts:130–155): it opens a `cell.sink(()
=> {})` to keep the effect chain **observed** (pull mode only runs effects while
demanded), loops `await runtime.idle()` + a 15ms `setTimeout` yield, and
**cancels the sink in `finally`**. Observe the **whole `result`** (not just
`q`) so the `exec` effect is also demanded — otherwise the write effect may not
run. The `await runtime.idle()` in the test's own `finally` (before
`afterEach` disposes) is what prevents the FFI-after-dispose segfault (§6).

---

## 4. Server-driven `markSpaceDirty` alternative (documented, NOT chosen for v1)

Spec §05 mechanism 1 prefers a server hook: in `Server.sqliteExecute`
([`server.ts:708–733`](../../../packages/memory/v2/server.ts)) after a
successful `runWrite`, call
`this.markSpaceDirty(message.space, [toDirtyKey(message.db.id)])` (the same call
`server.ts:622` already uses for an entity write; `toDirtyKey` at
[`query.ts:722`](../../../packages/memory/v2/query.ts)). The session push then
re-runs the query only after durable commit.

**Why defer it:**

- **Id-form mismatch (must verify first).** The handle entity in the runner is
  `of:fid1:…` but the stored `SqliteDbRef.id` is `fid1:…` (no `of:` prefix —
  `handle.entityId?.["/"]`, sqlite-builtins.ts:130). `markSpaceDirty` keys on
  the **storage** entity id; passing the bare `db.id` would dirty the wrong (or
  no) entity and silently fail to trigger. Needs an id-normalization step and a
  test before it can be trusted.
- **No new value to diff.** A dirty signal with no value change relies on the
  notification path treating the entity as changed; the client-bump path
  changes an actual cell value (`rev`), which is unambiguously a change for
  `determineTriggeredActions` (reactive-dependencies.ts). The client path is the
  one we have *proven*.
- **Atomicity coupling.** The clean server-driven version wants the dirty to
  ride the **same commit** as the rows, which only exists once Phase 2 folds the
  `sqlite` op into `applyCommitTransaction`. Until then a separate
  `markSpaceDirty` after a separate write RPC has the same "two RPCs" ordering
  as the client bump, with less proven behavior.

Recommendation: ship the client-bump now (Phase 3); revisit the server hook as a
hardening once atomic writes land (Phase 2, see
[`./atomic-writes.md`](./atomic-writes.md)), at which point dirtying the handle
entity inside the commit is natural and the `rev` field can be dropped.

---

## 5. The general scheduler feature this still motivates

Spec §05 "A general feature this motivates" (commit-only reads) remains the
right long-term shape: a `committedReads`/commit-only input annotation would let
`sqliteQuery` declare `reactOn` as commit-only and drop the manual `rev` bump
entirely. Out of scope for v1; tracked in
[`../08-open-questions.md`](../08-open-questions.md). Not required by this plan.

---

## 6. Risks & how to confirm green deterministically

- **(R1) Temp-file leakage (the root cause itself).** If the new test omits the
  §3 isolation, it will pass once then fail — the exact trap that produced the
  reverted-then-deleted test. **Mitigation:** unique-space-per-test (§3 A) +
  assert exact `length === 1`. **Confirm:** run the single test **5×** with a
  *dirty* `/tmp` (do not clean between runs) and require 5/5 green — that proves
  isolation, not just luck:
  ```
  for i in 1 2 3 4 5; do deno test --allow-all \
    --filter "reactOn: db re-runs" packages/runner/test/sqlite-builtins.test.ts; done
  ```
- **(R2) Phantom green from effect ordering.** In a single pattern, the query
  effect may happen to first-run *after* the sibling write already committed,
  returning `[{body:"hi"}]` on the **first** settle with no re-run at all — so a
  naive test passes even with a broken bump. **Mitigation:** the decisive test
  must force an **empty-first** settle (the §3 probe did this by writing
  out-of-band). For the in-pattern test, additionally assert the query went
  through ≥2 distinct `requestHash` values (read `qCell.get().requestHash`
  before vs after), or keep a dedicated query-only variant that observes `[]`
  then the row. Recommend **both** an in-pattern test and a query-only +
  out-of-band-write test (the latter is the unambiguous one).
- **(R3) FFI-after-dispose segfault.** Learned this session: a `cell.sink`/
  effect chain that is still live when the test disposes the Runtime can re-enter
  `@db/sqlite` after the engine is disposed → **segfault** (hard crash, not a
  test failure). **Mitigation:** always `cancel()` the sink and `await
  runtime.idle()` in `finally` *before* `afterEach` runs `runtime.dispose()` /
  `storageManager.close()`; never leave an unawaited background loop calling the
  provider. The existing `waitUntil` + `afterEach` ordering already does this —
  do not bypass it.
- **(R4) Hash stability of the seed.** `sqliteDatabase` must seed `rev: 0` (not
  omit it) so the *first* query's hash already accounts for the field; otherwise
  the first post-write bump from `undefined`→`1` is the first hash change and an
  earlier no-rev read could collide. Covered by step 2 in §2.
- **(R5) Cross-space injected handles.** Out of scope (spec §05 cross-space
  wrinkle): injected service-space dbs are read-mostly (`reactOn` omitted) for
  v1. The bump path is same-space (handle lives in the pattern's space).

**Done bar:** the new isolated test passes 5/5 on a dirty `/tmp`; the existing
3 builtin tests + memory sqlite tests stay green; `deno fmt`/`lint`/`check`
clean.

---

## 7. How this augments `implementation-plan.md`

- **Phase 3 (lines 194–218)** currently lists the **server `markSpaceDirty`**
  hook as primary and the client bump as "Fallback." **Invert that for v1:** the
  client post-commit handle-bump is the **primary, proven** mechanism; the
  server hook is a deferred hardening gated on Phase 2 atomic writes and an
  id-normalization fix (§4). Update the Phase 3 "Files & work" bullets
  accordingly and point them at this plan.
- The Phase 3 **Tests** bullet ("assert no re-run against optimistic in-flight
  state") should reference §3/§6 here: the committed-state guarantee comes from
  bumping inside the success `editWithRetry` (post durable commit), and the test
  must force an empty-first settle (R2) with unique-space isolation (R1).
- IMPLEMENTATION_LOG's "Reactivity loop … NOT yet reliable (corrected)" section
  (lines 234–252) should be updated: the root cause was **test-file pollution
  from the deterministic persistent cell-db temp file**, not a scheduler /
  dep-registration defect. Link-reached `reactOn` dependency registration and
  the post-commit handle-bump re-query were verified working 5/5.
