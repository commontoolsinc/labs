---
status: historical
created: 2026-08-19
reason: "Stage-C build W3 — (α): events.md §4's RULED one-durable-entry-one-completed-run sentence, implemented — the deadline-time purge of queued LT1 leftovers, the late-seal refusal of in-flight LT1 copies (the seat the design's list did not name and W0's l1 store shows), the orphan refusal for LT1 copies whose emitter write the wave withdrew, the per-event run-count pins with their killing mutations; the W0 l3 'duplicate join' root-caused as a CLIENT cascade-echo stranding and handed to W2; the lunch gate 3/3 green at the tip with the ON skip kept for the W2 residual."
---

# Stage C — W3: (α) one durable entry, one completed run (server-execution v2)

Date: 2026-08-19. Base: the W1 (d′) tip `19c6448ab`
(`claude/server-exec-v2-w1-dprime`). Branch `claude/server-exec-v2-w3-alpha`
— a STACKED PR off W1, #6043 (no CI; every green below is a local run,
said with counts). Worktree `/Users/berni/labs-worktrees/w3-alpha`; durable copy of
this report `/Users/berni/labs-worktrees/w3-alpha-build-report.md`. Every
deno invocation `--no-lock`. Commits: `a8f9ff61a` (the mechanisms),
`c3732e50b` (the pins), `9b843b4e3` (spec + register + skip list), plus
this report's docs commit.
*Fix-pass note (2026-08-19): the branch was REBASED onto W1's final tip
`963ff600e` (W1's own review fixes) by the review fix pass — the build
commits above now read `d0f382ef0` / `c5c3e1919` / `2385192e1` /
`fcdfc2653` / `6ba2cc812`; the code is byte-identical across the rebase
(one register conflict, both sides kept; the history INDEX's directory
line folded into one). The independent review (`w3-alpha-review-report.md`
beside this file) and the fix pass (`w3-alpha-fix-report.md`) are the
record of what changed after this report was written; corrections below
are marked "Fix-pass note".* Design references: `stage-c-design.md` §4 (the
work item), §6 W3, §7; events.md §4 (the RULED sentence; its LANDED note
is this build's); verification-coverage.md OW35 (CLOSED here) and the
"Stage C design build delta — W3 (α)" block.

## 0. Verdict

The RULED sentence is enforced at THREE seats of the serving loop — the
two it names plus the in-flight residue the purge cannot reach, which its
own wording ("does not complete within its appending wave") requires:
(α1) the purge, (α1b) the late-seal refusal, (α3) the orphan refusal;
(α2) is the trio's guard, verified and not rebuilt; (α4) is pinned
red-first with recorded killing mutations. The lunch gate is 3/3 GREEN at
the tip with `events appended 11 / processed 12` in every run (the 12th is
the purged leftover the drain delivers), every event in exactly one
derived commit, and 3 vote adds / 0 toggles in the store — where W0's l1
showed the toggle. The ON skip for the lunch gate STAYS (a DECISION, §4):
its remaining bimodality is a CLIENT cascade-echo stranding on the join
step — W2's, root-caused in §1 and handed off with the evidence.

*Fix-pass note (2026-08-19): the independent review (LANDABLE-WITH-FIXES;
1 BLOCKER / 2 MAJOR / 3 MINOR / 4 NIT) found the verdict's "enforced at
three seats" WEAKER than the sentence in one corner the pins did not
construct — an event contributing a same-eventId SIBLING tx (the served
navigateTo's intent, committed inline mid-run) beside its LT1 handler
run: with the sibling surviving the appending wave and the handler's tx
refused at its late seal, the batch marked the entry on the sibling's
survival and the drain never re-delivered — a LOST delivery (B1; a
regression against the W1 base); the orphan arm had the mirror gap (M1:
the intent half of an orphan landed). Both fixed and pinned in the fix
pass (`499c9dd7b`): only the LT1 copy's OWN run marks its seq-less
entry; the orphan refusal folds siblings, counted per event. OW35
CLOSED stands for the pinned shapes, the sibling shape now among them.*

## 1. The l3 root cause (W0's "duplicate join") — CLIENT cascade-echo stranding, NOT a server double run

Evidence read from the W0 l3 artifacts (`…/scratchpad/w0bench/runs/
l3-lunch-on/`: the space store `did:key:z6MkrtnN….sqlite`, `test.log`,
`driver.log`):

- **The store is clean.** 54 commits; 8 events in the lunch space (6
  client appends + 2 LT1 cascades); every eventId appears in exactly ONE
  derived commit's `consequence_of` (8/8 count 1). The `users` array
  received exactly two splices: commit 42 (`splice add [Alice →
  of:fid1:NYEME…] index 0`; `consequenceOf` = the host's click
  `evt:4c10d576…` + its LT1 child `evt:395542e7…:0:of:…lalq…`) and commit
  52 (`splice add [Bob → of:fid1:IV6lU…] index 1`). `events appended 6 /
  processed 6`, `drainInFlightSkips 0`. Server state = 2 joined.
- **The join is a CASCADE child.** `#lp-join-button`'s `onClick={() =>
  boundJoin.send({})}` lowers to a click handler (stream `of:fid1:FkFw…`);
  the served run of that click emits `joinAs`'s event (stream
  `of:fid1:lalq…`, payload `{}`) as an LT1 same-space emission, processed
  in the same wave (commit 42 lists both ids). On the CLIENT the
  speculative click echo sends the same `{}` to `boundJoin` → a
  client-minted cascade id (`mintEventId(link, originTx)` — a random
  per-tx key) that never equals the server's LT1 id (`mintEventId(link,
  this.tx)` — another random per-tx key).
- **The echo is stranded by construction.** `retireIntent(space, eventId)`
  (overlay-destination.ts) retires entries by EXACT eventId — the click's
  echo retires when commit 42 arrives, the cascade child's does not. The
  late-echo rule (T2 / OW36) does not apply: the child sealed ~8 ms after
  the click (speculative), long before the served consequence arrived. The
  watermark sweep's ARRIVAL gate then never passes: `joinAs` writes
  `users.set([...existing, user])`, and the new `user` object is cellified
  into a doc whose id derives from the handler frame's cause — `$event:
  tx.dispatchedEventId` (runner.ts) — so the client's entity id (from the
  client cascade id) ≠ the server's `NYEME…` (from the server's LT1 id);
  the spec entity doc never holds a confirmed value, `arrived` stays
  false forever, and the overlay layer (spec-Alice) stands.
- **Why the gate was bimodal.** The host page renders the overlay's
  spec-Alice + the store's Alice + Bob = "3 joined, Alice, Alice, Bob" (the
  l3 probe). In W0's l1/l2 the step "both join lands (count reaches 2)"
  passed in **7–10 ms** — i.e. the host page already showed "2 joined" =
  spec-Alice + confirmed-Alice BEFORE Bob's join landed (a server round
  trip is ≥ 16 ms p50): the step has been passing SPURIOUSLY on the
  stranded echo; in my three W3 runs it passed in 16 / 13 / 11 ms — the
  same shape. In l3 the first `viewSettled()` probe landed after Bob's
  confirmed join had arrived (1 → 3 without a sampled 2) → 300 s timeout.
- **Disposition: W2 / T2 territory — handed off with the evidence (the
  register's W3 block); not (α).** Candidate shapes for W2, NOT filled:
  (a) `retireIntent(P)` also retires entries whose `parentEventId` chain
  reaches P (the late-echo rule's jobless-cascade logic, applied on
  arrival — a visible flicker when the LT1 child lands a wave later);
  (b) deterministic cascade ids derived from the parent event id + send
  ordinal on both sides (then `retireIntent` matches AND the
  frame-caused entity ids match, so the arrival gate passes) — touches
  `mintEventId`'s per-attempt freshness (events.md §4) — owner-level.
  NOT a same-drain LT1 copy the counter does not track: the store shows
  one consequence commit per event.

## 2. The l1 mechanism — the in-flight late LT1 seal (the (α) class the design's purge alone would NOT have fixed)

From `…/runs/l1-lunch-on/` (store `did:key:z6Mkipzr….sqlite`):

- 13 events (9 client appends + 4 LT1 cascades); every eventId in exactly
  one derived commit's `consequence_of` — `consequenceOf` is per EVENT and
  DEDUPES, so it cannot show a same-wave double (a finding the (α4) pins
  are built around: the handler's non-idempotent effect is the run-count
  witness; one derived commit per event is the necessary half).
- Commit 64 (`consequenceOf [evt:bd00b09f…:0:of:…0Wg3…]` = Alice's
  `castVote`, the LT1 child of her click `evt:5b126ac8…`, whose entry
  landed UNMARKED in commit 63 with `seq: 63`) holds TWO castVote runs:
  (1) `add-unique /value/votes [BKR5…]` + `set BKR5… {voterName: Alice,
  green}` with NO mark op — the LT1 in-process copy (no `streamEntry`),
  which missed wave 63 and sealed into wave 64; (2) `replace
  /value/entries/1 {consequenced: true, seq: 63}` (the drain copy's mark)
  + `remove-by-value /value/votes BKR5…` — the drain copy, queued at cycle
  64's start, whose `sameColorToday` read the first run's vote in the
  serving overlay and TOGGLED it off. Net: Alice's vote gone; `processed
  10 / appended 9` is the drain of the server-emitted entry (one drain),
  not the double.
- Whether that copy was QUEUED or RUNNING at wave 63's deadline cannot be
  read from the store; both shapes are real (the dispatch stamp → handler
  → seal path has no macrotask boundary for a sync handler, so the queued
  shape dominates there; an ASYNC handler — patterns may be, e.g. the
  importers' `fetch` — is the in-flight shape). The build closes both:
  the ruled purge for the queued copy and the late-seal refusal for the
  running one; the pins construct each deterministically. #5969's Bob
  `1e731bc9` trace is the queued variant.

## 3. What was built (files)

- `packages/runner/src/scheduler/types.ts` — `ServedEventDispatch.lt1 =
  { emitterTx }` (the LT1 copy's appending-wave identity) and the
  `LT1_LATE_SEAL_REFUSED` sentinel.
- `packages/runner/src/cell.ts` — the serving-arm LT1 emission carries
  `lt1: { emitterTx: this.tx }` on the queued copy (servingPosture branch
  only).
- `packages/runner/src/scheduler/events.ts` — the dispatch stamp threads
  `lt1` into `ServerRunInfo`; `handleCommitResult` settles a copy refused
  with the sentinel QUIETLY (debug, no warn, no retry — the invariant
  working); `dropQueuedEvent` / `notifyEventDropped` take a `quiet`
  option (debug instead of warn for the routine purge).
- `packages/runner/src/scheduler/facade.ts` — `purgeQueuedEvents(
  predicate, reason)`: removes matching QUEUED events through the
  pre-dispatch drop chokepoint (lineage released, final-outcome guard,
  a head dispatch parked in presync bails), returns the count; `dropEvent`
  takes the quiet option.
- `packages/runner/src/runtime.ts` — `ServerRunInfo.lt1`.
- `packages/runner/src/executor/stats.ts` — `events.lt1LeftoversPurged`,
  `events.lt1LateSealsRefused`, `events.orphanDeliveriesRefused`.
- `packages/runner/src/executor/space-server.ts` — `#lt1AppendingWave`
  (WeakMap tx → the emitter's wave, resolved at `#stampRun` from
  `#waveByTx.get(info.lt1.emitterTx)`; `null` = unknown → refused
  fail-closed); `#stampRun` also stamps `lt1: true` on the wave run
  context; `seal()` refuses a copy whose appending wave ≠ `#currentWave`
  BEFORE `#openWave()` (nothing reaches the replica overlay; no empty
  wave opened for it; `noteSealFailure` not called); `#purgeLt1Leftovers`
  at both `exhausted = true` arms of `#waveCycle`; the outcome's
  `orphanDeliveriesRefused` folded into stats.
- `packages/runner/src/executor/wave.ts` — `WaveRunContext.lt1`; the
  per-wave `#lt1EmittersByEventId()` map (seq-less sidecar entries in
  the sealed home ops, the batch build's detection factored as
  `seqLessStreamEntryEventIds`); the ORPHAN arm in `resolveConflicts`'
  closure loop (an LT1 copy with no surviving emitter contribution, or
  whose emitter is requeued / dropped whole / dropped at the sidecar doc,
  → `droppedWhole` + `orphanRefused`; `outcome.orphanDeliveriesRefused`);
  `#settleVerdicts` takes the set for the message.
- `packages/runner/test/executor-events-down.test.ts` — `w3Setup` (bare
  stream + value docs from the client; host activation; the C8d
  quiescence poke) and the three pins (§5).
- `tasks/server-execution-on-skips.ts` / `.test.ts` — the lunch entry's
  reason rewritten to the actual residual; the test's matchers moved
  from the refuted `nowTick`/OW32 wording to OW35 / castVote / cascade
  echo / W2.
- Docs: events.md §4 LANDED note; serving-loop.md §7 `events` counters;
  verification-coverage.md (OW35 CLOSED, the W1 block's l3 bullet
  resolved, the W3 LANDED block with a coverage row per ruled sentence,
  the skip DECISION, the l3 hand-off, OW37 re-read, the chat smoke);
  stage-c-design.md §6 W3 / §7 (α) risk — LANDED notes.
- *Fix-pass additions (2026-08-19):* `wave.ts` — the seq-less-entry
  marking requires `context.lt1 === true` (F1) and the requeue closure's
  `eventOrphaned` sibling fold with per-EVENT `orphanDeliveriesRefused`
  (F2); `executor-events-down.test.ts` — two sibling pins, pin 1's
  held-gate extension (the purge's discriminator), pin 1's title
  corrected; `stats.ts` / `events.ts` / `space-server.ts` comment
  honesty (the shaper-held LT1 class, the skipped telemetry submit, the
  non-waking refusal); events.md §4 AMENDED note; serving-loop.md §7;
  verification-coverage.md (OW35 re-read, the W3 rows, OW37 direction);
  stage-c-design.md §6 W3 note; this report's notes.

## 4. Decisions (flag-don't-fill)

1. **A third seat — the late-seal refusal (α1b) — built.** The ruled
   sentence says an in-process run that "does not complete within its
   appending wave is dispatched by the drain alone"; events.md §4's
   enforcement paragraph enumerated only the purge (α) and the drain skip
   (β). A copy still RUNNING at the deadline is off the queue (the purge
   cannot reach it) and seals into the next wave unmarked — W0's l1 shape.
   Built as the seal-destination refusal keyed on the emitter's wave;
   recorded in events.md §4 as a DATED clarification of the enforcement
   paragraph (the RULED sentence itself untouched). Alternative named:
   let the late copy enter the next wave and rely on the orphan arm there
   (it works — see the defense-in-depth row in §5 — at the cost of the
   refused copy's writes reaching the serving overlay, where the drain's
   copy reads them and then REQUEUES once when the late copy withdraws).
   Owner-visible. *Fix-pass note: the review judged the DATED note a
   clarification within the ruled sentence's letter — and found the
   CODE weaker than that letter in the sibling corner (B1) until the
   fix; events.md §4 now carries the AMENDED note stating the sibling
   shape, the fix, and the late-seal split residual.*
2. **(α2) not rebuilt — verified by reading, pinned by the trio's guard
   pin.** The guard entry is set before `queueEvent`, which holds shaped
   events synchronously (so a shaper-held drain copy is `queued` to the
   guard), and the drain is the ONLY producer of `streamEntry`-bearing
   copies (cell.ts's LT1 copy carries none; the scheduler's requeue paths
   never carry `served` — served copies are queued `retries: false`). A
   dedicated shaper-HELD pin is a FOLLOW-ON (§9).
3. **The ruled purge discriminator, unrefined.** The purge removes EVERY
   queued `served !== undefined && served.streamEntry === undefined` copy
   at the deadline, including one whose emitter is still running and
   will seal into the NEXT wave (its entry then lands there and the drain
   delivers it one cycle later — never lost, never doubled). A refinement
   (purge only copies whose emitter already sealed, via the same
   `#waveByTx` lookup) would save that cycle; not built — the ruled
   discriminator is what events.md §4 states, and the case is rare
   (the close follows the deadline decision within the same microtask
   run when no notice work is pending).
4. **The lunch ON skip STAYS (its reason rewritten).** The lift rule's
   two conditions are met literally — the (α4) pins green, the gate 3/3
   green fresh-store at the tip — but §1 shows the gate's "both join
   lands (count reaches 2)" step passing on the stranded client echo
   (7–16 ms in every green run) and failing when the probe misses the
   transient (W0 l3). Lifting would knowingly re-expose the ON lane to a
   ~1-in-8 flake whose mechanism is W2's. Alternative named: lift now on
   the literal rule and accept the flake until W2 lands. Lift condition
   restated in the entry: W2's cascade-echo fix (or the step re-pointed
   at the CONFIRMED count) + 3/3 green. Owner-visible.
5. **Quiet settlement of the refused copy and the purged copy.** Both
   are the invariant working, not failures: the scheduler logs them at
   debug (a `quiet` option on the drop chokepoint; the sentinel check in
   `handleCommitResult`) and the SpaceServer counts them. A warn per cut
   cycle would have flooded the toolshed log under (d′)'s short waves.

## 5. Pins and their killing mutations (all in `executor-events-down.test.ts`; red-first — each mutation run against the pin, then restored)

| pin | construction | asserts | killing mutation (observed RED) |
|---|---|---|---|
| **"(α1)+(α1b)+(α4) the QUEUED leftover and the in-flight one, side by side"** (flushDeadlineMs 100) | a served parent handler emits TWO LT1 children; the child handler is ASYNC — `c1` parks on a test gate (in flight across the deadline), `c2` sits QUEUED behind it (one event per pass) | `lt1LeftoversPurged 1` (c2), `lt1LateSealsRefused 1` (c1), `childRuns == [c1, c1, c2]` (the refused copy + the drain's two), the child's non-idempotent effect applied exactly TWICE for two entries, one consequence commit per entry, no notice on either entry, `appended 1 / processed 3` | purge skipped → `lt1LeftoversPurged` 0 (and c2 refused at the seal instead: refusals 2); seal refusal + the orphan arm's absent-emitter clause skipped → effect applied THREE times (3 ≠ 2) — the lunch double |
| **"(α1b)+(α4) the IN-FLIGHT residue"** (flushDeadlineMs 150) | one async child parked across the deadline; the drain queues its `streamEntry` copy behind it; the gate opens | `lt1LateSealsRefused 1`, `lt1LeftoversPurged 0`, handler body ran twice, effect applied ONCE, one consequence commit | seal refusal skipped ALONE → refusals 0 but the effect still once (the orphan arm's absent-emitter clause withdraws the late copy in the next wave; the drain's copy requeues once — defense in depth, recorded); seal refusal + absent-emitter clause skipped → effect TWICE (2 ≠ 1) |
| **"(α3) the ORPHAN refusal"** (flushDeadlineMs 30 000; the settle gate) | a DERIVATION emitter (`scheduler.run` of a registered action that sends on a bare stream) + its LT1 child handler recording payload tags; the gate holds the wave once the child sealed; a CLIENT fires a rival on the same stream; release | the witness doc saw only `["rival"]`, `orphanDeliveriesRefused 1`, the sidecar holds only the rival's entry (consequenced), every consequenced id has a durable entry | the orphan arm removed → `["ping", "rival"]` — "ping" delivered with no entry behind it |
| *Fix-pass (2026-08-19)* **"(α1b)+(α4) + a same-eventId SIBLING tx"** (flushDeadlineMs 150) | the in-flight pin's child commits a separate event-handler-stamped tx carrying `tx.dispatchedEventId` (the served navigateTo intent shape) BEFORE the await that spans the deadline | the entry UNMARKED several deadlines later (the sibling's survival is not the handler's completion), the drain re-queues it (`processed` 2), after the gate: effect once, the sibling's write once, `childRuns` 2, refusal 1, purge 0, orphan 0, one consequence commit for the drain's run + one for the sibling (the SPLIT, recorded), no notice | the `lt1 === true` gate on the marking removed (the build tip's code) → RED at the marking (the entry consequenced before the gate); the reviewer's probe past that point: `processed` 1, `counterC` 0 — a LOST delivery |
| *Fix-pass (2026-08-19)* **"(α3) + a same-eventId SIBLING tx"** (flushDeadlineMs 30 000; the settle gate on the earliest visible seal) | the orphan pin's "ping" run also commits the sibling tx inline | `seen ["rival"]`, the sibling's doc still 0, `orphanDeliveriesRefused 1` (two contributions folded, one event), every consequenced id durable | the sibling fold (`eventOrphaned`) off → `side` 1 — the intent half landed (2/2 runs) |
| *Fix-pass (2026-08-19)* pin 1's held-gate extension | after the drain queued `c1'`/`c2'` behind the parked `c1`, the gate is held ≥ 450 ms (≥ 2 more 100-ms deadlines) | `wavesBudgetExhausted` > 1, `lt1LeftoversPurged` still 1, `processed` still 3, no `status` on either entry | the purge predicate widened to `served !== undefined` (the drain copies purged too) → `lt1LeftoversPurged` 3 ≠ 1, RED (the build tip's α pins were GREEN under this mutation — review m1) |

Why the pins use RAW handlers on the serving runtime: the production
chain from the emitting run's `send` (cell.ts's serving arm) through the
dispatch stamp, `#stampRun`, the wave's batch/fold, and the drain is
exercised end to end; only the handler BODIES are test code, which is
what makes an in-flight async copy constructible. A lesson from the
first attempt: a pin that relied on the deadline timer firing before the
scheduler's next 0-delay tick was not deterministic — Deno runs a ready
0-delay tick before an overdue delayed timer (measured in-situ: a
250-ms spinning parent's child tick ran 1 ms before the overdue 100-ms
deadline callback), which in production is the BENIGN same-wave outcome
(no leftover at all); the two-children shape above makes the deadline
find c2 queued by construction (the scheduler awaits c1's running
promise, so no tick is pending when the deadline fires).

