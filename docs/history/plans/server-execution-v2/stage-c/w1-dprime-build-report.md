---
status: historical
created: 2026-08-19
reason: "Stage-C build W1 — (d′) proper: demand is memory v2's tracked-ids closure, the serving loop runs the stale writers of demanded instances, and the per-demander demand walk is DELETED. The build report: what was built, the flag-don't-fill decisions, the pins with their killing mutations, the six-suite counts, and the provisional chat smoke."
---

# Stage C — W1: (d′) proper (server-execution v2)

Date: 2026-08-19. Base: the stage-C design branch tip `c3ec7fc7b`
(`claude/server-exec-v2-stage-c-design`). Branch
`claude/server-exec-v2-w1-dprime`, a STACKED PR off the design branch
(no CI — every green below is a local run, said with counts). Starting
point: the W0 (d′) scratch commits (`9f70f3900` build, `49e113d12` fmt,
`5ebe838c6` pins, `2d6efb18d` flag-4 gate) cherry-picked onto the tip;
W1 then hardened them to production per the brief's three non-optional
obligations. Every deno invocation `--no-lock`.

## 0. Verdict

W1 lands (d′) as CODE, closing verification-coverage.md OW39 and removing
serving-loop.md §1's spec-ahead-of-code marker. The per-demander demand
walk is deleted (`grep -r demand-walk packages/*/src` finds no code);
demand is `demandedInstancesForSpace` (the tracked-ids closure); the
serving loop marks the writers of demanded instances as standing
`demandedWriters` roots (§8-bracketed) and runs the stale ones; a
push-growth `demandChanged` carries structural growth. Pins red-first
with recorded killing mutations; `SCHEDULER_LIVENESS_EQUIVALENCE=1` green
(T10′).

## 1. What was built (files)

Net diff vs `c3ec7fc7b`: 11 files, +1925 / −269.

**Memory server** (`packages/memory/v2/server.ts`, +184):
- `demandedInstancesForSpace(space, {excludePrincipal})` — the demand
  set: rows `(id, scope, scopeKey, identity, root)` = ⋃ over the space's
  CLIENT sessions of `session.trackedIds`, service principal excluded,
  one row per (instance key, session); `root:true` on watch ROOTS (root
  keys unioned in from the watch specs, so a root the tracker has not
  keyed still carries what `watchedRootsForSpace` carried). Anonymous
  sessions contribute keys, no principal. O(closure) per call.
- The push-growth `demandChanged(space, "push-growth")` notify — TWO
  sites: the incremental `commitEntities` growth (tracked set grew) and
  the full-evaluation `commitWatchState` change. Reason-tagged; the
  observer signature gained `reason?: "watch" | "push-growth"`.
- `demandSetSizesForSpace` — a standalone diagnostic (tests only; NOT
  called per pass — see obligation (i)).

**Scheduler** (`packages/runner/src/scheduler/`):
- `node-record.ts`: `NodeRegistry.demandedWriters: Set<Action>` +
  `isDemandedWriter()` — the standing root kind, held on the registry so
  every liveness-state bundle sees it with no plumbing. Empty off the
  serving posture (T9′).
- `dependency-graph.ts`: `isDemandRoot` gains the `isDemandedWriter`
  disjunct; `recomputeLiveRefs` (the equivalence reference) too.
- `scheduling-writes.ts`: `onWriterEntitiesChanged(action, added,
  removed)` hook (fired from `updateWriterIndex` and `clearAction`) — the
  registration / unregistration bracket seat; undefined off the posture.
- `facade.ts`: `enterDemandedEntity` / `leaveDemandedEntity` (refcount
  per scope-NAME entity; 0→1 / 1→0 brackets each writer: wasLive → flip →
  `notifyNodeLivenessChange`, dirty-and-live queued pending),
  `rearmNotCurrentForDemander` (the currency check: `keyAtRatchet` not in
  `fanOut.clean` ⇒ `markActionInvalid(..., {fanOutInstances:"keep"})` +
  pending), `demandedWriterCount` / `demandedEntityCount` /
  `demandRootCounters`. The registration hook installs lazily on the
  first `enter`.

