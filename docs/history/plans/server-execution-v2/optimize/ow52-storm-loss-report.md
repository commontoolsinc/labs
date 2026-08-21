---
status: historical
created: 2026-08-21
archived: 2026-08-21
reason: "OW52 loss-triage: the convergence-storm ON 'loss' (observer landed=23/40) is NOT a loss — full 40-event accounting shows append admission 40/40, exactly-once processing 40/40, all 40 pushes durable; the observer converges to 40/40. The red is the harness settle racing the serving loop: the ON topology's settle has no server-drain step. Fix: a bounded intent-quiescence step in the harness's served-topology settle."
---

# OW52 — the convergence-storm ON loss (landed 23/40): loss triage

Register row: `docs/specs/server-side-execution/verification-coverage.md`
§3 OW52. Evidence base:
`docs/history/plans/server-execution-v2/stage-c/first-on-ci-gate.md`
row 8 and §3 (the harness posture fix that made this red honest — the
pre-fix mixed posture refused all 40 appends, masking what was recorded
as a real 17-message loss).

Surface: `packages/patterns/integration/convergence-storm.test.ts`,
step "a non-writing session sees every concurrently-posted message"
(step-level ON skip; the file's 3 element-schema tests are green ON).
Under the TRUE ON topology (MultiRuntimeHarness targeting the
integration environment's toolshed), 2×20 pipelined `post` events
(`idle:false`) per writer leave the non-writing observer at
landed=23/40 at assert time.

## 1. Method

- Local toolshed from this worktree
  (`EXPERIMENTAL_SERVER_EXECUTION=true deno run --no-lock -A index.ts`,
  port 8891, fresh `MEMORY_DIR` per run), serving loop verified present
  via `/api/health/stats` (`servingLoop != null`).
- Storm step run against it (`API_URL=http://localhost:8891/`,
  `EXPERIMENTAL_SERVER_EXECUTION=true`), step-skip entry neutered in
  the working tree for triage runs.
- Accounting instruments: the serving loop's own `events.*` /
  wave stats; sqlite store archaeology (the space's full commit log:
  `commit`, `revision`, `head`, `snapshot` tables); a probe test
  (storm shape + read-path dissection + convergence polling).

## 2. Reproduction

Two independent local reproductions, both red at the assert:

- Run 1 (the unmodified step): FAILED, observer missing `bob-9` et al.
  — assert fired ~5 s into the step.
- Run 2 (probe): shaped read landed=**22/40** after the test's exact
  storm + `settle(20)`; missing set = `alice-11..19` + `bob-11..19` —
  **a contiguous per-writer SUFFIX**, not a scattered subset. At the
  same instant the two writers' own shaped reads were 31/40 each and
  the observer's raw replica read of the messages doc matched its
  shaped read (22 links) — the observer's replica was simply at an
  older head, not failing to resolve anything it held.

## 3. The 40-event accounting

Serving-loop counters after run 1 (fresh store, this run only):

| counter | value | meaning |
|---|---|---|
| `events.appended` | **40** | every append admitted; admission lost nothing |
| `events.processed` | **40** | every durable entry delivered and run |
| `events.skippedIdempotent` | 0 | no watermark skips |
| `events.drainInFlightSkips` | 73 | the drain's self-dedupe working (at-most-one-copy) |
| `events.lt1LeftoversPurged` / `lt1LateSealsRefused` / `orphanDeliveriesRefused` | 0/0/0 | no purge-path involvement |
| `waves` / `derivedCommits` | 16 / 16 | |
| `wavesBudgetExhausted` | 9 | the honest flush deadline cutting busy waves — routine under storm |
| `supersededWrites` | 0 | no per-doc supersede drops |

Store archaeology (run 1's space, sqlite commit log):

- 43 authored commits (40 event appends, seq 9–52) + 16 derived
  commits.
- The 40 eventIds appear in `consequence_of` across 10 derived commits
  (1+5+4+4+6+4+3+4+5+4), **each exactly once, zero duplicates** — the
  (α) exactly-once invariant held under storm depth.
- The messages array doc carries **all 40 `append` patches**, one per
  event, each linking a distinct hoisted element doc; all 40 element
  docs exist. Nothing in the durable state is missing.
- Timeline: first append 17:35:47, last consequence-carrying derived
  commit 17:35:49 — the server consequenced the whole 40-event
  pipelined backlog in **~2 s**, finishing AFTER the test's assert
  (the step read its observer view mid-drain and the test failed at
  landed=23; the store reached 40/40 about a second later, with the
  test process already gone — so the loop drains on its own, no
  client-wake dependency).
- The 16th derived commit (seq 59, 17:35:49) is the run's one
  ADVANCE-ONLY commit: its sole write is the watermark doc
  (`of:server-execution-watermark`, `replace /value/seq → 58`),
  `derived_through: 58`, no `consequence_of` — the S1 drain-settle
  quiescence-advance signature (protocol.md §4), minted by the
  serving loop at space quiescence with no client input, after the
  test's assert had already read (and within the same second the
  test process exited). Recorded here because it is also the concrete
  cross-space-pollution witness the sx2 coalescing-gate report
  (`ow-sx2-coalescing-gate.md` §1 claim 2) cites: such advance-only
  commits tick the host-global `derivedCommits` for a space whose
  test is already done.

Probe convergence poll (run 2), reading the observer after the failing
`settle(20)` and then again per extra `settle(5)` round:
22 → 28 → 28 → 33 → 33 → **40/40**. `messageCount` and the raw reads
agree at every sample.

## 4. Where the 17 "die": they don't

**No event and no message is lost at any seam.** Append admission
40/40, drain/dispatch 40/40 with exactly-once consequences, all 40
pushes durable in the messages doc, and the non-writing observer
CONVERGES to 40/40. Against the register row's four candidate seams
(append admission, queue, dispatch, consequence commit): all four are
clean.

On the CoalescedDocListener question the register row raises:
coalescing is real (`coalescedPerWaveMax=11`; up to 11 events
consequenced by one wave commit) but collapses only WAVE BOUNDARIES,
never handler runs — each of the 40 events ran its own handler and
produced its own durable array append. Coalescing-by-design changes
nothing the observer counts.

The red's actual mechanism is the TEST HARNESS's settle contract under
the served topology:

- OFF: `MultiRuntimeHarness.settle` runs
  idle → **`server.idle()` (drain the in-process server fully)** →
  barrier → idle. The server-drain step makes settle terminate only at
  system quiescence.
- ON (toolshed-backed): there is no in-process server handle, so
  settle degrades to N client round trips (idle → barrier → idle).
  Each round completes in milliseconds while the serving loop needs
  ~2–3 s to drain a 40-event pipelined backlog (16 waves, 9 of them
  deadline-cut, by design — serving-loop.md §3's honest flush
  deadline). `settle(20)` therefore returns well before the last waves
  commit, and the assert reads a mid-drain head. The harness's own doc
  comment promised "successive rounds converge" — a promise a FIXED
  round count cannot keep against an asynchronous serving loop.

So the register row's premise ("a REAL loss") does not survive the
accounting: the pre-fix 0/40 was a real refusal-loss (the mixed
posture); the post-fix 23/40 is a REAL-LOOKING RACE — serving-loop
progress at assert time, not loss. What lands is served and delivered;
it just hadn't all landed yet.

## 5. Fix

At the seam the accounting names: the harness's served-topology settle
needs the server-drain step the OFF arm already has. The
client-observable equivalent of `server.idle()` is speculation.md §4
step 2: an event's overlay intent entry retires exactly when its
terminal consequence has ARRIVED back at the firing client (carrier:
the tracked stream entry's own `consequenced`/`status`/`error` fields,
backstopped by `eventWatermark` coverage). The runtime already
maintains the outstanding set
(`overlay-destination.ts` `trackIntent`/`#checkIntents`) and exposes
its size (`Runtime.speculationOverlay.pendingIntentCount`).

The fix (test infrastructure only, no product semantics touched):

- `multi-runtime-worker.ts` gains an `eventQuiescence` RPC — poll the
  runtime's outstanding-intent count to 0, bounded by a caller-supplied
  budget. The OFF arm has no overlay (`speculationOverlay` undefined)
  and resolves immediately.
- `MultiRuntimeHarness.settle`, in the no-in-process-server arm only,
  inserts the quiescence wait between the sessions' idle and the
  barrier — one shared budget (10 s) per `settle()` call across all
  rounds, so a genuinely wedged consequence degrades to today's
  behavior (the assert speaks) instead of hanging the harness — and
  degrades LOUDLY (#6158 review F1): budget exhaustion with intents
  still outstanding warns once with the per-session counts, so a red
  assert on a slow box self-identifies as budget exhaustion (a
  mid-drain read) rather than presenting as the loss shape this
  report disproves. The OFF arm's settle is byte-identical.

Ordering argument: after step 1's idle every fired echo is sealed and
every append is discharging; the quiescence wait then ends only when
every event's terminal consequence has arrived at ITS writer, which
requires the server to have committed it; the following barrier
(`pullOpenSpacesToHead`) is an ordered-after round trip, so the
observer's replica reaches a head ≥ every consequence commit; step 4's
idle re-derives. The observer's schema-read demand for newly-linked
element docs resolves across the remaining rounds (the storm step runs
20).

This restores settle parity between the arms FOR FIRST-ORDER
CONSEQUENCES — the ON settle now means what the OFF settle always
meant for a session's own sends ("the server has drained what I
sent") — and does not weaken the step's assertion: the step still
asserts full 40/40 reader convergence on a session that never wrote.
Scope caveat (#6158 review F2): the wait is NOT full `server.idle()`
parity — a server-side cascade child (an event a served handler
itself emits) is no session's intent and commits in a later wave,
outside the wait; cascades ride the ordinary barrier rounds. The
storm's `post` handler emits no cascades, so nothing here depends on
that gap; a future harness test asserting on cascade results needs
enough rounds or a `waitFor`.

Red-first: the step (skip lifted) is the red test — red twice locally
pre-fix (landed=22, 23), green 5/5 post-fix (see §6).

FLAG, recorded not decided (adjacent, out of this fix's scope): under
ON, a client that does `await send(); await runtime.idle()` has no
guarantee its OWN send's consequence is visible — OFF's idle implies
it (the handler ran in-process). The harness now closes that gap for
TESTS; whether the PRODUCT's idle/settle vocabulary should carry an
intent-quiescence barrier is a spec question adjacent to OW47's
pending-commit-barrier seat (S-F covers binding writes), not
something this fix decides.

## 6. Verification

All local, this worktree, against the ON toolshed on port 8891 (fresh
store), `--no-lock` throughout:

- Storm step ON (skip entry lifted): **5/5 green**, ~7–8 s per run —
  the ~2 s over the red runs' ~5 s is exactly the serving drain the
  settle now honestly waits for.
- `convergence-storm.test.ts` full file: **4/4 ON**, **4/4 OFF**.
- Harness family under the settle change:
  `cfc-group-chat-demo-multi-runtime` 7/7 ON, 7/7 OFF;
  `cellset-lww` 3 green + OW47 step skipped ON, 4/4 OFF;
  `data-file-multi-runtime` 2/2 ON, 2/2 OFF;
  `cellset-lww-lost-update` 2/2 ON, 2/2 OFF.
- `tasks/server-execution-on-skips.ts patterns` self-run: exit 0, the
  convergence-storm step entry gone, every remaining entry validated
  (the cellset step guard still bound).
- `deno check` on the harness + worker: clean.

Register row OW52 CLOSED in the same change (docs-move-together);
skip-entry status: the `integration/convergence-storm.test.ts` step
entry LIFTED. The in-file guard wiring stays (designed binding for any
future entry; a guard without an entry is a no-op and the validator
only checks the other direction).

## 7. Post-merge addendum: the census's group-chat waitFor flakes (items 1+3)

The owner's ON-flake census (2026-08-21; 123 runs, 25 ON failures, all
pattern-ON) counted 10 shard-7 failures of
`cfc-group-chat-demo-multi-runtime.test.ts` "admin lockdown gates room
creation but never message sending" (`Timed out waiting for: bob's
post-lockdown message arrives at alice`, `MultiRuntimeHarness.waitFor`)
plus one of "admins can grant admin to another user by name" — every
observed failure PRE-dating #6158's merge.

Coverage verdict: **this fix covers them.** The failing primitive is
`waitFor`, whose every poll calls `settle(1)` — and since #6158 each
such poll blocks (bounded) until the polling sessions' fired events
have their terminal consequences ARRIVED, then barriers to head. Bob's
message send is exactly such an intent and the awaited message is its
first-order consequence, so the former poll race (fast no-op polls
burning the 30 s window while a loaded runner's serving loop drained)
is now an event-driven wait at the settle layer; the `waitFor` timeout
remains only the failure bound, per
docs/development/waiting-in-tests.md. No timeout was changed.

Empirical verification (quiet dev box, dev toolshed ON, fresh stores):
the full file — both census tests included, 7 steps per run —
**12/12 green at 1907e050e** (this fix's squash, pre-#6156) and
**12/12 green at 9d989c0c1** (main tip with OW31's identity build),
6–17 s per run, zero quiescence-budget warnings. The census's
load-dependence caveat applies to any local bench; the mechanism
coverage above is the primary argument, the 24/24 the corroboration.
