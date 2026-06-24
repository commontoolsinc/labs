# Lunch Poll — Multi-User Contention: Findings & Handoff

**Status:** root cause **instrumented and characterized**, no fix yet. The
immediate next step is a **value-equal write short-circuit** experiment (see §8).

## 0. TL;DR
The "poll takes foreverrr to pop in" on rapids is **NOT** the single-client load
(that's resolved). It's a **multi-user write-contention storm**: with just **3
connected clients**, ~15–20 **shared (`space`-scoped) derived cells**
(conditional-render `ifElse`/`when` results + their link targets) get redundantly
re-computed and re-written by *every* client. The writes are **value-identical**,
but conflict detection is **seq-based**, so each client's write to a cell another
client just bumped is rejected stale-seq → revert → re-run → re-read the bumped
cell → re-invalidate → **a non-terminating cross-client re-derivation cascade.**
Measured: **~27,000 commits / ~13,000 commit-conflicts across 3 browsers for a
STATIC 3-user / 3-option poll**, never quiescing. A user "joining" never sees the
poll settle.

---

## 1. Two DISTINCT problems — do not conflate them

### (A) Single-client slow load — RESOLVED
Cause: each option instantiated a heavy async cluster (per-option **web-search
`fetchData` + `generateText` LLM** + generated-art), `poll-option-card.tsx:343`
(`fetchedHomePageUrl`) alone was ~66% of node-time. The team landed **#4326**
(remove web-search) + **#4325** (remove generated-art) + runtime perf (#4292
schema interning, #4321, #4343). On latest main the single-client load node-time
dropped **3,968ms → 472ms (−88%)** and reruns collapsed. **Verified.** Details:
[`SLOW-LOAD-FINDINGS.md`](./SLOW-LOAD-FINDINGS.md). This is done; it is NOT the
rapids symptom.

### (B) Multi-user contention — THE REAL ISSUE (this doc)
Only reproduces with **multiple concurrent connected clients** (real
browser/async). Single-client and headless (`lunch-poll-diagnose.ts`) CANNOT show
it.

---

## 2. Root cause (current understanding, instrumented)

1. `if-else.ts` sets the result-cell scope to the **condition's** scope
   (`resultScope = resolvedCellScope(runtime, tx, conditionCell)`). Conditions
   derived from shared poll state (`options`/`votes`/counts) → **`space`-scoped
   (shared) result cells.** (Conditions on PerUser values like `isAdmin` →
   user-scoped results, which DON'T conflict — see §3.)
2. Every connected client independently re-computes these shared `ifElse`/`when`
   results and **writes them back to the same shared cell** (a write-redirect
   link).
3. The written value is **identical** across clients/runs, but conflict
   detection is **seq-based** (`findConflictSeq` in `memory/v2/engine.ts`). So
   client B's value-identical write to a cell client A just committed is rejected
   `ConflictError: stale confirmed read … conflicted with seq N` → optimistic
   value **reverted** → action **re-runs**.
4. Re-running re-reads the shared cell another client just bumped → invalidates →
   re-writes → conflicts again. With ~20 such shared cells × 3 clients this is a
   **self-sustaining cross-client cascade that never converges**, even though all
   values are already in agreement.

This is adjacent to the #4210/#4343 "reactive computes stranded by a commit
conflict" work and the conflict-granularity work (#4220/#4178).

---

## 3. RULED OUT — do not re-investigate (each verified)

- **"`ifElse` mints varying result ids"** — **FALSE.** Logged the actual writes:
  ids are **stable and identical across runs** (e.g. `cF_cYNxi → rEYM7Pc →
  IHe8BO1` in *both* runs). ⚠️ Opus (me) claimed varying-ids **twice** and was
  wrong both times — seefeld flagged this as a known confident-but-wrong pattern.
  **Verify any id-variance claim by logging before believing it.**
- **"`ifElse` appends to the link chain each run"** — **FALSE.** The chain is a
  stable 2-hop redirect, not growing across runs.
- **Single-client load / web-search / generated-art** as the multi-user cause —
  no; that's problem (A), already fixed.
- **Votes-array coarse write as the SOLE cause** — it's real (`castVote` does
  `votes.get()` over the whole array) and Ben's #4346 (per-user vote rows) halves
  it **headless** (102→46s), but the shared-derived-cell cascade is **separate
  and browser-only** — which is why his fix "isn't a silver bullet."
- **detectNonIdempotent flags as storm-proof** — it OVER-flags benign
  settle-to-fixed-point actions (write-once-then-noop) as "non-idempotent." Treat
  its output as a lead, then check the actual writes.

---

## 4. Evidence (from the harness run)

- Phase timings (3 profiles): navigate 1.9s, join 3.0s, **host-rotation+add →
  91.7s TIMEOUT (never converges)**. Bisecting to a *single* host adding options
  (no rotation, no votes) **still** times out → not concurrency of user actions.
- ChurnCounters per browser: `commitConflicts` 3,543–5,701, equal `commitReverts`,
  equal `scheduleRunErrors`; `commitRejected=0`, `eventLostRaces=0` (nothing
  dropped — it's a retry storm, not data loss).
- `CF_DEBUG_MEMORY_WRITES` histogram (toolshed log): **27,120/27,806 writes are
  `scope=space`; 96% `op=patch`; ~623 distinct entities with a hot core of ~15–20
  each written ~1,200×** while state is static.
- `detectNonIdempotent`: flagged ~20+ `raw:ifElse` + `raw:when` actions; the
  storming entities (`cF_cYNxi`, `Vo1Bjeq`, …) are read/written by `space`-scoped
  `ifElse` nodes with **stable ids** and value-identical (often no-op) writes.

---

## 5. Reproduction harness

**Wilk's multi-browser test** (the harness — reuse it):
```bash
# get it (it lives on Wilk's branch, not main):
git checkout origin/test/lunch-poll-browser-matrix -- \
  packages/patterns/integration/lunch-poll-two-browsers.test.ts
# run (spins up its own toolshed+shell; N real browser profiles via Playwright):
CFC_BROWSER_PROFILE_COUNT=3 HEADLESS=1 \
  deno task integration patterns lunch-poll-two-browsers
```
- Each profile = its own `Identity`; all join + add + vote **concurrently**
  (`Promise.all`). `StepTimer` times each phase. Reproduces the storm at 3.
- The storm shows as the "clients rotate host and add options" step timing out at
  90s with thousands of `commitConflicts`.
- **Bisect used (re-applicable):** replace that step's per-client
  become-host+add loop with **page 0 alone adding all options sequentially**, and
  change the vote-phase `adminName: names.at(-1)!` → `names[0]`. Result: still
  storms → isolates the shared-derived-cell cascade from vote/host concurrency.

**Helpers** (`packages/patterns/integration/cfc-browser-helpers.ts`, already on
main): `collectBrowserLoadSummary` (IPC `TimingStatRow` p50/p95/max +
`ChurnCounters`), `collectSchedulerLoadSummary` (graph + per-action runCount +
rehydration), `StepTimer`, `waitForRuntimeSynced`. These were built for exactly
this ("the multi-browser-slowness signal").

---

## 6. Instrumentation toolkit (all available now)

Page-side (via `globalThis.commonfabric`, needs a stable authed session — see §7):
- `commonfabric.rt.getGraphSnapshot()` → nodes w/ `stats.runCount`/`totalTime`,
  `type`, `scope`, reads/writes.
- `commonfabric.rt.getLoggerCounts()` → worker churn counts (the ChurnCounters).
- `commonfabric.getTimingStatsBreakdown()`, `detectNonIdempotent(ms)`,
  `getWriteStackTrace()` / `setWriteStackTraceMatchers([{entityId,path}])`.

Server-side:
- **`CF_DEBUG_MEMORY_WRITES=1`** — per-commit write trace `[memwrite] op=.. id=..
  scope=..`. ⚠️ Originally only hooked the *standalone* server; **I added the same
  hook to the toolshed route** (`packages/toolshed/routes/storage/memory/memory.handlers.ts`,
  logging-only, off by default) so it fires in the integration harness. Output →
  `packages/toolshed/local-dev-toolshed.log`. Histogram:
  `grep '\[memwrite\]' <log> | awk '{print $2,$4,$3}' | sort | uniq -c | sort -rn`.
  (Consider upstreaming this hook — the flag silently did nothing for toolshed.)
- `ConflictError` (`memory/v2/engine.ts:3517+`) names entity id + path + read-seq
  + conflicting-seq.

---

## 7. agent-browser — CRITICAL gotcha for authed CF testing
Use **`--profile <dir>`** (persistent on-disk profile), NOT `--session`. The CF
shell stores the identity in **IndexedDB**, which `--session` (in-memory) and
`state save/load` (cookies+localStorage only) **drop on navigation** — symptom:
`commonfabric.rt` keeps going `undefined` / login wall returns. With a persistent
profile, import `cf.key` once (Register → Import CLI Key → upload `cf.key` →
Import Key) and it persists. Profile used this session: `/tmp/rapids/cf-profile`.

---

## 8. ⭐ NEXT EXPERIMENT (Gideon's call): value-equal write short-circuit
**Hypothesis:** if a write's new value equals the currently-committed value,
don't conflict/revert it (or don't issue it at all). That alone should kill the
identical-rewrite churn, since the storm is value-identical writes losing the
seq race.

**Where to look:**
- Conflict detection — `memory/v2/engine.ts` `findConflictSeq` + the
  `ConflictError` throws (~3517). A value-equal check there could suppress the
  conflict/revert.
- Write path — `cell.ts` `setRaw`/`setRawUntyped`; `if-else.ts` `setRawUntyped`
  (the redirect-link write). A "skip if value unchanged" guard avoids the
  seq-bump entirely.

**Measure (use the harness §5):** `commitConflicts` should fall toward ~0; the
host-add phase should converge (no 90s timeout); `collectBrowserLoadSummary` IPC
p95 should drop.

**⚠️ Verify first:** there may ALREADY be a value-equal no-op short-circuit that's
being defeated here (e.g. for links/redirects specifically). Check before adding a
duplicate, and confirm where in the commit pipeline equality is/ isn't compared.

---

## 9. Open design questions (after the experiment)
- Should `space`-scoped `ifElse`/computed results be **written back to shared
  storage at all** by every client, vs computed-once / per-client-local? (The
  deeper architectural fix.)
- Is value-equal short-circuit *correct* (vs masking a legitimate same-value
  re-assert that another reader depends on)?
- How does this relate to #4210/#4343 (strand) and #4220/#4178
  (conflict-granularity)? Loop seefeld (TL) in on direction.
- Ben's #4346 (per-user vote rows) is the complementary **pattern-level** fix for
  the votes-array contention; this cascade is the **runtime-level** half.

## 10. Branch / artifacts
- Branch `gideon/lunch-poll-perf-load` (pushed; on latest main via merge).
- `perf-seed/seed.sh` + `data/` — single-client local seeder.
- `perf-seed/SLOW-LOAD-FINDINGS.md` — problem (A), resolved.
- `memory.handlers.ts` — `CF_DEBUG_MEMORY_WRITES` toolshed hook (committed, gated off).
- rapids slow poll: `https://rapids.saga-castor.ts.net/team-lunch/fid1:igKPgWkSa2iGQUuVhitTQPT0d845UtGANPvDdCSLpdc`