## 6. Suites (every green a local run; stacked PR, no CI)

| suite | result |
|---|---|
| runner (full, `deno task test`) | **1212 passed (6728 steps), 0 failed** (8m13s) — W1's 6725 + the 3 pins |
| memory | 521 passed (229 steps), 0 failed (14s) |
| toolshed | 142 passed (428 steps), 0 failed (17s) |
| runtime-client | 61 passed (212 steps), 0 failed (2s) |
| piece | 37 passed (451 steps), 0 failed (1m2s) |
| spec-model | 23 passed, 0 failed (0.6s) |
| `tasks/server-execution-on-skips.test.ts` | 17 passed, 0 failed |
| `deno task check-docs` | 548 code blocks pass |
| fmt `--check` (11 touched TS files) | clean |
| lint (11 touched TS files) | 1 finding, PRE-EXISTING at the W1 tip (`wave.ts` `#foreignGrantFor`'s `require-await`, the fan-out F1 probe) — not touched |

OFF byte-identity: every touched branch is gated on the serving posture —
cell.ts's LT1 branch (`servingPosture === true`), the scheduler's
`served !== undefined` checks (the sentinel path, the `lt1` spread — a
spread of `{}` when `served` is absent), `purgeQueuedEvents` (called
only by the SpaceServer), the wave and the stats (serving-loop
constructs only). Verified: the runner suite runs OFF by default (no
`EXPERIMENTAL_SERVER_EXECUTION` in the env) and its pass/fail set is
W1's plus the three new steps.

## 7. Lunch gate runs ledger (the re-benchmark recipe; binary `toolshed-on` built from `c3732e50b` with `EXPERIMENTAL_SERVER_EXECUTION=true`, sha256 `cb7da13673e4dda4`; posture per run `/api/meta.shellServerExecutionDefine: "true"` + `servingLoop` present; `No default model available` per run, 0 `CFTS_AI_LLM_*` keys, no `.env`; fresh cwd = fresh store; `gtimeout --kill-after=30 520`; logs read with `/usr/bin/grep -a`; no orphaned browsers in any run; the load gate `wait-load.sh 5 N` was applied before each run — it was quiet for l1 and TIMED OUT before l2 / l3 / c1 (a concurrent benchmark on the box), so loads are recorded, not excused)

| run | port | start (UTC) | load 1/5/15 before → after | wall | result | events (appended / processed; purged / refused / orphan) | waves / exhausted |
|---|---|---|---|---|---|---|---|
| l1 lunch ON | 8961 | 19:10:51 | 4.46/5.99/6.34 → 8.77/6.99/6.69 | 36 s | ✓ GREEN, total 7 314 ms (merge 323, swatches 504, option B 182) | 11 / 12; 1 / 0 / 0; `drainInFlightSkips` 2 | 61 / 38 |
| l2 lunch ON | 8961 | 19:20:24 | 6.91/7.22/7.12 → 8.25/7.53/7.24 | 20 s | ✓ GREEN, total 5 458 ms (merge 246, swatches 505, option B 186) | 11 / 12; 1 / 0 / 0 | 52 / 26 |
| l3 lunch ON | 8961 | 19:26:14 | 5.53/7.95/7.78 → 5.69/7.83/7.74 | 17 s | ✓ GREEN, total 4 547 ms (merge 236, swatches 506, option B 194) | 11 / 12; 1 / 0 / 0 | 52 / 25 |

Store witness per run (the (α4) count on the live gate): 16 events (11
client + 5 LT1), every eventId in exactly ONE derived commit's
`consequence_of`; the votes doc received 3 `add-unique` and **0
`remove-by-value`** (W0's l1 held the remove); `lt1LeftoversPurged 1` in
each run is the castVote LT1 child the deadline found queued, drained and
consequenced one wave after its click's commit (e.g. l1: click 73 → child
74). "Both join lands" 16 / 13 / 11 ms — the echo-inflated shape of §1,
on every run. Before/after shape: `appended 11 / processed 17` (the
re-benchmark, both green runs) and `appended 9 / processed 10` + a vote
toggled off (W0 l1) → `appended 11 / processed 12`, no toggle.

## 8. Chat n=20 smoke (PROVISIONAL; one run; INCONCLUSIVE as a latency comparison — load 9.4–9.6 from a concurrent benchmark)

| run | port | start (UTC) | load in test | result |
|---|---|---|---|---|
| c1 chat ON n=20 @2 s | 8965 (8961 was held by W2's benchmark toolshed — not mine to touch) | 19:32:28 | 9.39/9.60/8.74 | ✓ series COMPLETE (1m42s); median **1 541 ms**, q1 1 408 / q3 1 818, min 1 128 / max 3 208; per-post `1128 1408 1627 1353 1480 1598 1485 1495 1590 1541 1818 2261 3001 1901 3208 1541 1411 1283 1158 1229` |

`events appended 28 / processed 28`, purged / refused / orphan **0 / 0 /
0** — (α) is passive on the chat path (no LT1 cascades there); the only
new per-cycle cost is the purge predicate's O(queue) scan at a cut
cycle. W1's median (1 239 ms) was read at load ~3–4; this number is not
a comparator. A quiet re-run is the W4 acceptance's job.

## 9. What was NOT done and why

- **A shaper-HELD-copy pin for (α2)** — verified by reading (decision 2);
  the pin needs an 11+-event renderer-trusted burst to exhaust the
  shaper's tokens with cut cycles in the window; follow-on, recorded in
  the register's W3 block.
- **The purge refinement** (decision 3) — not built.
- **A quiet chat n=20 smoke** — the box carried a concurrent benchmark
  (load 7–9.6) for the whole session; W4 owns the acceptance numbers.
- **The W2 hand-off's fix** (§1's candidate shapes) — W2's files, not
  touched.
- **The lunch ON skip lift** — decision 4.
- **The `require-await` lint finding in `wave.ts`'s `#foreignGrantFor`**
  — pre-existing (fan-out F1), untouched.
- *Fix-pass (2026-08-19) additions:* the shaper-HELD-copy follow-on
  should cover the HELD LT1 copy too (review m3: held by the wake shaper,
  out of the purge's reach, caught by (α1b) one wave later — exactly-once
  holds, `lt1LateSealsRefused` grows routinely; the counter doc says so);
  the late-seal SPLIT tightening (withdraw a seq-less entry's sibling
  from the appending wave when the copy's own run did not survive it, so
  intent and consequences re-land together) — named in events.md §4's
  AMENDED note, NOT built, owner-visible; the lunch ON skip lift — still
  W2.1's + (α) → 3/3 (the coordinator's call, not the fix pass's).
