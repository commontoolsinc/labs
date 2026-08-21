---
status: historical
created: 2026-08-19
reason: "Stage-C W1 (d′) FIX report: the disposition of every finding in the independent review of PR #6029 (0 BLOCKER / 3 MAJOR / 9 MINOR / 6 NIT), with the fixing SHA and the red/green mutation evidence per pin. The (d′) mechanism held; the fixes were pin honesty (three MAJORs were vacuous pins) plus register/spec/label honesty. Companion to w1-dprime-review-report.md beside it."
---

# W1 (d′) — independent-review fix report (PR #6029)

Head fixed: `claude/server-exec-v2-w1-dprime`, reviewed at `19c6448ab`.
Base: `claude/server-exec-v2-stage-c-design` @ `461b01822`.
Every deno invocation `--no-lock`; suites FOREGROUND under the package task;
mutation probes applied by a one-line edit, run, then reverted.

## Verdict carried

The reviewer returned **LANDABLE-WITH-FIXES** (0 BLOCKER / 3 MAJOR / 9 MINOR
/ 6 NIT). The (d′) mechanism was correct by inspection and by the probes that
bite (M-A1, M-D, M-G); the three MAJORs were about the PINS and the REGISTER,
not the code. All findings are dispositioned below.

## MAJOR

- **MAJOR-1 — P-arrival did not pin the per-key currency check; the build
  report's killing mutation for it was refuted.** **FIXED** @ `ef9784b11`.
  P-arrival now ASSERTS `stats.demand.notCurrentRearms` +1 (and
  `demandArrivals` +1). NEW pin **P-arrival-closure** builds the
  non-root-growth case of design §2.2: a second principal (Bob) whose only
  watch root is a plain holder doc linking cross-piece to a nested child's
  per-user `echo` reaches that narrowed writer's output doc ONLY through
  non-root closure rows; the root-level arrival re-arm keys on piece roots
  (Bob roots none), so only `rearmNotCurrentForDemander` can materialize his
  instance. Red/green: baseline GREEN (8 steps); **M-C**
  (`rearmNotCurrentForDemander` returns 0) → BOTH P-arrival (`notCurrentRearms
  +0`) and P-arrival-closure (landing timeout) RED. The build report's
  P-arrival row is corrected in place with a dated note (REFUTED; history
  preserved).

- **MAJOR-2 — P-coarse never exercised a root release (1→0 unpinned).**
  **FIXED** @ `a6e0fb3c1`. NEW pin **P-release**: Alice creates+watches a
  SHARED piece; Bob creates+watches a SOLO piece (a creator's session tracks
  every doc its run pulled, so the releasing writer must be created by the
  departing session). Bob leaves → the solo `label` writer's space key departs
  with no remaining pair → `leaveDemandedEntity` 1→0 → `demandedWriters` drops,
  `demandRootLeaves` +N, and a later write to the solo input does NOT re-derive
  (dormant); the shared writer stays a root and re-derives. Red/green: baseline
  GREEN; **M-B** (`leaveDemandedEntity` a no-op) → writers 4→4, leaves 0,
  `label:2` re-derives, RED. **M-I** (`before <= 2` early release) — **DISPUTED
  / GREEN by construction**: writer entities are SPACE-keyed, so their refcount
  is always 1; the refcount>1 branch is reached only by writerless entities
  (the session-scoped effects doc at before=2, the per-user narrowed rows —
  DIAG-2), so `before <= 2` alters no writer's liveness. No multi-key writer
  entity is reachable in the demand-set's shape without inventing a doc the
  workload never produces; recorded, not forced (the reviewer already observed
  "no multi-key writer entity in the suite").

