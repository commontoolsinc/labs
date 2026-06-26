# Lunch-Poll / Resume / Runtime — Open-Threads Map

_Living index of this investigation's open threads. **Transient working notes** —
intentionally NOT on `main`; tracked in git on the `gideon/lunch-poll-perf-load`
branch so it survives branch cleanup. **Last updated: 2026-06-26.**_

This doc is the **map**. The deep-dives live next to it in `perf-seed/`:
- [`IDENTITY-DIVERGENCE-HANDOFF.md`](./IDENTITY-DIVERGENCE-HANDOFF.md) — the storm root cause (cell-identity divergence)
- [`MULTI-USER-CONTENTION-HANDOFF.md`](./MULTI-USER-CONTENTION-HANDOFF.md) — multi-user contention findings (premise superseded; instrumentation history)
- [`SLOW-LOAD-FINDINGS.md`](./SLOW-LOAD-FINDINGS.md) — single-client slow load (resolved)

## TL;DR status
- ✅ The original write-storm / cell-identity divergence is **fixed & merged** (#4360 + supporting).
- 🟢 The resume / list-settling / flicker cluster is **active and converging** on a "read-mostly resume" direction (#4366 merged; #4367 in flight).
- 🟡 The **scopes question** (deepest architectural lever) and the **strand general-mechanism** remain open; both need seefeld and are at risk of being lost.

---

## ✅ Resolved
- **Write-storm / fresh-vs-resume cell-identity divergence** — **#4360** (merged 06-25):
  `awaitSync` lifted out-of-band + canonical schema interning. ~27.8k → ~2.1k writes.
  Supporting merges: **#4292** (intern schemas in sync frames), **#4220** (conflict-granularity /
  distinct-key over-conflict), **#4353** (`onlyIfDifferent` skip). Single-client slow-load resolved
  earlier (#4326/#4325 + runtime perf). See IDENTITY-DIVERGENCE-HANDOFF.md.

---

## 🟡 Open threads

### 1. Scopes question — conditional-result scope (user vs space)
**[ARCHITECTURAL · owner: seefeld · untracked]**
`ifElse`/`when`/computed result cells inherit the **scope of their condition**
(`if-else.ts` sets the result-cell scope to the condition's resolved scope). A condition over
*shared* (PerSpace) state → a **`space`-scoped (shared)** result that *every* connected client
re-computes and writes back to the **one** shared slot. #4360 made that case *safe* (ids converge →
repeated writes go value-equal → terminate), but the architectural question is untouched:
**should shared-condition `ifElse`/computed results be written to shared storage by every client at
all, vs computed-once / per-client-local?** Independent lever — resolving it would also kill the
storm class. Needs seefeld's call (runtime scope semantics). Detail: IDENTITY §PENDING, MULTI-USER §9.

### 2. Resume / list-settling / flicker
**[ACTIVE · cross-team]**
Vote-flicker-on-reload root cause = **resume init-order** (`send([])` clobbering the synced list) +
the **conflict-rollback window** (an optimistic compute writes a value, the newer durable doc arrives
and rolls it back, leaving a transient `undefined` while the confirmed value re-derives). *Not* the storm.
- **#4365** (Wilk, runner preserve) — CLOSED (superseded).
- **#4366** (HTML VDOM list settling) — MERGED 06-26. Our trust-boundary review of the
  authorship-boundary-reset fix is the last open verification (workflow `wgnb7wvd5`, running).
- **#4367** (Hixie, read-mostly resume) — OPEN, in flight. Converged direction: **pull each level's
  durable doc *before* the optimistic compute** (extend the owned-cell pre-sync to the dynamic
  per-element child cells *and* the input list), so no level ever reads a transient `undefined`.
  Standing offer: cross-check his branch against the live lunch-poll repro when it lands.
- **Meta-question (open, strategic):** is read-mostly resume patching a fundamentally racy resume
  architecture? When do the per-builtin pulls get promoted to a single runtime invariant? *Tell:* if
  you're adding the same pull at every builtin/level, lift it into the runtime.

### 3. Reactive-conflict "strand" (#4210/#4343 family)
**[PARTIALLY OPEN]**
Reactive computes stranded by commit-conflict retries under real async load. **#4210 + #4343 + #4220**
merged. But the resume conflict-rollback (thread 2) is the *same mechanism* — so resume work *is*
strand work; the general "conflict-revert under async load" question persists, partially addressed by
read-mostly resume. No deterministic in-process repro (needs a white-box storage seam — re-confirmed
this session). See memory note `reactive-conflict-strand-repro`.

### 4. Open PRs / loose ends
- **#4361** (ours — gated per-connection memwrite trace) — fixed (now derives `vhash` from the
  canonical Fabric value-hash), **awaiting merge**.
- **#4346** (Ben — "Localize lunch poll vote writes" / per-user vote rows) — OPEN; the pattern-level
  complement to the storm fix. Status check needed.
- **#4349** (Wilk — "lunch poll runtime convergence") — OPEN; the early mitigation
  (retry-narrowing + UI-reconciler), almost certainly superseded by #4360/#4366/#4367 → likely should close.

### 5. Tooling / smaller follow-ups
**[mostly untracked]**
- **otel follow-up** — promote the gated memwrite console trace to structured OpenTelemetry signals:
  low-cardinality **metrics** (writes by scope/op) + high-cardinality detail on **sampled span events**.
  Cardinality design is the bulk. Not started.
- **Flaky `notebook reload` CI test** — "reloads every rapidly created notebook note" (timed out on a
  `waitFor`, cleared on re-run). Hypothesised same strand/compute-retry. Cheap first step (flake-rate
  on `main`'s recent CI) **never done**; now also worth checking whether #4366/#4367 help it.
- **Deployed demo** — cf-pr-wt `:8100` tailnet demo of #4360, still live (kept). Tear down via
  `scripts/share-pattern-via-tailscale.sh --down`, or redeploy from a branch with #4361 for real metrics.

### 6. Comms
- **Loop seefeld in** — on #4360 (his interning subsystem, merged) and especially the **scopes
  question (#1)**, which needs his architectural call. He was on vacation.

---

## Cross-team note
Wilk's, Hixie's, and our agents independently converged on **read-mostly resume / pull-before-compute**
as the principled fix for the resume-flicker family. Shared insight: the "not-loaded vs settled
`undefined`" question is **fractal** (input list, per-element children, nested lists) and
**unclassifiable at read time** (the conflict-rollback window — a loaded doc can read `undefined`
mid-rollback), so the fix is to **pull durable docs before computing** rather than classify reads.

## At risk of being lost (no tracker but this doc)
The scopes question (#1), the strand general-mechanism (#3), the otel + flaky-notebook follow-ups (#5),
and the read-mostly-resume meta-question (#2) live only in handoff docs on `gideon/*` branches. Before
deleting those branches, capture these in Linear.

---

## Parked artifacts / branches
- `gideon/lunch-poll-perf-load` (this branch) — the investigation's git home: handoff docs + perf-seed
  seeder + the two-browser repro harness + this map.
- `gideon/list-resume-childsync` — parked offering (our `child.sync()`-based preserve; superseded by
  the read-mostly direction in #4367; kept for reference, deletable).
- `gideon/memwrite-trace` (#4361) — open PR, awaiting merge.
