---
status: historical
created: 2026-08-18
archived: 2026-08-19
reason: "Stage-C evidence: W0 — the (d′) refutation experiment (demand = the tracked-ids closure, the demand walk deleted on a scratch branch); the three §2.8 questions answered with numbers before W1."
---

# Stage C — W0: the (d′) refutation experiment (server-execution v2)

Date: 2026-08-18/19 (runs 05:59–06:38 UTC on 08-19 = 22:59–23:38 PDT
08-18). Base: the stage-C design branch tip `ed9e1cb2c`
(`claude/server-exec-v2-stage-c-design`, PR #6009's line, off the tuning
trio's `b54bf5215`). Scratch branch `claude/server-exec-v2-w0-dprime-scratch`
(worktree `/Users/berni/labs-worktrees/w0-dprime`), NO PR, never merged:
the code on it is the design's §2.8 "cheap experiment", scratch quality;
the ANSWERS in this report are the deliverable. Durable copy of this
report: `/Users/berni/labs-worktrees/w0-dprime-report.md`. Raw settle
series, demand blocks, and the run ledger:
[`w0-dprime-raw/`](w0-dprime-raw/) beside this file (per-run
`<run>.settle-series.json` — recompute p50/p95 from `series[].ms` /
`.msGrowth`; `<run>.demand-block.json` — the `demand` counter block with
the size series decimated ×10; `run-ledger.txt`). Full artifacts (driver
logs, test logs, toolshed logs, `/api/health/stats` pre/post, per-run
sqlite stores, 10-s load samples) live under the session scratchpad
`…/0e87bf81-…/scratchpad/w0bench/runs/<run>-<workload>-<arm>/`; the
driver (`run-arm.sh`, the re-benchmark's byte-for-byte plus a post-read
of the new `demand`/`settle` blocks), `wait-load.sh`, and the two
binaries sit beside them. Design references: `stage-c-design.md` §2
(the (d′) design, §2.8 the W0 spec), serving-loop.md §1 (RULED (d′)
paragraph), §3b (B7), §8 (the liveness bracket).

## 0. Verdict for W1 (one line)

**PROCEED (d′)** — no dark value found (every value the walk kept live
still lands; the closure OVER-demands, never under-demands), the
structural-growth path stays sub-second at p50 (chat 220–253 ms to the
landing, mostly the 300 ms grace; ≤ 1.24 s at p95 on chat), and chat's
server settle is 15–18 ms p50 value-only — **with three W1 obligations
that are NOT optional** (§4): (i) the demand pass must run OFF the wave's
settle race or be delta-cheap (my per-pass instrumentation alone moved
note createToView from 4.1 s to 5.1–6.1 s p50 — flag 6's index is
load-bearing and so is everything else the pass does per row); (ii) the
lunch gate is bimodal on this tip (1/3 green) for the DUPLICATE-CONSEQUENCE
family — (α)'s double dispatch toggling a vote off, and a duplicate join
rendered — the W3/W2 territory, made more visible by faster waves, not a
(d′) demand hole; (iii) the closure follows a piece root's `source`
wiring, so a schema-narrowed root watch still demands the piece's whole
internal graph (the demand set ≈ the roots, as §2.6 predicted; the
one-push-late path is rare because it is pre-empted) — an owner-visible
cost property, stated, not a refutation.

## 1. What was built

Scratch commits on `claude/server-exec-v2-w0-dprime-scratch` (base
`ed9e1cb2c`): `9f70f3900` (the build), `49e113d12` (fmt), `5ebe838c6`
(the pins + seams), `2d6efb18d` (the flag-4 scan gated behind
`W0_FLAG4_SCAN=1` for the ablation), then this report's docs-only commit.
Every deno invocation `--no-lock`.

**Memory server** (`packages/memory/v2/server.ts`):
- `demandedInstancesForSpace(space, { excludePrincipal })` — rows
  `(id, scope, scopeKey, identity, root)` = ⋃ over the space's client
  sessions of `session.trackedIds` (the service principal's sessions
  excluded), one row per (instance key, session); `root: true` on the
  rows that are the session's watch ROOTS (root keys are UNIONED in from
  the watch specs so a root the tracker has not keyed still carries what
  `watchedRootsForSpace` carried). Anonymous sessions contribute keys and
  an identity without principal (not a demander, as today).
- The push-growth `demandChanged` notify (design §2.8 flag 2): the
  incremental push branch's `commitEntities` notifies with reason
  `push-growth` when `session.trackedIds` GREW; the full-evaluation
  branch's `commitWatchState` notifies when the replaced set differs. The
  observer signature gained an optional `reason: "watch" | "push-growth"`.
- `demandSetSizesForSpace(space)` — per-session `trackedIds.size` /
  watch count + the union size (the §2.6 measurement).
- `watchedRootsForSpace` is kept (unused by the SpaceServer now).

**Scheduler** (`packages/runner/src/scheduler/`):
- `node-record.ts`: `NodeRegistry.demandedWriters: Set<Action>` +
  `isDemandedWriter()` — the standing root kind, held on the registry so
  every liveness state bundle sees it with no plumbing (SIMPLEST-OPTION
  CHOICE, FLAGGED: W1 may prefer a field on the liveness state).