- **MAJOR-3 — T2′-cross / T3′ pinned the notify COUNTER; the landing was
  vacuous.** **FIXED (partial) + RECORDED** @ `cddb50dad`. The cross-piece /
  array-growth pins are reworked (`standUpCrossGrowth`): Alice creates P1+P2
  and DEPARTS; a non-runner (Carol) makes `leaf` STALE; Carol fires the link;
  the FRESH `leaf:6` LANDS server-side and `demandedWriters` goes 0→1 — the
  landing (a value never client-committed) is now the assertion, `pushGrowthWakes`
  +1 secondary. Red/green: baseline GREEN; **M-D** (remove both push-growth
  notify sites) → the growth pins fail on `pushGrowthWakes`. The reviewer's
  "RED under M-E" for the cross-piece pins is **NOT achieved and RECORDED as
  the sanctioned split**: `leaf` is SPACE-scoped, so Carol's served handler run
  makes it live through its own read edge (design §2.3(ii)) and it lands
  regardless of the demand pass — M-E does not bite the cross-piece pins. The
  M-E kill (closure-row consumption load-bearing for a landing) is a PER-USER
  property and IS pinned by **P-arrival-closure**, which goes RED under M-E (a
  demander's own per-user instance, reached only through her non-root closure
  row, is starved). Forcing a per-user narrowing in a departed-creator growth
  is unreachable in the fan-out machinery (leaf never narrows for the arriving
  demander); the reviewer's fix note sanctioned recording this rather than
  faking it (design §2.8).

## MINOR

- **MINOR-1 — a demand wake lost to the idle window when a pass straddles
  cycles.** **HARDENED** @ `881312835`. A monotonic `#demandNoteGeneration` is
  bumped on every `noteDemandChanged`; the pass snapshots it at its row read;
  the loadPass `.finally` re-latches `#pendingDemandWake` if it moved during
  the pass, so the next wait runs a FRESH pass. Cheap and bounded (only a note
  arriving mid-pass costs one extra pass). A DETERMINISTIC pin for the timing
  schedule is impractical (the review itself states it as a real-time
  interleaving); the re-latch is correct by construction and guarded by the
  existing straddling-pass suites staying green.

- **MINOR-2 — `demandRootEnters/Leaves` under-count hook-driven transitions
  between passes.** **FIXED** @ `ea7e1a4ab`. `#foldDemandRootDelta` folds the
  delta SINCE THE LAST FOLD (`#lastFoldedDemand*`) at every pass AND before park
  disposes the runtime; `#lastFoldedDemand*` reset to 0 when the runtime is
  replaced (activate). Pinned: within a tenure the space-lived accumulators
  equal the scheduler's running counters exactly (conservation; a double-fold or
  mis-snapshot breaks it). The specific between-pass event-dispatch transition
  is not deterministically reproduced in the unit suite (T1′ has no such
  transition, so the old pass-start snapshot passes the conservation there too);
  the fix is correct by construction (lastFolded persists across passes).

- **MINOR-3 — `demandPassMs` labeled "reconcile cost" but is wall time.**
  **FIXED** @ `881312835`. Relabeled (stats.ts + serving-loop.md §7): WALL time
  INCLUDING the awaited structure-load segments, not pure O(rows) reconcile.

- **MINOR-4 — settle `class` attribution + unfiltered push-growth notify.**
  **(a) FIXED** @ `881312835` / `ea7e1a4ab` (text): stats.ts and serving-loop.md
  §7 now label the `class` as promoted by ADJACENCY (a wake AFTER coverage +
  the next derived commit), NOT "a wake between admission and coverage", and
  state a growth from an unrelated later input can land on the row. **(b) FIXED**
  @ `566eebd91`: the push-growth notify is principal-filtered — the memory
  server threads the changed session's principal (all four notify sites) and the
  ExecutorHost drops notifies whose principal is the service identity (the
  serving graph's own reads). Pinned red-first in
  `test/v2-demand-changed-principal.test.ts` (principal→undefined RED). Register
  caveat recorded: the W0/W1 `structural-growth` p50 was adjacency-attributed
  AND included ~2/20 service-driven growth notifies per (d′) run.

- **MINOR-5 — T10′ vacuous in the (d′) suite.** **NOT CHANGED (recorded).** The
  equivalence hook's real guard is fan-out's M-A2 (drop the disjunct from
  `recomputeLiveRefs` only → RED in `executor-fan-out`, `liveness drift …
  incremental=1 rebuilt=0`), which the build report already records; the (d′)
  suite's demanded writers read only authored docs (no upstream scheduler
  writer), so its T10′ is a smoke check. The starvation-witness pin the reviewer
  named is not built (the fan-out guard covers the disjunct); recorded in the
  register.

- **MINOR-6 — the O(closure) demand pass runs every wave inside the settle
  race.** **OWED (register row OW41).** Measured 4.9 ms/pass at 1 922 rows / 823
  keys, linear (~100 ms at ~40 K rows); sub-second today, not a hole. The
  incremental-delta exposure (a per-space demand generation on the memory
  server) is the named follow-on; NOT built here (rebase-risk for the W3
  builder). `demandPassMs` is the witness. Recorded per the reviewer's sanction.

