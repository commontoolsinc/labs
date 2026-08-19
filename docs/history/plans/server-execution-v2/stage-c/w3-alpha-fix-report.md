---
status: historical
created: 2026-08-19
reason: "Stage-C W3 (α) review-fix pass for PR #6043: every finding of the independent review (1 BLOCKER / 2 MAJOR / 3 MINOR / 4 NIT) dispositioned with fixing SHA and red/green evidence; the branch rebased onto W1's final tip 963ff600e; suite counts and the 3/3 lunch-gate ledger at the fixed tip."
---

# W3 (α) review-fix pass — PR #6043 (server-execution v2, stage C)

Date: 2026-08-19. Review report (verbatim):
[`w3-alpha-review-report.md`](w3-alpha-review-report.md) beside this file
— **LANDABLE-WITH-FIXES, 1 BLOCKER / 2 MAJOR / 3 MINOR / 4 NIT** at
`4f2bda2d7`. Worktree `/Users/berni/labs-worktrees/fix-w3` (branch
`fix-w3-local` → pushed to `claude/server-exec-v2-w3-alpha`). Durable
copy of this report: `/Users/berni/labs-worktrees/w3-alpha-fix-report.md`.
Every deno invocation `--no-lock`; suites foreground under per-call caps.

## 0. Rebase