- `dependency-graph.ts`: `isDemandRoot` gains the disjunct;
  `recomputeLiveRefs` (the equivalence reference) gains it too.
- `scheduling-writes.ts`: `SchedulerWriteIndex.onWriterEntitiesChanged`
  hook (added/removed entities per writer; fired from `updateWriterIndex`
  and `clearAction`) — the REGISTRATION / UNREGISTRATION bracket's seat.
- `facade.ts`: `enterDemandedEntity(address)` / `leaveDemandedEntity`
  (refcount per scope-NAME entity, `entityNameKey` — the writer index's
  vocabulary; 0→1 / 1→0 bracket every current writer:
  `wasLive → flip → notifyNodeLivenessChange`, and a dirty node that
  became live is queued as pending), `rearmNotCurrentForDemander(address,
  pair)` (the currency check: `keyAtRatchet(fanOut, pair)` not in
  `fanOut.clean` ⇒ `markActionInvalid(writer, undefined, {fanOutInstances:
  "keep"})` + pending — the `rearmNotCurrentFanOutForActor` shape; a
  writer with no fan-out record is left to liveness), `writersOfEntity`,
  `demandedWriterCount`, `demandedEntityCount`, `demandRootCounters`.
  The registration hook installs lazily on the first `enter` (never off
  the serving posture).

**SpaceServer** (`packages/runner/src/executor/space-server.ts`):
- `#loadDemandedStructure` is now the DEMAND PASS over
  `demandedInstancesForSpace`: `#demandersByKey` keyed by the instance
  key (`${scopeKey}\0${id}`, byte-identical to the old `keyOf`) over
  EVERY row; departed keys → `leaveDemandedEntity` (+ load-state
  cleanup); new keys → `enterDemandedEntity`; new (key, pair) rows →
  `rearmNotCurrentForDemander`; the root-level arrival re-arm
  (`invalidateActionsForDemandRoots`) KEPT for root keys; the structure
  load per ROOT row byte-for-byte as before minus the walk install.
- DELETED: `#installDemandWalk`, `#demandSinks`, the `demand-walk:*`
  effect nodes, their teardown; `grep demand-walk src/` finds comments
  only.
