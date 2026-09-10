---
status: historical
created: 2026-08-19
archived: 2026-08-19
reason: "Stage-C build W3.1 — S1 (RULED 2026-08-19): the drain-settle quiescence advance — the swatch-stall class fix landed with red-first pins; the lunch ON skip LIFTED on 6/6 green with every swatch wall at 1 ms; OW43 closed."
---

# Stage C — W3.1: S1, the watermark covers the tail derivations at drain-settle (server-execution v2)

Builder: W3.1, on the train tip branch `claude/server-exec-v2-w3-alpha`
(base `e386a01be`, PR #6043). Commits: `7ee58e35c` (S1 + pins + spec +
ruling), `78959c26c` (a pre-existing flaky pin hardened, attributed),
`f250feacd` (register), plus this report's commit. Date: 2026-08-19.

## 0. The ruling and what it seats

Owner (Berni), 2026-08-19, in chat, responding to the coordinator's
recommendation of S1 (the swatch-stall report's fix seat: "advance W
over the tail derivations at drain-settle — the class fix; also makes
W honest at quiescence, which W4's settle metric needs; owner-level
because W's 'covers inputs' meaning is RULED text"):

> S1 sounds good.

That rules seat S1 and nothing else (α1b's ratification and flag 9
stay pending; shape (b)/S2 stays the flagged follow-on; S3 not taken).
Landed at the plan's owner item (10) (REQUESTED → RULED, the quote
attributed) and as protocol.md §4's amendment.

## 1. The amended sentence

protocol.md §4's governing definition is quoted in place and extended
by the dated amendment. The definition (unchanged):

> Definition (sharpened by the 2026-08-02 demand ruling): `W(space)` =
> highest seq such that every authored commit ≤ W has all handler
> consequences committed AND all DEMANDED derivations current through
> W (demand per serving-loop.md §1/§3b — undemanded derivations stay
> dirty-unmaterialized without holding W back).

The amendment's operative sentence (the new §4 bullet, RULED
2026-08-19):

> Amendment: at drain-settle — the serving loop reaching TRUE
> quiescence for a space (a settled, non-exhausted cycle; no
> contributions, no pending events, the drain empty) — W additionally
> advances over the space's committed TAIL DERIVATIONS: the loop's own
> derived commits whose seqs lie contiguously above the input coverage
> point.

Reading taken, FLAGGED as the brief required (the pre-amendment text
was silent on whether W may cover a derivation that covers no demanded
instance): **W may sit above seqs that are not authored commits — the
ruled definition's quantifier ranges over authored commits only**, and
the tail derivations are already committed and delivered, so the
advance asserts nothing new about coverage; it closes the quiescence
gap ("each new input lifts the previous generation" holds without a
next input). Normative bounds in the same bullet: committed seqs only
(no speculative advance); once per quiescence transition; the
advance's own bookkeeping commit is never chased (the one derived
commit W does not cover at quiescence, definitionally — chasing it
would mint a successor, the commit-storm class); any non-own seq above
the coverage point is a hole the advance stops below, fail-closed.
serving-loop.md §3 gains the `on drain-settle` step and §7 the
`settleAdvances` counter vocabulary.

## 2. The seat, as built

`packages/runner/src/executor/space-server.ts` (the wave cycle's
advance computation):

- `#ownWaveSeqs` — this loop's committed wave seqs still above W (the
  contiguity domain; engine seqs are dense — `MAX(seq)+1` inside the
  insert transaction — so any in-flight authored notice, late-authored
  record, or foreign commit above the base is a hole the walk stops
  at). Pruned as W advances.
- `#settleAdvanceOwed` — the once-per-transition latch: armed at
  commit by waves with CONTENT contributions (`wave.ts`'s new
  `contentContributionCount` — derivation/event-handler kinds; a
  bookkeeping-only wave never arms it), consumed when the quiescence
  advance SEALS (a failed seal keeps it armed; the idle-wait timeout
  bounds the retry).
- The fire site extends the existing `advanceTo` computation: at a
  quiet settled cycle (`!exhausted`, no contributions, no pending
  effects, feed empty, no pending seals, no event scan or effects
  retirement owed) with the latch armed, walk from
  `max(W, inputAdvanceTo)` upward over `#ownWaveSeqs` and advance to
  the tail. The EXISTING bookkeeping-write + wave-commit + seal-failure
  machinery carries it unchanged — one mechanism, no new commit path.
  The advance-only wave reaches clients through the ordinary
  watermark-doc write + push (noteExecutorCommit → M4), which pin 1
  verifies end to end with no other traffic.
- Counters: `settleAdvances {count, lastDelta, series[{space, from,
  to, at}], dropped}` in `stats.ts`, deep-copied in `host.ts`, exposed
  through `/api/health/stats.servingLoop` — split from the per-input
  `settle` series so W4's settle metric and §4 amplification
  arithmetic can subtract the designed advance-only waves.