**SpaceServer** (`packages/runner/src/executor/space-server.ts`, +549):
- `#loadDemandedStructure` is the DEMAND PASS over
  `demandedInstancesForSpace`: `#demandersByKey` keyed by instance key
  over EVERY row; departed keys → `leaveDemandedEntity` (+ load-state
  cleanup); new keys → `enterDemandedEntity`; new (key, pair) →
  `rearmNotCurrentForDemander`; root-level arrival re-arm kept; the
  structure load per ROOT unchanged; the walk install gone.
- DELETED `#installDemandWalk`, `#demandSinks`, the `demand-walk:*`
  effects and their teardown.
- Flag 6 index: `#keysByRootId` / `#keysByResolvedRoot` so `#demandersFor`
  is a lookup, not a full key scan (load-bearing at closure scale).
- The (d′) `demand` counter block + the `settle` series in the stats.

**Stats/host** (`stats.ts` +72, `host.ts`): the `demand` block reshaped
to the brief's fields (no `walkRuns`); the `settle` series; deep-copied
in `stats()`.

**Tests** (`executor-dprime-w0.test.ts` +1029; `executor-fan-out.test.ts`;
`executor-space-server.test.ts`): the (d′) pins (below); fan-out (f)'s
walk half retired into a T9′ witness; the space-server demand seams feed
`demandedInstancesForSpace` rows.

## 2. Decisions (flag-don't-fill), with rationale

1. **`demandedWriters` seat: the `NodeRegistry` (not `SchedulerLivenessState`).**
   Zero plumbing — `nodes` is on every liveness-state bundle. Alternative
   (a field on the liveness state) named; W0's simplest-option choice
   kept because the equivalence hook proves it sound.
2. **Refcount per scope-NAME entity (not per instance key).** Two
   instances of one doc (`user:alice`, `user:bob`) name ONE entity whose
   one node writes both (C11b node-level topology); the per-instance
   distinction is the currency check, not the liveness bracket.
   Alternative (per-instance-key refcount) named; not needed — a writer
   is a demand root iff ANY of its instances is demanded.
