---
status: historical
created: 2026-08-20
archived: 2026-08-20
reason: "Stage-C W4 — the acceptance measurement on the finished build train (OW38 (i)): server settle p50 15–20 ms (all-inputs) on chat and lunch — the sub-second bar PASSES both journeys; the several-second sends GONE (chat arrival median 421–520 ms vs the trio tip's 7.4–9.7 s; lockdown 3–4 ms vs 3.3–4.1 s); note createToView FLAT and faster than OFF at p50 (829–991 vs 1100–1193 ms); lease.lost 0, {1:16} multiplicity, walkRuns absent, OFF witness held; ONE bar fails as worded — the sender echo is not ms-class in either arm and ON runs 1.5–2.4× OFF on chat (attributed to the client (e) term). 6 of 7 bars PASS."
---

# Stage C — W4: measurement and acceptance (server-execution v2)

Benchmarker: W4, on the train tip branch `claude/server-exec-v2-w3-alpha`.
Base: `6175ccc65` (the combined W2.1+S1 fix round's docs tip). Code commit
this report measures: `44bb76b05` = `6175ccc65` + the sender-echo
instrument (Step 0 below; measurement-only, patterns integration harness,
no production code). Worktree `/Users/berni/labs-worktrees/w4-bench`
(detached; local branch `w4-local`; pushed fast-forward only). Durable
copy: `/Users/berni/labs-worktrees/w4-acceptance-report.md`. Raw series
(per-ON-run `settle-series.json`, `settle-advances.json`,
`demand-block.json`, the sender-echo series, the run ledger):
[`w4-raw/`](w4-raw/) beside this file. Full artifacts (driver/test/toolshed
logs, stats pre/post, per-run sqlite stores, 10-s load samples): session
scratchpad `…/0e87bf81-…/scratchpad/w4bench/runs/<run>/`. Every deno
invocation `--no-lock`; every run FOREGROUND under
`gtimeout --kill-after=30 520`; protocol = the re-benchmark's per-run
recipe verbatim (stage-c-rebenchmark-report.md §2) with the W4 deltas
listed in §6. Design scope: `stage-c-design.md` §6 "W4 — measurement and
acceptance".

## 0. Acceptance readout (the design's bars; PASS/FAIL, one number each)

| # | bar | verdict | the number |
|---|---|---|---|
| 1 | Server settle sub-second at p50 on chat AND lunch | **PASS** | chat all-inputs coverage p50 **18 / 15 ms** (2 reps); lunch **17 / 20 / 17 ms** (3 reps); growth-to-landing p50 chat 487/314 ms, lunch 258–520 ms — every p50 sub-second; p95 beside them in §2 |
| 2 | Client arrival: the several-second sends GONE | **PASS** | chat send→other-browser median **520 / 421 ms** (trio tip 7 397–9 734 ms; OFF here 217–253 ms); lockdown propagation **3–4 ms** (was 3.3–4.1 s); lunch merge **305–396 ms** (was 3.7–6.3 s) |
| 3 | Sender echo preserved (ON ≈ OFF, ms-class) | **FAIL (as worded; attributed)** | the echo is NOT ms-class in EITHER arm under the DOM-render definition: chat ON p50 **264 / 166 ms** vs OFF **108–114 ms** (1.5–2.4×, attributed to the client (e) intent-tracking term — Alice runs 2.8–2.9× OFF's actions; the server is not in the path: settle p50 15–19 ms); lunch mixed — both JOIN echoes ON ≤ OFF (41–63 vs 63–88 ms), the veto echo 2–8× OFF in 2/3 runs (max 181 ms). Absolute values sub-half-second everywhere |
| 4 | Note createToView FLAT (slope ≈ OFF's) | **PASS** | ON p50 **991 / 829 ms** — BELOW OFF (1 100–1 193); first→last-10 medians ON 797→1 194 / 779→1 174 vs OFF 376–495→1 204–1 253 (both arms end at the same plateau; the monotone 1→13 s witness is GONE — ON max 2.1 s vs the re-benchmark's 13.7 s); per-note client `scheduler/run` flat 64–147 ms ON vs 40–112 ms OFF (instrumented pair) |
| 5 | §7 demand counter block present and consistent | **PASS** | every ON run: the (d′) block complete; **no `walkRuns` key** anywhere in `/api/health/stats` (checked per run); `demandPassMs` 4.8–11.3 ms/pass (the O(rows) class; W0's flag-4 pathology was 21); `settleAdvances` split and quiescence-only (10–71 per run; the per-input settle series carries no advance rows by construction) |
| 6 | OFF byte-identity witness | **PASS** | OFF suites green at this tip (runner both halves **1 216 passed / 6 756 steps / 0 failed**, OFF ambient — re-run here, not just cited); every OFF run has NO `servingLoop` key (pre and post); OFF stores authored-only everywhere; lunch **398 = 398 = 398** commits (byte-equal to the re-benchmark's recorded 398); chat 608/612/612 (the re-benchmark's exact family); note 971/989/971 vs recorded 989×3 — one exact match, the −18 variant twice (§5) |
| 7 | lease.lost = 0; {1:N} = {1:N}; flickers reported | **PASS** | `lease.lost` **0 in 7/7** ON runs; consequence multiplicity **{1:16}** in all three lunch ON stores; flickers: chat **0** (all browsers, both reps), lunch host **1 / 1 / 0** — a NONZERO reading is real flicker evidence and a floor (the F4 instrument-bias note: the counter UNDER-counts the common coalesced-purged shape and over-counts the equality cutoff — read nonzero as real, zero as not proof); ms-class, which the owner pre-judged acceptable for first launch |

**Journey verdicts (README §1 vocabulary):** chat cross-user — the
design's bars MET; vs OFF the arrival runs ~2× (421–520 vs 217–253 ms
median), i.e. no longer SLOWER-by-40× but not PARITY; the flip bar is the
owner's (OW38 (ii)). Lunch — 3/3 GREEN at 3.8–4.3 s totals (OFF 3.0–3.1 s);
every cross-user landing sub-second; the historically bimodal journey held.
Note — **FASTER** than OFF at p50 createToView and FLAT. The one failed
bar (#3) is the sender-side render, attributed to the client (e) term the
arc has already scoped (W2's own domain), with all absolute values below
half a second.

## 1. Binaries, posture, runs, load

**Binaries** (two `deno task --no-lock build-binaries toolshed` builds from
`44bb76b055a33f5d977e382734074f9aeb09903c`, `dist/toolshed` moved aside
after each; both 353 335 410 bytes):

| binary | built with | sha256 (first 16) | probe: `/api/meta` | `/api/health/stats` | toolshed log |
|---|---|---|---|---|---|
| `toolshed-off` | flag UNSET (`env -u EXPERIMENTAL_SERVER_EXECUTION`) | `e5971fc9dff189f8` | gitSha `44bb76b05…`, define `null` | no `servingLoop` key | no serving-loop line; `No default model available` |
| `toolshed-on` | `EXPERIMENTAL_SERVER_EXECUTION=true` | `6d0bef40e437ea8f` | gitSha `44bb76b05…`, define `"true"` | `servingLoop` present | `Server-execution v2: serving loop ON`; `No default model available` |

Both binaries posture-probed before any run (`w4bench/probe-{off,on}/`),
then posture + gitSha + `No default model available` + `llm_env_check`
(0 `CFTS_AI_LLM_*_API_KEY` in env; `packages/toolshed/.env` absent) read
and recorded **per run** (each `driver.log` + `meta.json` +
`stats-pre.json`). The test process carried the same posture as the server
per arm. Fresh cwd = fresh store per run; `PORT`/`API_URL`/`MEMORY_URL`
all on one port per run; ports 8960 (OFF₁), 8961 (ON), 8962 (OFF₂/₃);
stray-check before every boot (nothing foreign ever touched them); the
load gate (`wait-load.sh 5 15`) applied before every triplet and extra ON
rep — it never waited more than one poll (the box sat at 1-min load
1.4–4.8 all session); loads recorded before/after every run plus a 10-s
sampler. No latency below is quoted above 1-min load 5.

**Run ledger** (all runs gitSha `44bb76b05…`, all `No default model
available`; ✓ = test green; wall = the deno test wall):

| run | workload | arm | port | start (UTC) | load before → after | wall | result |
|---|---|---|---|---|---|---|---|
| smoke0-chat | chat n=3 @0.5 s | OFF (instrument smoke) | 8960 | 08:03 | 3.83 → 3.55 | 19 s | ✓ (not a ledger series; n=3) |
| smoke0-lunch | lunch | OFF (instrument smoke) | 8960 | 08:05 | 2.85 → 2.63 | 16 s | ✓ |
| c1a | chat n=20 @2 s | OFF₁ | 8960 | 08:14:39 | 4.04/3.29/3.12 → 4.76/3.61/3.25 | 55 s | ✓ series |
| c1 | chat n=20 @2 s | ON | 8961 | 08:15:56 | 4.81/3.68/3.28 → 4.29/3.80/3.36 | 68 s | ✓ series COMPLETE |
| c1b | chat n=20 @2 s | OFF₂ | 8962 | 08:18:15 | 3.68/3.87/3.42 → 4.29/4.04/3.52 | 56 s | ✓ series |
| l1a | lunch | OFF₁ | 8960 | 08:19:35 | 3.71/3.92/3.49 → 3.27/3.81/3.45 | 12 s | ✓ |
| l1 | lunch | ON | 8961 | 08:20:03 | 2.93/3.72/3.42 → 4.40/3.99/3.53 | 12 s | ✓ GREEN |
| l1b | lunch | OFF₂ | 8962 | 08:20:31 | 3.93/3.93/3.52 → 3.52/3.83/3.50 | 12 s | ✓ |
| l2 | lunch | ON rep 2 | 8961 | 08:21:19 | 3.03/3.71/3.46 → 2.59/3.57/3.41 | 14 s | ✓ GREEN |
| l3 | lunch | ON rep 3 | 8961 | 08:21:52 | 2.27/3.47/3.38 → 2.70/3.48/3.39 | 12 s | ✓ GREEN |
| n1a | note n=20 | OFF₁ | 8960 | 08:22:38 | 2.63/3.43/3.37 → 4.57(≈) | 81 s | ✓ 2/2 steps |
| n1 | note n=20 | ON | 8961 | 08:24:24 | 2.68/3.24/3.30 → 3.77/3.45/3.37 | 89 s | series n=20 COMPLETE; rc=1 — both steps failed the browser-console gate on the PRE-EXISTING `splitDefinitions` error (§6.2) |
| n1b | note n=20 | OFF₂ | 8962 | 08:26:20 | 2.70/3.18/3.27 → 3.64/3.47/3.38 | 93 s | ✓ 2/2 steps |
| c2 | chat n=20 @2 s | ON rep 2 | 8961 | 08:29:41 | 4.61/3.72/3.48 → 2.81/3.36/3.36 | 59 s | ✓ series COMPLETE |
| c2b | chat n=20 @2 s | OFF₃ | 8962 | 08:31:00 | 2.65/3.29/3.33 → 3.14/3.35/3.35 | 54 s | ✓ series |
| n2 | note n=20 | ON rep 2 | 8961 | 08:32:14 | 2.73/3.25/3.31 → 4.78/4.07/3.64 | 93 s | series n=20 COMPLETE; rc=1 — same pre-existing console-gate shape |
| n2b | note n=20 | OFF₃ | 8962 | 08:34:30 | 3.88/3.91/3.59 → 3.32/3.68/3.53 | 79 s | ✓ 2/2 steps |
| l2b | lunch | OFF₃ (trailing) | 8962 | 08:36 | 2.59/3.48/3.46 → 2.95/3.51/3.47 | 12 s | ✓ |
| n3p | note n=20 | ON, INSTRUMENTED (profile knob) | 8961 | 08:41 | 1.38/2.44/2.99 → 3.30/2.88/3.10 | 95 s | series complete; rc=1 same gate shape; labeled — excluded from the primary series |
| n3pb | note n=20 | OFF, INSTRUMENTED | 8962 | 08:43 | 2.87/2.80/3.07 → 3.71/3.07/3.14 | 80 s | ✓; labeled — excluded from the primary series |

Zero orphaned headless shells after any run; port verified free after
every teardown. The ON run walls themselves collapsed vs the
re-benchmark: chat 59–68 s (was 251–272), note 89–95 s (was 214–237).

## 2. Step 0 — the sender-echo instrument (W2 flag 3; the one build item)

Commit `44bb76b05` (`test(patterns): W4 sender-echo instrument`):
`installSenderEchoProbe` / `armSenderEcho` / `readSenderEchoReport` /
`logSenderEchoSummary` in
`packages/patterns/integration/cfc-browser-helpers.ts`, wired into the
chat series leg (per post, inside the opt-in `CF_CHAT_MESSAGE_SERIES`
block) and the lunch journey (opt-in `CF_SENDER_ECHO=1`; host-join,
guest-join, host-add-option, guest-veto). Definition: **both timestamps on
the same page's `performance.now()` clock** — the click at a
capture-phase trusted-click listener when the browser dispatches the CDP
click in the page; the render inside a MutationObserver callback (document
+ every open shadow root, present and future via a private
`attachShadow` chain-wrap) when the armed text first appears in the armed
selector's deep text. No CDP round trip is inside the measured window.
"Render" is DOM arrival — the same definition the arrival series uses —
so the two columns are directly comparable. Pre-armed / unclicked /
unrendered expectations are recorded, never silently dropped (all runs:
`abandoned=0`). The ordinary gate runs are unchanged (chat: the probe
lives inside the series leg; lunch: behind the env knob). Self-test in
`cfc-browser-helpers.test.ts` (the after-install shadow root, the echo
band, the abandonment bookkeeping). Suites at the commit: runner halves
**523 (4 052) + 693 (2 704) = 1 216 passed / 0 failed**; the touched
patterns file `cfc-browser-helpers.test.ts` 1 passed (37 steps);
`deno fmt --check` / `deno lint` / `deno check --no-lock` clean on all
four touched files. No production hook was needed.

## 2a. Workload (a) — chat two-browsers n=20 @2 s

**Arrival (send-click → the other browser renders; the existing series):**

| run | arm | n | median | q1 / q3 | min / max | load in test |
|---|---|---|---|---|---|---|
| c1a | OFF₁ | 20 | **217** | 182 / 286 | 149 / 429 | 4.8/3.6/3.3 |
| c1b | OFF₂ | 20 | **253** | 192 / 286 | 150 / 403 | 4.3/4.0/3.5 |
| c2b | OFF₃ | 20 | **223** | 193 / 247 | 165 / 366 | 3.1/3.4/3.4 |
| c1 | ON | 20 | **520** | 471 / 557 | 423 / 779 | 4.3/3.8/3.4 |
| c2 | ON rep 2 | 20 | **421** | 307 / 472 | 237 / 584 | 2.8/3.4/3.4 |

Raw per-post (ms, in order):
- c1a OFF₁: `191 157 149 149 154 177 182 184 195 217 243 202 242 429 242 257 418 286 404 325`
- c1b OFF₂: `205 279 150 175 183 178 170 192 310 227 267 199 208 323 286 403 257 253 270 366`
- c2b OFF₃: `313 179 198 165 172 172 188 198 193 202 223 221 226 247 247 285 366 357 230 231`
- c1 ON: `501 423 426 423 466 471 438 520 483 530 557 520 595 690 779 608 478 552 555 550`
- c2 ON: `334 237 258 255 269 262 307 365 344 388 432 426 421 439 455 476 472 524 516 584`

Baselines beside these: trio tip ON p50 7 397–9 734 ms; the fix-round
smokes 375 ms (load ~3) and 544 ms (load ~4.3) — both W4 reps sit in that
quiet band, at n=20 with brackets. The ON per-post cost still climbs
mildly across the series (first five 420–500 / 240–330, last five
480–780 / 470–580) — the client (e) slope shape, now bounded at ~1.4×
over 20 posts instead of the trio tip's 3×-to-14 s.

**Server settle (admission → W covering it; `servingLoop.settle`; the
acceptance metric):**

| run | n | value-only p50 / p95 / max (n) | growth n; TO LANDING p50 / p95 / max; (coverage p50); grace p50 / p95 | event-append p50 / p95 (n) | ALL-INPUTS coverage p50 / p95 / max | waves/input (vo) | landing waves (growth) |
|---|---|---|---|---|---|---|---|
| c1 ON | 64 | **19** / 348 / 420 (39) | 25; **487** / 992 / 1 156; (14); 280 / 505 | 15 / 348 (28) | **18** / 229 / 420 | 1.21 | 4.7 |
| c2 ON | 64 | **16** / 295 / 646 (38) | 26; **314** / 508 / 511; (11); 135 / 256 | 11 / 295 (28) | **15** / 214 / 646 | 1.16 | 3.7 |

`settleAdvances` (S1 quiescence, split, never in the per-input series):
53 / 54 per run, lastDelta ≤ 2. Waves 191 / 168; `wavesBudgetExhausted`
**79 / 33** (0.41 / 0.20 cut cycles per wave — the re-benchmark's honest
count was 777 / 739 ≈ 5.9 per wave; the deadline now almost never cuts).
The T2′/T3′ settle-cycle count: mean cycles per input 1.12 / 1.11.

**Sender echo (the new instrument; click → the sender's OWN render):**

| run | arm | n | p50 | p95 | min / max |
|---|---|---|---|---|---|
| c1a | OFF₁ | 20 | 108.4 | 156.3 | 68.2 / 156.3 |
| c1b | OFF₂ | 20 | 113.5 | 141.0 | 62.9 / 141.0 |
| c2b | OFF₃ | 20 | 109.1 | 173.5 | 75.1 / 173.5 |
| c1 | ON | 20 | **264.4** | 448.3 | 167.5 / 448.3 |
| c2 | ON | 20 | **165.8** | 214.0 | 100.4 / 214.0 |

Per-event series in `w4-raw/sender-echo-series.txt`. Reading: there is no
1–3 ms echo class in EITHER arm under the DOM-render definition — the
sender's own render is client-pipeline-bound in both arms (OFF ~70→156 ms
across the series, ON ~170→450 / ~100→214). ON runs 1.5–2.4× OFF at p50
and grows slightly faster across the series. Attribution: not the server
(settle p50 15–19 ms, and the echo is ~half the cross-browser arrival in
BOTH arms — the same pipeline shape); the ON delta tracks the client (e)
intent-tracking cost (Alice `actionRuns` 2 818 / 2 725 vs OFF ~944–969;
`commitConflicts` 0/0 ON vs up to 229 OFF). This is bar #3's FAIL as
worded: not ms-class, not ≈ OFF — reported with the number; the absolute
class is sub-half-second.

**Cross-user gate steps (StepTimer, ms; ON now OFF-class):**

| step | OFF c1a / c1b / c2b | ON c1 / c2 | trio-tip ON |
|---|---|---|---|
| Alice save + own status | 222 / 448 / 264 | 343 / 239 | 873–2 344 |
| Bob sees Alice before save | 2 / 2 / 2 | 207 / 178 | 3–1 732 |
| cross-browser name propagation | 5 / 8 / 5 | 136 / 161 | 1 165–2 278 |
| message propagation (first → all) | 20 / 6 / 14 | **5 / 5** | 2 632–3 018 |
| lockdown propagation | 3 / 28 / 14 | **4 / 3** | 3 262–4 094 |
| post-lockdown message | 3 / 4 / 3 | 5 / 97 | 2 521–2 892 |
| room propagation (first → all) | 3 / 3 / 2 | **12 / 537** | 9 463–10 160 |

Browser churn: ON `overlayArrivalSweeps` 90/60 (c1 Alice/Bob), 70/40
(c2); `overlayLateEchoDrops` 1 per ON run (Alice; the late-echo rule now
fires occasionally — 0 at the re-benchmark); `overlayCascadeEchoFlickers`
**0** on every browser in both reps; `eventLostRaces` 0.

## 2b. Workload (b) — lunch two-user vote (3 ON reps; the historically bimodal journey)

| step (ms) | OFF l1a / l1b / l2b | ON l1 / l2 / l3 |
|---|---|---|
| navigate + login both | 912 / 898 / 931 | 1 387 / 1 385 / 1 536 |
| both join lands (confirmed roster, both) | 9 / 9 / 8 | **254 / 254 / 254** |
| option A propagates to both | 9 / 9 / 8 | 368 / 448 / 585 |
| both cast green concurrently | 434 / 498 / 414 | 95 / 105 / 125 |
| both browsers see 2 love it (merge) | 39 / 56 / 8 | **396 / 331 / 305** |
| both voters' swatches visible on both | 1 / 1 / 1 | **1 / 1 / 1** |
| option B vote lands (3 votes) | 417 / 326 / 270 | 139 / 164 / 210 |
| total | 2 998 / 3 080 / 3 118 | 3 815 / 3 987 / 4 268 |

**3/3 GREEN**, every swatch wall 1 ms, joins honest at the 255 ms class
(the fix-round band exactly; the trio tip's merges were 3.7–6.3 s).
Server settle: value-only p50 **16 / 19 / 20 ms** (n=20/19/22); growth
to landing p50 **258 / 379 / 520 ms** (n=9/8/5; p95 1 379 / 1 927 /
1 607 — 1–2 rows each, the grace-tail class); all-inputs coverage p50
**17 / 20 / 17 ms** (p95 340 / 273 / 385); event-append p50 64 / 64 / 37;
grace p50 96 / 105 / 131. `settleAdvances` 12 / 13 / 10.

Events: appended/processed **11/12, 11/12, 11/11** with
`lt1LeftoversPurged` 1, 1, 0 and `drainInFlightSkips` 0 — the (α)
exactly-once machinery visibly at work (the re-benchmark's pre-(α) runs
sat at 11/17); consequence multiplicity **{1:16} in all three stores**
(verified with `inspect-store.py` per run); zero MULTI rows. Flickers:
host **1 / 1 / 0**, guest 0 / 0 / 0 — nonzero = real flicker evidence
(F4: a floor, not an exact count — the coalesced-purged shape is
under-counted); ms-class, the owner's pre-judged-acceptable class.
`outbox` completed 2/2 (l1), 3/3 (l2), the `#now` effects done by the
post-read (the re-benchmark's were still in flight).

**Sender echo per step (ms; ON l1/l2/l3 vs OFF l1a/l1b/l2b):**

| echo | OFF | ON |
|---|---|---|
| host-join ("1 joined" on the clicking browser) | 210 / 157 / 203 | 196 / 163 / **83** |
| host-add-option-A (card text) | 63 / 68 / 60 | 83 / 76 / 74 |
| guest-join ("2 joined" — the speculative join) | 69 / 78 / 88 | **41 / 63 / 52** |
| guest-veto-B ("3 votes") | 21 / 20 / 25 | 159 / 42 / 181 |

The join echoes run AT or BELOW OFF under ON (the speculation earning its
keep); the veto echo regressed 2–8× in 2 of 3 runs (max 181 ms). The
concurrent-green step carries no echo sample by design — two senders
share one expectation text, so a render there is not attributable to the
observing page's own click (stated in the harness comment too).

## 2c. Workload (c) — note-create n=20 single-user

| run | arm | n | createToView p50 / p95 / min / max | first-10 med → last-10 med | total p50 / p95 |
|---|---|---|---|---|---|
| n1a | OFF₁ | 20 | **1 193** / 1 435 / 199 / 1 435 | 376 → 1 227 | 3 087 / 7 154 |
| n1b | OFF₂ | 20 | **1 100** / 1 732 / 347 / 1 732 | 495 → 1 253 | 3 731 / 8 853 |
| n2b | OFF₃ | 20 | **1 178** / 1 271 / 279 / 1 271 | 423 → 1 204 | 3 748 / 7 777 |
| n1 | ON | 20 | **991** / 2 097 / 310 / 2 097 | 797 → 1 194 | 2 623 / 8 577 |
| n2 | ON rep 2 | 20 | **829** / 1 806 / 388 / 1 806 | 779 → 1 174 | 2 869 / 9 004 |

Raw createToView (ms, notes 1..20):
- n1a OFF₁: `456 356 321 376 324 300 199 1246 1256 1199 1210 1193 1236 1245 1075 1091 1435 1190 1238 1227`
- n1b OFF₂: `546 385 419 406 493 780 520 495 913 347 1107 1253 1584 1225 1100 1732 1219 1280 1359 1208`
- n2b OFF₃: `425 354 326 304 388 423 279 1196 1178 1205 1185 1271 1190 1092 1119 1208 1235 1072 1235 1204`
- n1 ON: `783 625 735 802 820 1119 398 991 625 797 310 1076 723 1178 1194 1060 2097 1383 1231 1544`
- n2 ON: `694 570 763 829 688 1045 779 850 1043 653 718 688 689 1105 1465 1212 1174 1206 1806 388`

**The slope is the signal, and it is FLAT**: ON starts higher (~700–800 ms
vs OFF's ~300–500 pre-list-step) and ends at the SAME plateau
(last-10 medians 1 174–1 194 vs OFF's 1 204–1 253) — ON's p50 is BELOW
OFF's. The monotone 1 → 13 s mutation witness (re-benchmark ON:
`1010 … 6606`, max 13 689) is gone. C's Q5 prediction confirmed at
acceptance. Totals p50 ON 2 623–2 869 vs OFF 3 087–3 748 — ON FASTER.

**Per-note client `scheduler/run`** (the labeled instrumented pair n3p/n3pb,
`CF_CAPTURE_NOTE_CREATE_PROFILE_SERIES=20`; per-note deltas of the
cumulative totals, ms):
- ON n3p: `147 103 119 81 95 96 72 118 110 87 64 63 64 101 64 65 129 121 134 108` (run counts 59–104/note) — FLAT.
- OFF n3pb: `168 84 82 85 90 79 87 47 89 82 40 93 112 78 77 84 79 84 101 94` (counts 29–89/note) — FLAT.
The client `scheduler/execute` per-note deltas spike at the list-size
steps in both arms (ON 1.9–3.0 s at notes 8–9/12–13; OFF 2.3 s at note
16) and are otherwise 150–500 ms — no O(history) growth either.

Server settle: value-only p50 **21 / 17 ms** (n=105/101); growth to
landing p50 **454 / 438 ms** (n=30/35); all-inputs p50 **28 / 22 ms**
(p95 927 / 757); event-append p50 23 / 17 (n=98/99). `settleAdvances`
70 / 69. Sink counters: `undemandedNarrowingRuns` **57 / 53** (trio tip
47–48, W0 47–55 — the flag-5 shape, unchanged); `earlyEmitRefusals` 0;
events appended/processed 98/100 and 99/100 with `drainInFlightSkips`
3 / 2, purges/refusals/orphans 0.

## 3. The §7 (d′) counter block — witnesses and consistency

Per ON run (`w4-raw/<run>.demand-block.json`): `demandedRows` 1 988 (chat)
/ 555-class (lunch) / note per-block; `demandedInstances` 849/849 max
(chat); `demandedWriters` 223/223 (chat — byte-equal to W0's closure
measurement); `demandRootEnters` 223 / `demandRootLeaves` 0;
`notCurrentRearms` 97/34 (chat), 81–166 (lunch), 28–29 (note);
`demandPasses` 376–595; `demandPassMs` **4.8–11.3 ms/pass** (11.3 was
c1, the rep that started at load 4.8; the quiet reps sit 4.8–7.7 — the
O(rows) reconcile class, no per-row-engine-read signature);
`pushGrowthWakes` vs `watchWakes` 175/250 & 131/247 (chat), 40–43/140–141
(lunch), 97–99/287–298 (note); `demandArrivals` 41/54 (chat), 20–21
(lunch), 0 (note). **No `walkRuns` key exists anywhere in any run's
stats** (asserted per run over the full JSON; the fallback block's
counters are absent wholesale). `settleAdvances` is a separate block with
its own bounded series (10–71 rows; `dropped` 0) — quiescence advances
never enter the per-input settle series; the busy path pays nothing
(chat c2: 33 cut cycles over 168 waves).

## 4. OW37 re-read (the §4 amplification ratio; never silenced)

`derivedCommits / (authoredSeen − effectAcks)`, raw and with the S1
advance-only waves subtracted (the subtraction the `settleAdvances` split
exists for — an advance mints one derived commit per quiescence
transition with NO authored input):

| run | raw | minus advances | budget | store commits ON (authored+derived) | OFF |
|---|---|---|---|---|---|
| chat c1 | 191/64 = **2.98** | 138/64 = **2.16** | ≤2 pure | 255 (64+191) | 608 / 612 / 612 |
| chat c2 | 168/64 = **2.62** | 114/64 = **1.78** | ≤2 | 232 | |
| lunch l1 | 57/29 = **1.97** | **1.55** | ≤2 | 86 | 398 ×3 |
| lunch l2 | 57/27 = **2.11** | **1.63** | ≤2 | 84 | |
| lunch l3 | 57/27 = **2.11** | **1.74** | ≤2 | 84 | |
| note n1 | 323/114 = **2.83** | **2.22** | ≤3 effectful (effectAcks 21) | 458 | 971 / 989 / 971 |
| note n2 | 316/115 = **2.75** | **2.15** | ≤3 | 452 | |

The register row's assertion re-read on the new numbers: **the bound
holds on the advance-subtracted reading** — lunch 1.55–1.74 and chat c2
1.78 under the ≤2 pure line, note 2.15–2.22 well under ≤3 effectful;
chat c1 (the high-load rep) reads 2.16, a hair over, raw 2.62–2.98. The
raw reading now includes the DESIGNED quiescence advances (S1), so the
subtraction is the like-for-like successor of the re-benchmark's 2.05–3.20
raw values; total ON store commits remain 2.1–4.7× BELOW OFF. The wave
count per authored input fell exactly as the row predicted
(`wavesBudgetExhausted` 79/33 vs 777/739; waves/input value-only
1.11–1.45 vs the multi-cycle cuts before). Not silenced; stated.

## 5. The OFF byte-identity witness

- **OFF suites at this tip**: the full runner population re-run here
  (OFF ambient): half A 523 passed (4 052 steps) + half B 693 passed
  (2 704 steps) = **1 216 / 6 756 / 0 failed** — the same counts as the
  fix round's ledger. The executor OFF witnesses are inside that
  population. (The fix round's runner OFF half is thereby superseded by a
  fresh run, not just cited.)
- **`/api/health/stats` has NO `servingLoop` key OFF** — verified pre and
  post on every OFF run (`servingLoop_present_pre=False`;
  `servingLoop_post= None`).
- **Store commit tables by class** (every OFF run authored-only, zero
  `derived` rows): lunch **394+2+2 = 398** in all three OFF runs —
  byte-equal to each other and to the re-benchmark's recorded 398. Chat
  **608 / 612 / 612** — the re-benchmark's exact family (608/612/612).
  Note **971 / 989 / 971** vs the re-benchmark's 989×3: n1b is
  byte-equal to the recorded shape; n1a and n2b sit 18 commits lower in
  the main space (783 vs 801, identical 186+1+1 elsewhere, same class
  table) — a bimodal run-to-run variance of the note workload of the same
  kind the chat family already shows (±4), not a systematic shift (the
  recorded value is reproduced, and the variant repeats exactly). The
  instrumented n3pb (765) is excluded from the witness by its label (the
  profile knob adds reads that change the flow).

## 6. Deviations from the protocol (verbatim)

1. **The client-observed settle** (append ack → the watermark doc's
   arrival at the appending client) has no harness instrument at this
   tip; per W0 §2(c)'s precedent the send-click → other-browser arrival
   series is reported beside the server settle as the client-observed
   bound (it bounds settle + push + apply), and the NEW sender-echo
   instrument bounds the sender-side render from below. Building a
   watermark-doc client subscription into the harness was out of W4's
   measurement-only scope.
2. **Both note ON reps returned rc=1 on the browser-console gate**, both
   steps, on the byte-identical PRE-EXISTING error the re-benchmark
   already recorded on its n2 at the trio tip `b54bf5215` (before this
   train): `TypeError: Cannot read properties of undefined (reading
   'split')` at `splitDefinitions
   (…/api/patterns/notes/reference-block.ts:62:21)` via `note.tsx` lift
   (17 and 6 occurrences). Attribution ritual applied: exact assert
   extracted; the accused diff (this tip's harness-only instrument
   commit) cannot reach the notes pattern's worker code; the shape is
   reproduced at a pre-train base by the re-benchmark's own ledger.
   Attributed pre-existing; NOT chased. The n=20 timing series completed
   before the gate fired in all three affected runs (n1, n2, n3p) and is
   valid data.
3. **The lunch concurrent-green step carries no sender-echo sample** —
   two senders share one expectation text, so a render is not
   attributable to the observing page's own click. Stated here and in
   the harness comment.
4. **Per-note client `scheduler/run`** came from ONE labeled instrumented
   pair (n3p/n3pb, `CF_CAPTURE_NOTE_CREATE_PROFILE_SERIES=20`) run AFTER
   the primary triplets, because the profile capture adds per-note reads
   (the W0 flag-4 lesson); the primary series stayed un-instrumented, per
   the benchmark/re-benchmark precedent (neither enabled the knob).
5. **Hard cap 520 s per test** (the re-benchmark's cap) — never hit; the
   longest run was 95 s.
6. **Registered flakes**: neither fired. The effect-channel receipt-race
   pin and the "served intent (T2 hops 1–4)" timeout (~1/8, registered at
   the fix round) had their file (`executor-effect-channel.test.ts`, in
   runner half A) pass green on the one W4 run of that half; no
   equivalence-hook lane was run here (not in W4's suite scope — the fix
   round ran it at this tip's code).
7. **Two instrument smokes** (chat n=3, lunch) ran before the ledger
   triplets on port 8960 with fresh stores, recorded above, so an
   instrument bug could not burn a bracketed triplet. Their numbers are
   not series data.

## 7. Files and pointers

- Report (this file):
  `docs/history/plans/server-execution-v2/stage-c/w4-acceptance-report.md`;
  durable copy `/Users/berni/labs-worktrees/w4-acceptance-report.md`.
- Raw: [`w4-raw/`](w4-raw/) — per-ON-run `settle-series.json` /
  `settle-advances.json` / `demand-block.json` (8 runs incl. n3p),
  `sender-echo-series.txt`, `run-ledger.txt`.
- Instrument commit: `44bb76b05` (4 files, patterns integration only).
- Plan delta: the W4 rows in the Phase-7 gates table + the coordination
  block's ordered next actions flipped to W4 DONE
  (`docs/plans/server-execution-v2.md`); register: OW38 (i) recorded
  LANDED with this benchmark, (ii) the flip bar stays the owner's
  (`docs/specs/server-side-execution/verification-coverage.md`).
- The confidence verdict is NOT in this report — it is the coordinator's,
  assembled from this acceptance readout.