- The client sweep comment (`overlay-destination.ts` `#sweep`) — the
  OW43 subject text — rewritten to the now-true form.

## 3. Pins, red-first (`packages/runner/test/executor-settle-advance.test.ts`; realClockFiles entry added)

All red on `e386a01be` before the fix, then green; 3× consecutive
green at the fixed tip; every suite in §5 green after.

1. **Frozen-W (the i10 shape).** RED: `timed out waiting for the
   drain-settle advance … (W frozen at input coverage; derived tail
   4)` — the report's W-below-floor freeze reproduced at the pin
   level. GREEN: W advances past the input coverage with NO authored
   commit (`W > max authored seq`, both sides recomputed per poll),
   covers the content tail, and `waitForSettled` on the CLIENT
   resolves through the ordinary watermark-doc push with no other
   traffic. Killing mutation (A): the fire gate disabled — red on the
   frozen-W wait.
2. **The diverged layer retires at quiescence (the report §5 probe
   shape, minimal seam).** A stamped derivation-kind re-derivation on
   the REAL client seal path reads the pushed derived value (floor =
   the derived commit's seq) and writes a DIVERGED value over the same
   doc — the tombstone's shape. RED: masked 30 s (the sweep's floor
   unreachable). GREEN: the layer retires on the quiescence advance
   and the HEALED confirmed value renders; the engine's authored count
   is unchanged across the heal (no keystroke needed). Killing
   mutation (A): red on the retirement wait.
3. **Idempotence / no self-chase.** After the trailing advance, a
   quiet space commits NOTHING further — counters and the engine head
   flat across a 700 ms window. Killing mutation (B2): the latch
   consume removed → one advance per echo cycle (the storm) — caught
   in 920 ms. (Mutation B — arming the latch on bookkeeping-only waves
   — is INERT by ordering: the arm precedes the consume; stated in the
   register so nobody "fixes" the ordering.)
4. **OFF witness.** The OFF arm constructs no SpaceServer — no serving
   loop reaches the advance at all; an OFF client derives client-side,
   the engine holds zero derived-class commits and no watermark doc
   (`readWatermarkSeq` 0).
5. **Busy-space neutrality.** Ten rapid unawaited-settle inputs: the
   advance never fires mid-stream (count ≤ 4, ≥ 1 — the trailing
   transition plus at most scheduling-jitter gaps, far below
   one-per-wave); per-wave watermark semantics untouched (the whole
   existing watermark/serving-loop pin population stayed green
   unedited except the one FLAGGED hardening below). Workload-level:
   the chat smoke's 54 advances over 193 waves.

## 4. Flagged edits and flags (nothing silent)

- **`executor-serving-loop.test.ts` stability pin (FLAGGED EDIT):**
  the pin now waits for the designed trailing advance before sampling
  its 400 ms stability window. Meaning unchanged (the wave count
  stabilizes; no self-chase) — and it now also witnesses the advance's
  no-successor guarantee. Without the edit the pin raced the advance's
  echo cycle (a flake, not a real red).
- **`sx2-serving-loop.test.ts` budgets (FLAGGED EDIT):** the waves and
  amplification budgets subtract `settleAdvances` (each quiescence
  transition mints one designed advance-only wave) and a new bound
  pins the latch (`advances ≤ authored + 1`). The budget's purpose —
  catching runaway amplification — is preserved; S1's advances are
  latch-bounded by construction and split in the stats for exactly
  this arithmetic.
- **`executor-effect-channel.test.ts` receipt-race pin (PRE-EXISTING
  FLAKE, fixed in its own commit `78959c26c` with the attribution):**
  W3.1's full-suite gate found it red; the CI-attribution ritual ran
  before any blame — the exact failing assertion is the 15 s poll for
  the live intent ENTRY; the causal chain is the DESIGNED
  enact→ack→retire pipeline consuming the entry in ~30–80 ms;
  reproduced RED 1/10 at the PRE-S1 base `e386a01be` under load; the
  engine traces of red runs are byte-identical through the event's
  consequence commit on both tips. NOT an S1 regression. The fix adds
  the RETIRED observable (the effects instance exists — only the
  server's intent write creates it — plus the recorded enactment); an
  earlier draft that accepted the optimistic enactment alone failed
  6/6 deterministically and was discarded (the optimistic arm precedes
  all server work). 8/8 green under load after.
- **Residuals (FLAG, not filled):** (i) a LATE authored record (its
  notice arriving after a later echo advanced the input head) is never
  covered by the in-order coverage math, so the advance stops below it
  and W stays there until the next ordinary input — pre-S1 behavior,
  unchanged; the one remaining stall residue of that rare
  interleaving. (ii) The walk's fail-closed hole property is
  construction-guaranteed (Set membership over dense engine seqs), not
  pinned by a dedicated in-flight-notice interleaving test — a
  deterministic seam would need a notice-holding server shim. (iii)
  The advance-carrying commit itself is definitionally uncovered at
  quiescence; a client derivation READING the watermark doc could
  carry that seq in its floor and linger to the next transition (no
  known reader; the id class is excluded from piece demand). (iv) The
  spec-model's W does not yet model the tail advance (its properties
  quantify over inputs/events and stay green); a modeled
  quiescence-advance is a possible follow-up row. (v) The
  growth-landing adjacency heuristic (MINOR-4) is unchanged — a
  quiescence advance right after a growth wake can take the landing
  slot; W4 can cross-reference the settleAdvances series timestamps.