- Flag 6 done in scratch form: `#keysByRootId` / `#keysByResolvedRoot`
  indexes so `#demandersFor` is a lookup, not a full key scan (needed so
  the closure's key count does not confound the settle numbers).
- `noteDemandChanged(reason)` counts `pushGrowthWakes` / `watchWakes`.
- Instrumentation: the `demand` counter block (§6 W4's (d′) version,
  scratch) and the `settle` series in the stats (`/api/health/stats
  .servingLoop.demand` / `.settle`): per authored input, admission
  (`enqueueCommit`) → coverage (the wave whose `derivedThrough` ≥ seq;
  `ms`, `waves`, `cycles`, `growthWakes`, `class`), and, when a
  push-growth wake fires after coverage, the next derived commit as the
  structural-growth landing (`msGrowth`, `growthWaves`, `graceMs`) —
  attribution by ADJACENCY (the most recently covered input), stated as
  such. Flag 4 count (`noWriterRowsWithPatternMeta`) recomputed at pass
  end over the current registry — an engine read per candidate row per
  pass, which is why it is now opt-in (`W0_FLAG4_SCAN=1`; §2(c)'s
  ablation).

**Tests** (`packages/runner/test/`): `executor-dprime-w0.test.ts` (the
(d′) pins); `executor-fan-out.test.ts` (f-walk)'s walk-node half retired
into a T9′ witness; `executor-space-server.test.ts`'s demand seams now
feed `demandedInstancesForSpace` rows (root rows + a superset closure of
every `computed:` doc — the seams have no client to grow the closure).

**Simplest-option choices, each FLAGGED for W1** (flag-don't-fill):
1. `demandedWriters` lives on `NodeRegistry` (zero plumbing) rather than
   on `SchedulerLivenessState`.
2. Refcount per scope-NAME entity (the writer index's vocabulary), not
   per instance key: two instances of one doc are ONE entity whose one
   node writes both; the per-instance distinction is the currency check.
3. A writer with NO fan-out record is left to liveness alone (design
   §2.2 step 3's "the check adds nothing"); an undemanded-narrowed
   fallback run (`undemandedNarrowingRuns`) with a later demander is NOT
   re-armed by the per-key check (pre-existing residual, see flag 5).
4. Departed keys are detected only when a pass runs (input cycle, watch
   wake, push-growth wake) — no notify on session close (R-D coarse).
5. The push-growth notify fires per push pass per session (coalesced by
   the existing 300 ms grace); no de-duplication across sessions.
6. The settle-series growth attribution is by adjacency.
7. The structure load stays root-scoped (flag 4) — no extension.
8. `noteDemandChanged`'s grace kept at 300 ms for BOTH wake reasons (the
   design's "no-grace wake for push-growth deltas" fix shape was NOT
   built — §2(c) says why the number did not force it).

## 2. Answers

### 2(a) Do the demanded derivations still land? — YES

**Pins (`executor-dprime-w0.test.ts` + the retargeted fan-out/space-server
suites), all run with `SCHEDULER_LIVENESS_EQUIVALENCE=1` — no liveness
drift anywhere (T10′ green across enter/leave/registration):**

| pin | result | the number |
|---|---|---|
| T1′ value-only change → the demanded per-user computed re-derives, W advances, ZERO walk runs | ✓ | walk runs 0 (structural: no `demand-walk:*` action exists in the graph or the trace); settle entries for the pin's inputs 7–52 ms, all `value-only`, 1–2 waves each |
| T4′ per-user change re-runs only that demander's instances | ✓ | 0 runs under Bob's instance key for Alice's draft (trace since the write filtered by `instanceKey`) |
| T5′ / P-demand-set: one key per space doc with N pairs; a user-scoped doc under two principals is two keys; registry keys = ⋃ trackedIds | ✓ | 19 keys / 24 rows / 2 root pairs / 2 user-instance keys; `demandSetSizesForSpace.unionKeys` = registry keys = 19 |
| T7′ a computed's ABSENT output doc is demanded before it exists → its writer is a root from the first pass → it lands | ✓ | 4 `computed:` rows in the demand set (2 `root:true` client pulls, 2 `root:false` tracker closure), `demandedWriters` 2 (echo, label), `label:1` lands |
| T2′ probe (a served handler writes `slot := hidden`, a computed it never reads; a NON-creator, schema-narrowed `{slot:string, additionalProperties:false}` demander) | ✓ lands, 41–45 ms, 1 wave | **the target was ALREADY demanded before the link** (`guarded present=true`; its row was a `closure` row): the tracker follows the result doc's `source`/process wiring into the handler's bindings — see 2(b) "the closure over-approximates". The isolated one-push-late measurement is NOT achieved in a unit pin; the workloads carry it (2(c)) |
| P-coarse: a departed session's rows leave, roots release only when no key names the writer; a doc tracked by two sessions stays | ✓ | keys 19 → 16 after Bob's session pruned (TTL 500 ms), the result root (space, tracked by Alice) stays, `demandedInstances` = 16; `demandedWriters` 2 → 2 (both writers still named by Alice's keys — no early release), leaves 0 |
| P-arrival: a second principal arriving after narrowing gets her instance; the first's untouched | ✓ | `notCurrentRearms` +1, `demandArrivals` +1, 0 runs under Alice's key |
| T9′ OFF arm | ✓ | `demandedWriterCount` 0 on a plain client runtime; the OFF-arm scheduler suites (15 files) pass/fail set IDENTICAL to the base tree (15 passed / 173 steps; 4 failed / 6 steps — the same 6 pre-existing failing steps on `ed9e1cb2c` in a clean worktree, with and without the equivalence hook) |
| fan-out (a)–(k) (10 steps) | ✓ | (f)'s walk-node half retired: Alice's guarded per-user value still materializes under her instance with zero walk runs — the branch's own run reaches it (§2.3 (ii)) |
| space-server seams (14 steps), serving-loop (24), run-supply / cooperative-yield / instance-keyed-replica / watermark / cross-space / events-down / wave / outbox (114 steps) | ✓ | one flake: effect-channel's "receipt-race divert pin" red ONCE in 4 runs (20-s wait for the served intent, in a 9-file batch under the hook), 3/4 green — the test names its own ~1-in-3 live race; not chased |

**Workloads ON at the scratch tip (built binaries; per-run details §3):**

| workload | ON at the scratch tip | ON at the trio tip (`b54bf5215`, re-benchmark) | OFF here (brackets) |
|---|---|---|---|
| chat two-browsers, n=20 @2 s | **2/2 series COMPLETE**; median **1 272 / 1 188 ms**, p95 2 048 / 2 121, min 661 / 729; walls 84 / 86 s | 2/2; median 9 734 / 7 397, p95 14 020 / 13 805; walls 272 / 251 s | 230 / 475 ms median (n1a/c1b); walls 63 / 65 s |
| chat cross-user gate steps (ms) | message 3 / 3, lockdown 33 / 43, post-lockdown 2 / 2, room 3 / 3, name propagation 6 / 5 | message 3 018 / 2 632, lockdown 3 262 / 4 094, post-lockdown 2 521 / 2 892, room 10 160 / 9 463 | 3–33 |
| lunch two-user vote | **1/3 GREEN** (l2: 11 s wall, merge 223 ms, swatches 1 ms, option B 125 ms); l1 RED at "both voters' swatches" (60 s), l3 RED at "both join lands" (300 s) — §2(b) names both | 2/2 GREEN, 42–56 s walls, merge 3 688 / 6 322 ms | 2/2, 4.8 / 4.2 s totals |
| note-create n=20 (createToView p50) | 3/3 series COMPLETE (the step fails the pre-existing `splitDefinitions` console gate in all three, exactly the re-benchmark n2's class); createToView **6 143 / 5 112 ms** with the per-pass flag-4 scan ON, **4 093 ms** with it ablated (n3) | 4 154 / 3 879 (n=2) | 1 104 / 1 201 |

Counters ON: `lease.lost` 0 in 8/8 ON runs; `events.processed == appended`
on chat (28/28 ×2) and note (94/94 n3; 95/94 n1, n2 — one re-dispatch
each); `undemandedNarrowingRuns` 0 on chat and lunch, 47–55 on note
(the trio tip: 47–48 — pre-existing, flag 5's shape); `earlyEmitRefusals`
0; `wavesBudgetExhausted` chat 30–35 / 119 waves (trio tip 739–777 /
131–137 — the walk's exhausted waves are gone), note 95–128 / 294–298
(trio 349–362 / 331–346). The §4 ratio (derived / (authored − effectAcks)):
chat 119/64 = **1.86** (trio 2.05–2.14; ≤ 2 met), note 294/107 = 2.75
(trio 3.07–3.20; ≤ 3 met), lunch 44/27 = 1.63.

### 2(b) Does anything the walk kept live go DARK? — NO dark value found; two lunch reds NAMED, neither a stale value

The refutation to hunt: a value the client RENDERS that stays stale with
the walk gone. Hunted in the pins (per-user branch, absent target, the
departed-creator/non-creator T2′ probe) and in the three workloads
(every cross-user step of chat, every lunch step, the note list/view). No
rendered value stayed stale. The two lunch reds, from the l1/l3 stores
and logs:

- **l1, "both voters' swatches visible on both browsers" (60 s):** the
  server's final `ranked` tally doc holds ONE voter (Bob); Alice's vote
  entity was REMOVED by a `remove-by-value` on `/value/votes` at seq 64;
  `events appended 9 / processed 10` — one castVote dispatched TWICE, and
  `castVote` TOGGLES the vote off on a same-color repeat
  (`sameColorToday → votes.removeByValue`, lunch-poll/main.tsx:636+). The
  browsers reached "2 love it" (speculative + served) and then the served
  tally dropped to one voter, so the swatch predicate (both names on both
  browsers) could never hold. This is the (α) double-dispatch class the
  closeout names (W3 — RULED, owed to this stage: the LT1 in-process
  cascade copy / the re-drain), "reported, not relied on" at the trio tip
  (appended 11 / processed 17 there, without breaking the merge in 2/2).
  Under (d′) the waves are ~10× shorter and the class toggled a vote off
  in 1 of 3 runs. NOT a demand hole: the votes were demanded and derived
  — twice.
- **l3, "both join lands (count reaches 2)" (300 s):** the host's body
  read "**3 joined**" with "Alice, Alice, Bob" — a DUPLICATE join entry
  for Alice, so the "2 joined" text never appears; server `appended 6 /
  processed 6` (no server re-dispatch counted); the client log shows
  `ConflictError: stale confirmed read` on the deferred start transaction
  and a `piece-start-commit-failed`. A duplicate CONSEQUENCE rendered
  (speculative echo + served copy, or a same-drain LT1 copy the counter
  does not track — the design's (α)/(e) late-echo family; the client's
  retire-on-arrival is the trio's T2). Not a stale value: it is a value
  landed twice. Not root-caused here (budget); the store and logs are
  under `runs/l3-lunch-on/`.

**Checked off, per §2.8 (b):** absent targets — tracked and served (T7′;
the piece's computed docs are in the demand set before they exist, 2 of 4
via the tracker's closure). Per-user branches — the branch's own run
reaches them (fan-out (f) with zero walk runs; the guarded value lands
under Alice's instance). The known parity gap that is NOT a hole (flag
4): rows with pattern meta and no registered writer — **19** at the end
of the note series (834 keys live), **2** on chat (829 keys), **0** on
lunch; the walk never started those pieces either.

**A finding the hunt produced (over-demand, never under-demand):** the
tracker's closure follows a piece root's `source`/process wiring, so a
schema-narrowed root watch (`{slot: string}`, `additionalProperties:
false`) still tracks the piece's internal docs — the handler bindings,
the ifElse INPUTS doc (both branches), every computed the piece
references — the T2′ probe's target was a `closure` row BEFORE the link
existed in all three shapes tried (ifElse with `unknown`, handler binding
with `unknown`, handler binding under the narrow schema). Consequences:
(1) the demand set ≈ the roots plus the pieces' wiring (chat 829 keys vs
798 watches per session; note 1 721 max vs 1 119 watches); (2) the
one-push-late structural-growth path is mostly PRE-EMPTED for a piece's
own computeds — it fires for links to docs OUTSIDE a piece's wiring
(the workloads show 105–175 push-growth wakes per run, so it does fire);
(3) the "schema-narrowness win" (§2.6) is smaller than the walk-vs-schema
framing suggests, because the walk's schema-less follow was mostly of
this same wiring. Not a refutation — the client renders nothing it does
not get — but the owner should know the closure is the piece graph, not
the rendered subset.

### 2(c) Settle time — value-only ≈ 15–35 ms p50; structural-growth 220–510 ms p50 to the landing, ≤ 1.3 s p95 (chat/note); the bar holds

Server settle per authored input (admission on the server → W covering
it), server-side timestamps, ALL authored inputs of the run (client
writes + event appends; `eventAppend` split shown), from the
`servingLoop.settle` series (raw files in `w0-dprime-raw/`):

| run | n | value-only p50 / p95 / max (ms) | structural-growth n; TO LANDING p50 / p95 / max; (to coverage p50); grace p50 / p95 | event-append inputs p50 / p95 | waves per input (value-only) | landing waves (growth) |
|---|---|---|---|---|---|---|
| c1 chat ON | 64 | **18** / 221 / 369 (n=47) | 17; **253** / 1 236 / 1 236; (15); 68 / 923 | 14 / 285 (n=28) | 1.13 | 3.4 |
| c2 chat ON (scan off) | 64 | **15** / 217 / 345 (n=46) | 18; **220** / 1 216 / 1 216; (11); 60 / 940 | 11 / 268 (n=28) | 1.15 | 3.3 |
| l1 lunch ON (red) | 24 | 23 / 696 / 795 (n=21) | 3; 1 091 / 2 226 / 2 226; (33); 375 / 1 768 | 97 / 795 (n=9) | 1.57 | 4.7 |
| l2 lunch ON (green) | 27 | **17** / 141 / 461 (n=24) | 3; **577** / 1 697 / 1 697; (19); 239 / 1 315 | 63 / 461 (n=11) | 1.21 | 5.0 |
| l3 lunch ON (red) | 21 | 16 / 98 / 98 (n=19) | 2; 2 105 / 2 105 / 2 105; (61); 1 674 | 37 / 98 (n=6) | 1.05 | 6.0 |
| n1 note ON | 128 | 35 / 712 / 1 604 (n=101) | 27; 508 / 1 255 / 1 703; (33); 172 / 667 | 33 / 631 (n=94) | 1.63 | 3.9 |
| n2 note ON | 129 | 32 / 652 / 1 547 (n=102) | 27; 404 / 1 141 / 2 317; (25); 151 / 774 | 28 / 393 (n=94) | 1.69 | 3.7 |
| n3 note ON (scan off) | 128 | **16** / 457 / 1 335 (n=107) | 21; **299** / 941 / 1 218; (11); 114 / 524 | 14 / 344 (n=94) | 1.53 | 3.7 |

Reading: (1) the VALUE-ONLY path (derivations + commit + push, no walk
term) is **15–18 ms p50 on chat, 16–35 ms on note, 17–23 on lunch** —
two orders below the trio tip's 2.6–3.6 s event-wave settles; p95 is
0.1–0.7 s (the deadline-cut waves; `wavesBudgetExhausted` 25–43 % of
waves). (2) The STRUCTURAL-GROWTH path (an input followed by a
push-growth wake, attributed by adjacency; landing = the next derived
commit): **220–253 ms p50 on chat, 299–508 ms on note, 577–2 105 ms on
lunch (n=2–3, the reds included), p95 0.9–1.3 s on chat/note** — its
coverage settle is the same 11–33 ms; the extra is the 300 ms grace
(grace p50 60–172 ms measured from the wake to the landing — the wake
often lands inside an already-running cycle) plus 3–5 more waves. Chat
grows 17–18 of 64 inputs (27 %), note 21–27 of 128 (16–21 %), lunch
2–3 of 21–27 (the join/vote structure). (3) The client-observed settle
beside it: chat send-click → other browser 1 188–1 272 ms median (OFF
230–475 client-local); the cross-user gate steps 2–43 ms (OFF 3–33);
lunch merge 213–223 ms (OFF 46–61); note createToView 4.09 s with the
pass cheap (OFF 1.10–1.20) — the client's own per-note cost climbs
0.9 → 16 s over the series exactly as at the trio tip (the (e)
intent-tracking term, unchanged by (d′)). The chat per-post series still
climbs 0.66 → 2.1 s (trio tip 4.4 → 14 s) — same slope shape, the
client's term.

**Does the structural-growth cycle break the sub-second bar?** No at
p50 on every workload; p95 1.2 s on chat/note. **The two named fix
shapes were NOT built** (a no-grace wake for push-growth deltas; a
pre-seal closure refresh): the number did not force a decision, and the
grace's measured share (60–172 ms p50 to the landing) is smaller than
the 300 ms nominal because growth wakes usually latch into a cycle
already in flight. The one measurement that would change this is the
"pre-empted" finding above — most structure is demanded before it
exists — so W1 should measure the no-grace wake ONLY if a real journey
shows the growth path on its critical path (chat/note do not).

**Note createToView across n=20 (slope):** OFF n1a `525 … 1217`
(1.10 s p50; the list-size step at note 8–10 present as before), ON n3
(scan off) `972 1445 2721 4093 4233 3711 5361 3942 2421 2774 3002 4041
5388 11517 5567 11653 9345 17114 6594 15950` — p50 4.09 s, notes 1–13
1–5 s, notes 14–20 5.6–17 s: the same O(history) client term the trio
tip showed (1.0 → 13 s), NOT flat — the (e) term (W2) is untouched by
(d′), as the attribution predicted. n1/n2 (scan on): 6.14 / 5.11 s p50 —
the ablation (`W0_FLAG4_SCAN`) shows the demand PASS's cost lands on
the client's critical path when it runs inside the settle race:
`demandPassMs` 17.6 s / 829 passes (21 ms each) vs 4.5 s / 842 (5.3 ms)
with the scan off, and createToView p50 −2 s. **W1 lesson:** the pass is
awaited by every wave (`await loadPass` precedes `runtime.idle()`), so
its per-row work is a wave-latency term; O(rows) map reconcile alone is
3.8–5.3 ms at 800–1 700 keys (chat 1 521 ms / 400 passes with the scan
off) — acceptable, but anything per-row-per-pass beyond that (an engine
read, a proxy) is not.

**Demand-set sizes and drift (flag 7):** chat 3 sessions × 639–650
tracked (662–798 watches each; the two Alice sessions + Bob), union
823–829 keys, 1 922–1 940 rows, 223 demanded writers, 85–88 not-current
re-arms, `pushGrowthWakes` 171–175 vs `watchWakes` 669–675 (~1:4);
note (one browser, 1–2 sessions) union 1 721 max, tracked 834 at the
end of the series (1 119 watches), 608 writers max, monotone within a
session (the size series climbs 0 → 1 721 across the 20 notes and drops
to 3 when the sessions leave: the coarse boundary in one number),
`pushGrowthWakes` 105–125 vs `watchWakes` 856–879; lunch 555 keys max,
147 writers max. Per-session tracked < watches everywhere: the closure
is the roots plus the wiring, not a multiple of the roots. `demandPasses`
per run: chat 394–400, note 829–842, lunch 137–150; the passes are
input-driven cycles + wakes.

**Flag-4 rows** (demanded, pattern meta, no writer): chat 2, note 19,
lunch 0. **`undemandedNarrowingRuns`** (flag 5): chat 0, lunch 0, note
47–55 (trio tip 47–48).

**Verdicts (README §1 vocabulary):** chat cross-user journey — **FASTER**
than the walk tip (6–8× at the series median, 30–3 000× at the gate
steps), PARITY-class with OFF at the gate steps, server settle sub-second
at p50 and p95 on the value-only path and at p50 on the growth path;
lunch — **INCONCLUSIVE** on completion (1/3 green; the reds named,
duplicate-consequence family) and FASTER on the steps that ran (merge
213–223 ms vs 3.7–6.3 s); note — **PARITY** with the walk tip at p50
(4.09 vs 3.88–4.15) once the pass is cheap, SLOWER (attributed to the
scratch's per-pass engine reads inside the settle race) with it on; the
client (e) term unchanged. No latency above 1-min load 5 is quoted: the
box sat at 2.4–5.0 (one OFF lunch bracket started at 4.99 after a 5.27
sample; recorded in the ledger).

## 3. Workload runs ledger

Binaries: `deno task --no-lock build-binaries toolshed`, `COMMIT_SHA` set;
`toolshed-off` from `e91c7b3ff` (flag UNSET, `env -u
EXPERIMENTAL_SERVER_EXECUTION`; sha256 `37551168fc5ed9c0`),
`toolshed-on` from `e91c7b3ff` (`EXPERIMENTAL_SERVER_EXECUTION=true`;
`bd7cb6d11fd85f22`), `toolshed-on2` from `2d6efb18d` (the ONE code delta:
the flag-4 pass-end scan gated OFF; `73deadd9d5974c3c`); all 352 939 122
bytes. Posture read per run from `/api/meta.shellServerExecutionDefine`
(`"true"` ON / `null` OFF) and `/api/health/stats.servingLoop` present /
absent; `gitSha` per run in the ledger; NO configured LLM model — 0
`CFTS_AI_LLM_*_API_KEY` env vars, no `packages/toolshed/.env`, and every
run's toolshed log carries `No default model available` (14/14). Fresh
cwd = fresh store per run; `--background --log-file --port=P` with
`PORT/API_URL/MEMORY_URL` on P; ports 8960 (OFF₁) / 8961 (ON) / 8962
(OFF₂), stray-checked free before every run; the workloads from
`packages/patterns` with `LOG_LEVEL=warn HEADLESS=1 API_URL=… SPACE_NAME=
w0-<run>` under `gtimeout --kill-after=30 520 deno test -A --no-lock
--v8-flags=--max-old-space-size=4096 --trace-leaks <file>`; the load
gate (`wait-load.sh 5 3`) before each triplet and each extra ON rep never
had to wait; loads recorded before/after; every run FOREGROUND, one Bash
call each; toolshed logs read with `/usr/bin/grep -a`; no orphaned
headless shells in any run.

| run | workload | arm | binary | port | start (UTC) | load 1/5/15 before → after | wall | result |
|---|---|---|---|---|---|---|---|---|
| c1a | chat n=20 @2 s | OFF₁ | off | 8960 | 05:59:44 | 2.74/3.68/8.45 → 2.58/3.46/7.99 | 63 s | ✓ series, median 230 |
| c1 | chat | ON | on | 8961 | 06:01:09 | 3.03/3.52/7.93 → 3.07/3.40/7.44 | 84 s | ✓ **series COMPLETE**, median 1 272 |
| c1b | chat | OFF₂ | off | 8962 | 06:03:10 | 2.72/3.27/7.25 → 2.99/3.26/6.93 | 65 s | ✓ series, median 475 |
| l1a | lunch | OFF₁ | off | 8960 | 06:04:29 | 3.15/3.28/6.90 → 5.27/3.79/6.94 | 30 s | ✓ 4.8 s |
| l1 | lunch | ON | on | 8961 | 06:05:15 | 4.99/3.78/6.90 → 2.68/3.47/6.49 | 76 s | ✗ RED at "both voters' swatches" (60 s) — double dispatch toggled Alice's vote off (§2(b)) |
| l1b | lunch | OFF₂ | off | 8962 | 06:08:08 | 2.79/3.24/6.09 → 2.99/3.26/6.05 | 15 s | ✓ 4.2 s |
| l2 | lunch | ON (rep 2) | on | 8961 | 06:08:36 | 2.91/3.24/6.01 → 3.06/3.26/5.96 | 12 s | ✓ **GREEN** 3.4 s total |
| n1a | note n=20 | OFF₁ | off | 8960 | 06:11:38 | 2.38/2.80/5.28 → 3.47/2.99/5.10 | 91 s | ✓ 2/2, createToView 1 104 |
| n1 | note | ON | on | 8961 | 06:13:24 | 3.38/2.99/5.06 → 3.66/3.77/4.88 | 272 s | series n=20 ✓; step 1 red on the pre-existing `splitDefinitions` console gate (4×); createToView 6 143 |
| n1b | note | OFF₂ | off | 8962 | 06:19:08 | 3.64/3.75/4.79 → 3.26/3.65/4.65 | 82 s | ✓ 2/2, 1 201 |
| n2 | note | ON (rep 2) | on | 8961 | 06:20:45 | 2.85/3.53/4.59 → 3.59/3.53/4.33 | 230 s | series ✓, same console gate; 5 112 |
| n3 | note | ON (rep 3, scan off) | on2 | 8961 | 06:26:45 | 2.97/3.23/4.09 → 4.46/3.93/4.16 | 245 s | series ✓, same console gate; **4 093** |
| c2 | chat | ON (rep 2, scan off) | on2 | 8961 | 06:31:32 | 3.40/3.73/4.08 → 4.22/3.99/4.15 | 86 s | ✓ **series COMPLETE**, median 1 188 |
| l3 | lunch | ON (rep 3, scan off) | on2 | 8961 | 06:33:23 | 3.64/3.87/4.10 → 3.04/3.65/3.95 | 311 s | ✗ RED at "both join lands" (300 s) — "3 joined", Alice twice (§2(b)) |

The extra ON reps (l2, n2, n3, c2, l3) are unbracketed beyond the
triplets' OFF runs (protocol minimum met: one OFF→ON→OFF triplet per
workload); no OFF drift was seen across the session (chat OFF 230/475,
lunch 4.8/4.2 s, note 1 104/1 201 — the re-benchmark's 220–242 / 3.0–4.2
/ 1 133–1 185).

Raw series: chat c1 ON per-post `661 735 788 946 905 815 921 1154 1176
1210 1451 1887 2048 1272 1371 1518 1665 1507 1640 1721`; c2 ON `729 739
865 857 1044 1206 1240 1188 1063 1121 1155 1183 1217 1186 1514 1681 1596
1570 2121 2078`; c1a OFF `354 236 169 158 162 481 168 180 208 191 203 198
204 376 299 238 230 247 365 306`; c1b OFF `291 180 311 450 350 497 612 492
533 452 338 439 271 775 459 545 610 561 475 482`. Note createToView: n1
ON `896 1564 2434 2392 1775 3966 6143 7233 9764 9882 2915 4446 3761 8405
9355 8089 6567 7988 8073 10846`; n2 ON `1241 2316 2339 3151 2616 6274 3792
2927 6340 5112 6044 4239 6095 4111 5309 10315 7382 12402 9378 7465`; n3
ON (scan off) as in §2(c); n1a OFF `525 … 1217` (p50 1 104), n1b OFF `515
376 334 352 437 365 364 299 1278 1231 1204 1201 1266 1283 1117 1483 1212
1278 1303 1244`.

## 4. Flags for W1

The eight from §2.8, with what was measured, plus what the build hit:

1. **One-push-late structural growth (+ the grace).** Measured: chat
   220–253 ms p50 to the landing (coverage 11–15 ms; grace 60–68 ms p50
   to the landing, 923–940 p95), 1.2 s p95; note 299–508 ms p50; lunch
   0.6–2.1 s p50 on n=2–3. Sub-second at p50 everywhere. The fix shapes
   NOT built (§2(c)). Decision for W1: build the no-grace push-growth
   wake only if a journey puts the growth path on its critical path;
   the pre-empted-by-`source` finding says most structure is demanded
   before it exists.
2. **`demandChanged` on push growth is a NEW notify site.** Built (two
   sites: the incremental `commitEntities` growth and the full
   `commitWatchState` change), reason-tagged; fires 105–175× per
   workload run against 669–879 watch wakes. Coalesced by the existing
   grace; W1 decides whether it deserves its own coalescing.
3. **A NEW `isDemandRoot` disjunct**, standing and refcounted. Built on
   `NodeRegistry.demandedWriters` with the bracket on enter (0→1), leave
   (1→0), registration (`onWriterEntitiesChanged` added) and
   unregistration (`clearAction`); `SCHEDULER_LIVENESS_EQUIVALENCE=1`
   green across every executor suite and the (d′) pins — T10′. W1
   decides the seat (registry vs liveness state) and whether the
   refcount is per entity (built) or per instance key.
4. **The structure load stays root-scoped.** Rows with pattern meta and
   no writer: chat 2, note 19, lunch 0. The count exists; the option
   (an id-class-filtered `#attemptStructureLoad` per such row) is not
   built. Note: the count's per-pass engine reads are what made the note
   p50 regress — if W1 keeps the counter, compute it on deltas.
5. **Demander resolution for linked pieces' writers.**
   `undemandedNarrowingRuns` chat 0, lunch 0, note 47–55 (the trio tip
   47–48: pre-existing; the note flow's linked pieces). The
   output-doc-demanders union is not built; W1 reads this number against
   the note journey before deciding.
6. **`#demandersFor` full key scan.** Indexed in the scratch by root id
   and resolved root; the pass then costs 3.8–5.3 ms at 800–1 700 keys.
   W1 keeps an index (load-bearing at closure scale) — and moves the
   pass off the settle race or makes it delta-driven (§2(c)'s ablation).
7. **Monotone growth of `trackedIds`.** Measured: note union 0 → 1 721
   over 20 notes, one session; chat 645–650 tracked per session vs
   662–798 watches (the closure ≈ the roots + wiring); drops only when
   sessions leave. Coarse, RULED; the numbers are not tens of thousands.
8. **The demand set is the SERVER's view.** Not separately measured;
   consistent with 7 (the size never shrinks within a session).

New (from the build and the runs):

9. **The closure follows `source`/process wiring** (§2(b)): a
   schema-narrowed root watch demands the piece's whole internal graph
   (ifElse inputs = both branches; handler bindings). Over-demand, never
   under-demand. W1/owner: is that the intended demand set (it is
   memory v2's tracker's set, so it is what the client is delivered
   anyway), or should the demand pass filter by id class / value reach?
   Not decided here.
10. **The lunch gate is bimodal on this tip (1/3)** for the
    duplicate-consequence family: (α) double dispatch toggling a vote off
    (l1: appended 9 / processed 10, store shows the `remove-by-value`) and
    a duplicate join rendered (l3: "3 joined", Alice twice; server 6/6;
    client `ConflictError` on the deferred start). W3 (α) is on the
    critical path of the lunch gate now that waves are 10× shorter; l3's
    duplicate is not root-caused (client echo vs same-drain copy).
11. **The demand pass runs inside the settle race** (`await loadPass`
    before `runtime.idle()`): its per-pass cost is a wave-latency term
    (2 s of note createToView p50 from a 21 ms/pass diagnostic). W1: run
    the pass on deltas, or off the settle path, and never do per-row
    reads in it.
12. **`demandRootEnters/Leaves` in the stats are copied from the serving
    runtime's counters per pass** — after a park + reactivation they read
    from the fresh runtime (0/0 at the end of lunch runs). Scratch
    artifact; W1 accumulates them in the stats.
13. **The (f-walk) pin's second half and the space-server demand seams**
    had to change with the walk (walk-node assertions; `watchedRootsForSpace`
    stubs): W1's test plan should expect that surface (`executor-fan-out
    (f)`, `executor-space-server` seams, `executor-dprime-w0` as the
    (d′) pins' seed).
14. **The effect-channel "receipt-race divert" pin** was red 1/4 under
    the equivalence hook in a 9-file batch — a pre-existing ~1-in-3 race
    by its own comment; not attributed to (d′) (3/4 green, 15/15 twice
    alone).

## 5. What was NOT done and why

- **The two growth-path fix shapes** (no-grace push-growth wake;
  pre-seal closure refresh) — not built: the measured growth path is
  sub-second at p50 on every workload (§2(c)); named, not designed, per
  the brief.
- **An isolated one-push-late unit measurement (T2′/T3′ "in how many
  cycles")** — three shapes tried (ifElse under `unknown`, a
  handler-written link under `unknown`, the same under `{slot:string,
  additionalProperties:false}`); each found the target already demanded
  through the piece's `source` wiring, so the pin RECORDS that and the
  workloads carry the cycle count (landing 3.3–6 waves after admission
  where a growth wake fires; 1.05–1.69 waves per value-only input).
  A cross-piece link (a link to another piece's doc, which the wiring
  does not pre-empt) is the shape to build for a deterministic pin — not
  built (budget).
- **The l3 duplicate-join root cause** (client speculative echo vs a
  same-drain LT1 copy) — not chased; store + logs kept. Lunch ON was run
  3× (1 green); a fourth/fifth would size the rate but not the
  mechanism.
- **A trailing OFF bracket after the extra ON reps** (c2, l3, n2, n3) —
  the triplet minimum was met per workload; OFF showed no drift across
  the session.
- **The demand-set drift as a per-note curve in the report** — the size
  series is in `w0-dprime-raw/*.demand-block.json` (×10 decimated);
  the union climbs monotonically 0 → 1 721 across the note series
  (values every ~10 passes: 0, 299, 457, 615, 826, 990, 1 148, 1 322,
  1 464, 1 628, then 3 after the sessions leave).
- **A full runner-suite OFF run** — 15 scheduler files (173+ steps)
  compared against the base tree instead: identical pass/fail sets, the
  6 failing steps pre-existing on `ed9e1cb2c`.
- **Cubic/CI** — a scratch branch, no PR by design; every green above is
  a local run, said with counts.
- The report's history-index entry rides the directory entry for
  `plans/server-execution-v2/` (INDEX.md line 124), which covers this
  file; the line's prose is amended to name the W0 report.