The branch was rebased from the W3 build base `19c6448ab` onto **W1's
final tip `963ff600e`** (W1's own review-fix pass). One conflict, in
`verification-coverage.md` (W1's fixer appended its review-disposition
block — including the OW41 mint — where W3's commit appended the W3
LANDED block): resolved keeping BOTH blocks in order. The history
INDEX's directory line was duplicated by the union driver (both W1 and
W3 amended it); folded into ONE line carrying W1's review/fix reports
AND the W3 build report (`6d302f8d5`). Code hunks applied clean —
byte-identical across the rebase (the W1 fixer's `space-server.ts`
changes and W3's touch disjoint regions). W3 minted no OW row, so no
collision with W1's OW41 (W2's separately-minted OW41 is the
re-stacker's to renumber — untouched here). ONE
`--force-with-lease` push for the rebase; every later push fast-forward.

## 1. Findings → dispositions (severities exactly as the report)

| ID | severity | disposition | SHA | red/green evidence |
|---|---|---|---|---|
| **B1** — α1b + a same-eventId sibling tx = a LOST delivery (regression vs base) | BLOCKER | **FIXED** (reviewer's F1: `survivedEventIds.add` only when `contribution.context.lt1 === true` — only the LT1 copy's OWN run marks its seq-less entry; auxiliary same-eventId txs never mark) | `499c9dd7b` | New pin **"(α1b)+(α4) + a same-eventId SIBLING tx"**: an async LT1 child commits an event-handler-stamped sibling tx (the served navigateTo intent shape, `navigate-to.ts` `stampServerRun(intentTx, {kind: "event-handler", eventId: context.eventId, …})`) before an await spanning the 150-ms deadline. **RED on the build tip's code** (mutation run `mut-F1-reverted.log`: the entry consequenced before the gate — the sibling's survival marked it; the reviewer's probe on `4f2bda2d7` read `counterC 0, processed 1`, on the W1 base `counterC 1`), **green after F1**: entry unmarked, the drain re-delivers (`processed 2`), the effect lands exactly once (`counterC 1`), the sibling's write once, refusal 1, no purge/orphan/notice. The pin also asserts the store-side per-event commit count reads **2** here (the sibling's commit + the drain's) with a comment recording why that count is never the run-count witness (it reads 1 for a same-wave double — W0's l1 — and 2 for this split). |
| **M1** — α3 leaves the sibling standing: the intent half of an orphan LANDS | MAJOR | **FIXED** (reviewer's F2: an `eventOrphaned` fold beside `eventRequeued` — same-eventId siblings of an orphan-refused contribution are dropped whole with it; `orphanDeliveriesRefused` counted once per EVENT, not per contribution) | `499c9dd7b` (+ pin hardening `a4bb91e0d`) | New pin **"(α3) + a same-eventId SIBLING tx"**: the orphan pin's "ping" run commits the sibling inline; **RED with the fold off** (mutation runs `mut-F2-off-1/2.log`: `side` 1 — the intent half landed, 2/2 runs), **green with it** (`side` 0; `orphanDeliveriesRefused` 1 for two folded contributions; every consequenced id durable). Pin hardening (`a4bb91e0d`): the settle gate engages on the EARLIEST visible seal (the inline sibling's — the handler's seal is third on the chain once a sibling precedes it and could land after the settle barrier's check, a 2-in-3 flake in repeat runs), and the pin asserts the wave is HELD (no entry committed) before the rival fires. 4/4 green repeats after. |
| **M2** — OW35 "CLOSED" + events.md §4's LANDED note overstate the code | MAJOR | **FIXED** (restated honestly) | `15eae6d2c` | events.md §4: a dated **AMENDED** note states the sibling shape, that the code was WEAKER than the ruled sentence's letter in that corner until the fix, the two fixes, the pins, and the recorded residual (the late-seal SPLIT: intent in the appending wave, consequences with the drain's run one wave later — idempotent by the nonce dedupe; a tightening that withdraws the timing-orphaned sibling is named, NOT built, owner-visible). Register: OW35 gets a **RE-READ** paragraph — CLOSED stands for the pinned shapes, the sibling shape now among them, with B1/M1 named; the W3 block's coverage rows carry the sibling pins and the m1 extension; the design doc's §6 W3 LANDED note carries the review outcome. |
| **m1** — α4 pins blind to an over-reaching purge | MINOR | **FIXED** (pin extension) | `499c9dd7b` | Pin 1 now holds its gate ≥450 ms after the drain queued `c1'`/`c2'` (≥2 further 100-ms deadlines, `wavesBudgetExhausted > 1` asserted) and asserts `lt1LeftoversPurged` stays 1, `processed` stays 3, and no `status` lands on either entry. Mutation M4 (predicate widened to `event.served !== undefined`) — which left all three α pins GREEN on the build tip — is now **RED inside pin 1** (`mut-M4.log`: `lt1LeftoversPurged` 3 ≠ 1), plus the suite's trio pins as before. |
| **m2** — OW37 re-read wording wrong-direction | MINOR | **FIXED** (text) | `15eae6d2c` | The register row now says: W3's exhausted ratios 0.62 / 0.50 / 0.48 vs W0 l1–l3 0.46 / 0.39 / 0.26 — **HIGHER**, not "fewer", confounded by load (W3 1-min loads 4.5/6.9/5.5 → 8.8/8.3/5.7; W0 5.0/2.9/3.6, from the driver logs); the ratio metric stays owed to W4's quiet run. |
| **m3** — shaper-HELD LT1 copies invisible to the purge; the counter doc would misread the benign class | MINOR | **FIXED** (docs/comments honest; the pin itself stays a follow-on) | `0b8156c09` + `15eae6d2c` | `stats.ts`'s `lt1LateSealsRefused` doc now names the two benign growth classes — the deadline-spanning async handler AND the shaper-held LT1 copy (held by `shouldShapeDelivery`, out of the purge's `eventQueue` reach, caught by α1b one wave later; exactly-once holds at one refused run + one cycle) — and scopes the "names a handler…" warning to `processed` never settling. serving-loop.md §7 says the same; the register's α2 row records that the follow-on shaper pin should cover the HELD LT1 copy too, not only the drain-held one. The dedicated shaper-held pin is NOT added (the review itself judged it optional — "α1b covers them"; the builder's follow-on row stands, now with the wider scope). |
| **n1** — pin 1's title mutation clause imprecise ("four times" needs more seats off) | NIT | **FIXED** (title corrected to what is observed) | `af9a06e69` (first cut `499c9dd7b`) | Measured: purge+refusal+absent-emitter-clause off → effect **4×** observed only with the counter asserts relaxed (`mut-3way-probe.log`: `counterC 4, childRuns [c1,c2,c1,c2]`); as written the pin reddens first on the purge counter (`mut-3way.log`). The title now says: refusal + absent-emitter clause → 3× (the lunch double); all three seats off → 4× with the counters relaxed. |
| **n2** — `handleCommitResult` sentinel path skips the commit-telemetry submit | NIT | **FIXED** (comment states it, deliberate) | `0b8156c09` | The sentinel-path comment says the early return skips the `scheduler.event.commit` submit for the refused copy and why (not a commit outcome; the drain's copy reports its own). |
| **n3** — `seal()`'s refusal skips `#feedArrived?.resolve()` | NIT | **FIXED** (comment states the non-wake and its reasoning) | `0b8156c09` | The refusal comment now records that a refused seal does NOT wake the loop and that a future caller relying on "every seal wakes" would not get it from a refused one (the drain's copy wakes it on its own seal). No behavior change — the reviewer judged it correct today. |
| **n4** — `cell.ts:1730` keys the LT1 branch on the CELL's space (pre-existing, not W3's; with W3 the α3 refusal + the target drain make it conservative and exactly-once) | NIT | **NOT CHANGED** (flagged, as the reviewer asked — pre-existing, W3 accidentally improves it; a fix belongs to the cell/serving-space seam, not this PR) | — | Recorded here and in the ledger; no code touched. |

Dispositions: **9 FIXED, 1 NOT CHANGED (n4, flagged) — nothing silently
dropped; no finding upgraded or downgraded.**

## 2. Mutation ledger (fix pass; each run against the full file, then reverted — tree clean after each)

| mutation | expected | observed | log |
|---|---|---|---|
| F1 reverted (`lt1 === true` gate removed — the build tip's marking) | B1 pin RED | RED at "entry must be unmarked" (`consequenced` true before the gate) | `mut-F1-reverted.log` |
| F2 fold off (`eventOrphaned` short-circuited) | M1 pin RED (`side` 1) | RED ×2 runs: `side` 1 ≠ 0 | `mut-F2-off-1/2.log` |
| M4 purge predicate `served !== undefined` | pin 1 RED at the held-gate extension | RED: `lt1LeftoversPurged` 3 ≠ 1 (also the trio pins, as at review) | `mut-M4.log` |
| purge + refusal + absent-emitter clause off | pin 1/2/B1-pin RED on counters | RED ×3 pins; with counters relaxed: effect 4× (`counterC 4`) | `mut-3way.log`, `mut-3way-probe.log` |

## 3. Suites at the fixed tip (every green a LOCAL run — stacked PR, no CI)

| suite | result |
|---|---|
| runner (package-task flags + clock preload, three invocations under the 600-s per-call cap) | **1212 passed (6732 steps), 0 failed** (2m17s + 7m5s + 5m22s) — W3's 6728 + 2 (W1's fix pins, via the rebase) + 2 (the sibling pins) |
| `executor-events-down.test.ts` alone | 1 passed (18 steps); 4/4 green repeats after the M1-pin hardening |
| memory | **522 passed (229 steps), 0 failed** (16s) — W1's principal pin included |
| toolshed | **142 passed (428 steps), 0 failed** (21s) |
| runtime-client | **61 passed (212 steps), 0 failed** (2s) |
| piece (sharded task) | **37 passed (451 steps), 0 failed** (1m9s) |
| spec-model | **23 passed, 0 failed** (0.5s) |
| `tasks/server-execution-on-skips.test.ts` | **17 passed, 0 failed** |
| `deno task --no-lock check-docs` | **All 548 checked code blocks passed** |
| `deno task --no-lock check-docs-history-index` | 120 entries / 167 documents, clean |
| `deno fmt --check` (the 11 touched TS files) | clean |
| `deno lint` (the 9 touched runner files) | 1 finding — the PRE-EXISTING `require-await` at `wave.ts:2477` (`#foreignGrantFor`, fan-out F1), untouched |
| `deno check` (space-server, wave, facade, events, cell, stats) | clean |

## 4. Lunch gate ON at the FIXED tip (fresh store per run; binary built from `15eae6d2c` with `EXPERIMENTAL_SERVER_EXECUTION=true`, sha256 `546fa34b3ba28d4f`; posture per run `shellServerExecutionDefine: "true"`; `No default model available` per run, 0 `CFTS_AI_LLM_*` keys, no `.env`; `gtimeout --kill-after=30 520`; logs read with `/usr/bin/grep -a`; load gate ≤5 waited-for before each run; loads recorded; no orphaned browsers in any run)

| run | port | load 1/5/15 before → after | test wall | result | events (appended/processed; purged/refused/orphan) | waves/exhausted | store witness | "both join lands" |
|---|---|---|---|---|---|---|---|---|
| l1 | 8961 | 4.19/10.23/26.18 → 5.04/9.68/25.25 | 30 s | ✓ GREEN, total 7 174 ms | 11 / 12; 1 / 0 / 0 | 54 / 28 | 16 events × exactly 1 derived commit; votes **3 add-unique / 0 remove-by-value** | 12 ms |
| l2 | 8961 | 4.54/7.75/21.78 → 5.83/7.75/21.30 | 22 s | ✓ GREEN, total 5 425 ms | 11 / 12; 1 / 0 / 0 | 53 / 26 | 16 × 1; 3 / 0 | 11 ms |
| l3 | 8961 | 5.00/7.10/19.98 → 6.71/7.30/19.67 | 19 s | ✓ GREEN, total 6 194 ms | 11 / 12; 1 / 0 / 0 | 55 / 27 | 16 × 1; 3 / 0 | 12 ms |

**3/3 GREEN.** The "both join lands (count reaches 2)" step still passes
at the FIRST probe (11–12 ms after the guest's click — faster than any
server round trip): the spurious-fast shape of the stranded client echo,
unchanged without W2.1 — said plainly, as at the build. The vote class
stays closed (3 adds / 0 removes in every store; every event exactly one
consequence commit). The box carried concurrent work (1-min load 4.2–5.0
at start, 15-min 20–26); the counters are the witness, the walls are not.

## 5. The lunch ON skip

NOT lifted (not this pass's call): the entry, its rewritten reason, and
the lift condition — **W2.1's cascade-echo fix (or the join step
re-pointed at the CONFIRMED count) + 3/3 green** — stand exactly as the
build left them; the skip-list test (17 passed) still pins the wording.

## 6. Not done

- The **shaper-HELD-copy pin** (α2 follow-on; m3 widened its scope to the
  held LT1 copy) — still a follow-on; the docs now carry the class.
- The **late-seal SPLIT tightening** (withdraw a timing-orphaned sibling
  from the appending wave so intent and consequences re-land together) —
  named in events.md §4's AMENDED note, owner-visible, NOT built.
- **n4's underlying seam** (`cell.ts` keying LT1 on the cell's space) —
  flagged only, per the reviewer.
- The **lunch ON skip lift** — the coordinator's/owner's call.
- The pre-existing `require-await` lint finding — untouched.