3. **A writer with NO fan-out record is left to liveness alone**
   (currency check's "the check adds nothing" — design §2.2 step 3). An
   undemanded-narrowed fallback run with a later demander is not re-armed
   by the per-key check (pre-existing residual — flag 5).
4. **Departed keys detected only when a pass runs** (input cycle, watch
   wake, push-growth wake) — no notify on session close (R-D coarse).
5. **The push-growth notify fires per push pass per session**, coalesced
   by the existing 300 ms grace; no de-dup across sessions; NO separate
   coalescing added (flag 2 — W0's numbers did not force it).
6. **The demand pass does NO per-row engine read** (obligation (i)): the
   W0 flag-4 pass-end scan (`W0_FLAG4_SCAN`, an `Engine.read` per
   no-writer candidate) is DELETED; the per-pass `demandSetSizesForSpace`
   union rebuild is removed. The pass is O(rows) map reconcile of the
   O(closure) exposure. The flag-4 count is dropped (W0 measured it once:
   chat 2 / note 19 / lunch 0 — register future row).
7. **`demandRootEnters/Leaves` accumulate on the space-lived stats**
   (obligation (iii)) via a per-pass delta snapshotted against the
   runtime's counters (which zero on reactivation) — surviving park.
8. **`#demandersFor` indexed by root id / resolved root** (obligation
   (ii)) — kept from the scratch; load-bearing at 800–1 700 keys.
9. **The demand-set exposure is O(closure) per pass, not incremental.**
   The accepted W1 cost (W0: O(rows) reconcile 3.8–5.3 ms at 800–1 700
   keys). Incremental-delta exposure from the memory server is a named
   follow-on if the union grows to tens of thousands (flag 6) — not built.

## 3. Pins and their killing mutations (red-first)

Suite: `executor-dprime-w0.test.ts`, run with
`SCHEDULER_LIVENESS_EQUIVALENCE=1` (T10′). Two mutations were applied and
observed RED, then reverted:

| pin | asserts | killing mutation (observed RED) |
|---|---|---|
| T1′/T4′/T7′ value re-derives; per-user isolation; absent-output lands | demanded computeds land, W advances, T4′ no run under the other user's key | **M1** — drop the `isDemandedWriter` disjunct in `isDemandRoot` + `recomputeLiveRefs` → 5/6 pin steps TIME OUT (no demanded value lands: "label to land", "each user's echo", "alice's instance", "leaf:5 to land") |
| T5′ / P-demand-set | one space key with N pairs; a user doc under 2 principals = 2 keys; registry keys = ⋃ trackedIds | (covered by M1's land-timeout; the union-equality also bites a roots-only exposure) |
| T2′ (cross-piece) | a link to ANOTHER piece's doc enters a narrowly-watching demander's closure, pre-empted=FALSE, pushGrowthWakes +1, zero walk | **M2** — remove the two push-growth notify sites → FAILS `Expected 0 to be greater than 0` (pushGrowthWakes flat) |
| T3′ (array growth) | an appended link-bearing element's target enters the closure, pushGrowthWakes +1 | M2 (strengthened T3′ to assert pushGrowthWakes so it bites) |
| T9′ (OFF/structural) | `demandedWriterCount` 0 on a plain client runtime; no `demand-walk:*` action ever; OFF scheduler suites' pass/fail set identical to base | (structural; the walk deletion is the mutation) |
| P-coarse | a departed session's rows leave; roots release only when no key names the writer; a doc tracked by 2 sessions stays | (the coarse-leave release; M1 also bites) |
| P-arrival | a 2nd principal arriving gets her instance (notCurrentRearms/demandArrivals +1); the 1st untouched | break `rearmNotCurrentForDemander` (return 0) → Bob's instance never materializes |
| T10′ | `SCHEDULER_LIVENESS_EQUIVALENCE=1` green across enter/leave/registration | an unbracketed flip → the hook's incremental-vs-rebuild mismatch throws |

T2′ (probe, kept from W0): within one piece the closure follows the
`source` wiring, so a piece's own computeds are PRE-EMPTED (recorded);
the value lands, zero walk. T2′-cross demonstrates the NON-pre-empted
cross-piece one-push-late growth W0 §5 left unbuilt: the demander watches
only a narrow field and NEVER the firing stream (a separate actor fires),
so the handler wiring cannot pre-empt the cross-piece target. Observed:
pre-empted=false, pushGrowthWakes +1. The cycle count is the settle
series' structural-growth waves (the synthetic single event did not land
a structural-growth settle entry — attribution is by adjacency to a
covered authored input; the workload settle series carries the ms/wave
cost: W0 chat landing 3.3–3.4 waves, 220–253 ms p50).

## 4. Suite counts

All FOREGROUND, one Bash call each, `--no-lock`. All GREEN.

| suite | result |
|---|---|
| runner (full, `deno task test`) | **1212 passed (6725 steps), 0 failed** (8m17s) |
| memory | 521 passed (229 steps), 0 failed (15s) |
| toolshed | 142 passed (428 steps), 0 failed (26s) |
| runtime-client | 61 passed (212 steps), 0 failed (2s) |
| piece | 37 passed (451 steps), 0 failed (1m21s) |
| spec-model | 23 passed, 0 failed (0.8s) |
| `deno task check-docs` | 548 code blocks pass |
| fmt `--check` / lint (touched files) | clean |
| `SCHEDULER_LIVENESS_EQUIVALENCE=1` (executor-dprime-w0 + executor-fan-out + executor-space-server) | 3 passed (31 steps + 6 steps), 0 failed — T10′ |

The (d′) suite (`executor-dprime-w0`) was added to `clock-preload.ts`'s
`realClockFiles`: it is wall-clock-paced (the 300 ms demand grace, the
flush deadline, the session TTL) like `executor-fan-out` /
`executor-space-server`. Without it the file crashed under the package's
auto-advance fake clock (a dangling timer → SES `__proto__` fatal) —
invisible when run alone with `deno test -A`. This was caught by running
the actual package task, not just the file.

## 5. Smoke — chat n=20 two-browsers ON (PROVISIONAL; W4 is the acceptance run)

Built binary from the W1 tip (`EXPERIMENTAL_SERVER_EXECUTION=true` at
build time, sha256 `857e63e0089b6727`); the W0 `run-arm.sh` driver
(`BIN_OVERRIDE`/`REPO_OVERRIDE`), fresh cwd = fresh store, port 8971.

- **Posture verified:** `/api/meta.shellServerExecutionDefine` = `"true"`;
  `/api/health/stats.servingLoop` present; `default_model=No default
  model available` (0 `CFTS_AI_LLM_*_API_KEY`, no `.env`).
- **Load:** before `4.71 / 4.30 / 3.89`, after `4.85 / 4.62 / 4.07`.
- **Series COMPLETE, 1 passed / 0 failed, wall 98 s.**
- **Chat median = 1239 ms** (q1 1008, q3 1623, min 847, max 2146) — in
  W0's band (1.19–1.27 s median). Per-post ms: `972 920 1239 1361 1008
  847 885 995 1328 1105 1136 1136 1197 1372 1538 1739 1623 2146 1894
  1757`.
- **Server settle:** value-only **17 ms p50** / 324 p95 / 764 max (n=45);
  structural-growth **263 ms p50** / 1739 p95 (n=19); event-append inputs
  11 ms p50 / 346 p95. Matches W0 (value-only 15–18 ms, growth 220–253 ms).
- **The (d′) demand block (live):** `demandedRows 1922, demandedInstances
  823 (max 823), demandedPairs 1922, demandedWriters 223 (max 223),
  demandRootEnters 223 (ACCUMULATED — obligation (iii) confirmed live),
  demandRootLeaves 0, notCurrentRearms 91, demandPasses 417, demandPassMs
  2030 (≈4.9 ms/pass — O(rows), no per-row read), pushGrowthWakes 175,
  watchWakes 677`; NO `walkRuns`. `waves 121, wavesBudgetExhausted 46`
  (the walk's exhausted waves gone — trio tip was 739–777);
  `undemandedNarrowingRuns 0, earlyEmitRefusals 0` (the two omitted
  counters now present); `events 28/28`, `lease.lost 0`.
- One pre-existing `piece-start-commit-failed` log (the stage-P2-F F1
  client-instantiate-vs-server-derive race, register residual (x),
  softened by the 300 ms grace) — not a (d′) regression; W0 saw the same
  class; the series still completed and the median is in band.
- Note: the driver's post-read prints `sizes_union: null` /
  `sizes_perSession: []` because W1 removed those W0 diagnostic fields
  from the block (obligation (i)); `demandedInstances`/`Max` carry the
  size story.

## 6. What was NOT done and why

- **The flag-4 structure load for demanded non-root pattern-meta docs**
  — not built (parity with the walk; the count is small: chat 2 / note 19
  / lunch 0; the pattern-meta test needs a per-row engine read the pass
  must not do). Register future row.
- **The flag-5 output-doc-demanders union** — not built
  (`undemandedNarrowingRuns` note 47–55, pre-existing). Register future
  row.
- **The no-grace push-growth wake / pre-seal closure refresh** — not
  built (W0 sub-second at p50; the `source` pre-emption makes most
  structure demanded before it exists). Register future row.
- **Fine-grained demand release** (R-D's future item) — the seat is the
  memory server's tracker, not the loop. Register future row.
- **The l3 duplicate-join / vote-toggle family** — (α)/(e) territory
  (W3/W2), not a (d′) hole; register row → W3.
- **The incremental-delta demand exposure** — the O(closure)-per-pass
  exposure is the accepted W1 cost; incremental is a named follow-on.
- **The fallback §2F (structural walk)** — not taken (W0 PROCEED (d′)).