- **MINOR-7 — settle-attribution state survives park.** **FIXED** @ `881312835`.
  Park clears `#pendingSettles` / `#lastCovered` / `#growthAwaitingLanding` so
  settle timings never cross a park boundary.

- **MINOR-8 — the OFF-arm `commitWatchState` Set diff runs with no observer.**
  **FIXED** @ `881312835`. The Set-membership change detection is gated on the
  demand observer being attached (dead work off the serving posture). The
  other OFF-reachable addition (the empty-Set `has` in `isDemandRoot`) is
  NOT CHANGED (no behaviour change, negligible).

- **MINOR-9 — register/spec rows overstate red-firstness.** **FIXED** @
  `ff128df78`. The three build-delta coverage rows are re-worded to what is now
  genuinely red-first (P-arrival-closure/M-C; P-release/M-B; the growth landing
  M-D and the M-E closure kill via P-arrival-closure); OW39's red-first claim is
  now accurate.

## NIT

- **NIT-1 — settle series type omits runtime fields; internal bookkeeping
  leaks; shallow copy.** **FIXED** @ `881312835`. Added `msGrowth` /
  `growthWaves` / `graceMs` / `growthLandedAt` to the type; moved
  `growthWakeAt` / `wavesAtCoverage` onto a `#lastCovered` WRAPPER so they no
  longer leak into the JSON; `host.stats()` deep-copies the series entries.
- **NIT-2 — stale demand-walk comments.** **FIXED** @ `881312835`
  (facade `fanOutStateOf`, `#demandersByKey` doc, executor-space-server test).
- **NIT-3 — `watchedRootsForSpace` production-dead.** **FIXED** @ `881312835`
  (marked `@deprecated`; the witnesses named for migration).
- **NIT-4 — `currentKeys` duplicates `rowByKey`'s key set.** **FIXED** @
  `881312835` (dropped; `rowByKey.has` suffices).
- **NIT-5 — `pushGrowthWakes` / `watchWakes` count NOTIFIES, names say
  "wakes".** **FIXED** @ `881312835` (stats.ts + §7 say pre-coalescing notify
  counts).
- **NIT-6 — the `commitWatchState` notify carries `push-growth` for a SHRINK
  too.** **NOT CHANGED (noted)** @ `881312835` (benign; a distinct reason buys
  nothing the pass does not handle).

## Also carried (from the W2 builder / brief)

- **Ruling item 10 — scopes.md §9's ragged tripwire.** **LANDED** @ `ff128df78`.
  §9 now permits ragged instance sets BELOW the space→user hop (§2's RULED
  stage-B mechanism, 2026-08-16 / design §5 item 10) while forbidding them AT
  the hop. The §7 counter-list omission the same drift note named was already
  folded in by W1.
- **`W0_FLAG4_SCAN` / per-row engine read regression check.** None: `grep`
  finds no `W0_FLAG4_SCAN`; the only `Engine.read` in space-server.ts is the
  pre-existing structure-load helper (`#confirmNoPatternMeta` path), NOT in the
  demand pass.

## Suite evidence (all FOREGROUND, `--no-lock`)

- `executor-dprime-w0` (package task, `SCHEDULER_LIVENESS_EQUIVALENCE=1`):
  1 passed / 8 steps.
- Equivalence batch (dprime + fan-out + space-server + serving-loop),
  `SCHEDULER_LIVENESS_EQUIVALENCE=1`: 4 passed / 57 steps.
- Memory: `v2-demand-changed-principal` added, green; full memory suite (below).
- Mutation probes reproduced: M-C RED (P-arrival + P-arrival-closure), M-B RED
  (P-release), M-D/M-E as tabulated, M-I GREEN (recorded).

(Full six-suite + check-docs counts are recorded in the PR body's corrected
test plan and the ledger comment on #6029.)

## What was NOT done (and why)

- A deterministic pin for MINOR-1's straddling-pass timing (impractical; the
  re-latch is by construction).
- The MINOR-6 incremental-delta exposure (OWED, OW41 — rebase-risk for W3).
- The MINOR-5 starvation-witness pin (the fan-out M-A2 guard covers the
  disjunct).
- Forcing M-E RED on the cross-piece growth pins (unreachable per the read-edge
  path; the M-E kill lives in P-arrival-closure).