## 5. Suites (all local, foreground; counts as run)

- runner FULL (package task, realClockFiles): **1216 passed (6753
  steps), 0 failed** (after the flake fix; the pre-fix full run was
  1215/6752 with the one receipt-race red).
- memory: 522 passed (229 steps) + `deno check .` clean. toolshed:
  142 passed (428 steps). runtime-client: 61 passed (212 steps).
  piece: 37 passed (451 steps). spec-model: 23 passed.
- the skip-list test (`tasks/server-execution-on-skips.test.ts`):
  17 passed — post-lift shape (ONE patterns entry).
- `SCHEDULER_LIVENESS_EQUIVALENCE=1` on the executor family (15
  files): 17 passed (191 steps).
- `deno task check-docs`: green (with the history INDEX updated).
  fmt/lint clean on every touched file.

## 6. The lunch gate — 6/6 GREEN; the skip LIFTED

ON-built binary at the tip (`EXPERIMENTAL_SERVER_EXECUTION=true deno
task build-binaries toolshed`; sha256 `53a712cede690b6e…`), fresh
store + posture verification + `No default model available` per run,
`gtimeout --kill-after=30 520`, loads recorded per run (2.3–3.7, quiet
box), `/usr/bin/grep -a` on logs. Every wall in milliseconds:

| run | total | join (confirmed) | merge | **swatch step** | option B | advances | events a/p (purged) | multiplicity | load |
|---|---|---|---|---|---|---|---|---|---|
| w31-1 | 4281 | 254 | 454 | **1** | 122 | 10 | 11/12 (1) | {1:16} | 2.5 |
| w31-2 | 3948 | 255 | 390 | **1** | 151 | 11 | 11/12 (1) | {1:16} | 2.3 |
| w31-3 | 4214 | 254 | 436 | **1** | 35 | 11 | 11/12 (1) | {1:16} | 2.3 |
| w31-4 | 3467 | 255 | 517 | **1** | 176 | 13 | 11/12 (1) | {1:16} | 2.7 |
| w31-5 | 3923 | 255 | 307 | **1** | 132 | 10 | 11/11 (0) | {1:16} | 3.1 |
| w31-6 | 4334 | 256 | 293 | **1** | 225 | 10 | 11/11 (0) | {1:16} | 3.7 |

PASS by the brief's rule: 6/6 green AND every swatch step's wall a
normal arrival — 1 ms in every run; no 28-s recoveries, no timeouts.
Consequence multiplicity {1:16} in all six stores — the (α)
exactly-once invariant held in both the purge shape (4 runs) and the
coalesced shape (2 runs). The designed W2.1 flicker remains (host
flicker counter 0–1 per run) — S1 fixes the retirement, not the
flicker; shape (b) stays the owner-flagged follow-on. **The lunch
entry is removed from `tasks/server-execution-on-skips.ts`** (the lift
ledger in its header comment; the skip-list test asserts the
one-entry patterns state); plan owner item (9) → DONE.

## 7. The chat n=20 smoke — PROVISIONAL

One run at the tip (fresh store, posture + no-model verified, load
4.3–4.4): series complete, **median 544 ms** (q1 459 / q3 563 / min
373 / max 622) — inside/below W1's quiet band; events 28/28,
purge/refusal/orphan 0/0/0; `settleAdvances` present and
quiescence-only (54 over 193 waves — never per-wave; the busy path is
neutral); settle series value-only p50 19 ms, structural-growth p50
500 ms. No regression from S1 on the busy path.

## 8. Where a successor picks up

- The branch tip after this report's commit is the deliverable; PR
  #6043's body carries the W3.1 section. The combined independent
  review of W2.1+S1 is NEXT (no ledger comment posted, per the brief).
- If the review wants the in-flight-notice interleaving pinned:
  build a notice-holding shim on the server facade (hold
  `enqueueCommit` for one authored commit while the loop quiesces;
  assert the advance stops below its seq and resumes after delivery).
- The scratch stores and driver logs for the 6+1 runs:
  `…/scratchpad/w21bench/runs/w31-{1..6}-lunch-on`, `w31-c-chat-on`;
  the binary `…/w21bench/toolshed-w31`; build log `build-w31.log`.
