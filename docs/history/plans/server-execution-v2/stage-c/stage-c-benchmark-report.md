---
status: historical
created: 2026-08-17
archived: 2026-08-18
reason: "Stage-C evidence: the first honest ON-vs-OFF propagation benchmark of server-execution v2 at the fan-out B tip (59b5329ae) — ON could not complete the two-user journeys; measure-and-report only."
---

# Stage C — honest ON-vs-OFF propagation benchmark (server-execution v2)

Date: 2026-08-17 (runs 18:36–20:00 PDT = 01:36–03:00 UTC on 2026-08-18).
Branch `claude/server-exec-v2-fanout-b` at **`59b5329ae`** — worktree
`/Users/berni/labs-worktrees/bench-c`, detached from
`origin/claude/server-exec-v2-fanout-b` (after `f5a0cac5c`, the fan-out B tip;
the only commits on top are the deno.yml YAML fix `a2954dec5` + its validator
test — runtime code is byte-identical to `33dcab8e2`, verified with
`git diff --name-only 33dcab8e2..59b5329ae`: only two test files).
Measure-and-report only: no repo file changed, nothing pushed, no comment
posted. All raw artifacts (driver logs, test logs, toolshed logs, pre/post
`/api/health/stats`, per-run sqlite stores) live under the session scratchpad
`…/scratchpad/benchc/runs/<run>-<workload>-<arm>/`; the measurement scripts
(`run-arm.sh`, `wait-load.sh`, `extract.py`) live beside them and never
touched the repo. Machine-readable per-run extraction (series, steps,
counters, store commit counts by class):
`/Users/berni/labs-worktrees/stage-c-benchmark-results.json` and the one-line
table `/Users/berni/labs-worktrees/stage-c-benchmark-results-table.md`.

## 1. Verdict (README §1: "faster, not tolerably slower")

**SLOWER, with attribution — and on the primary cross-user workload the ON
arm cannot complete the byte-identical journey at all, so no ON
send→other-browser number exists at this tip.**

- **Cross-user propagation (workload a, the two-browsers chat series):**
  OFF produced n=20 series three times (median 227 / 328 / 477 ms at 1-min
  loads 3 / 4–6 / 6–9). ON produced **0 series in 3 tip attempts** (loads
  10→18, 5.7→6.2, 3.9→2.9) **and 0 in 1 attempt at `fadc2efb1b`** (the
  commit fan-out B's "3/3 green" evidence was taken on): the journey stalls
  before the series leg every time. The per-step timings the same StepTimer
  recorded before each stall put ON's cross-user steps at **3.0–7.2 s vs OFF's
  4–47 ms** ("message propagation (first → all)": ON 3026 / 7045 ms vs OFF
  4 / 28 / 42 ms; "cross-browser name propagation (all pairs)": ON 4521 /
  7211 ms vs OFF 5 / 6 / 15 ms).
- **Two-user lunch poll (workload b):** OFF green 2/2 (11 s, 16 s); ON RED
  1/1 at "both browsers see 2 love it (merge)" (300 s) — the F4 served-vote
  no-op residual named in the skip list — after "option A propagates to both"
  **7873 ms ON vs 53 / 80 ms OFF** and "both cast green concurrently"
  **22 943 ms ON vs 440 / 843 ms OFF**. Phase 3's "≤300 ms p50 measured on
  lunch-poll-vote UNMODIFIED" is missed by ~2 orders of magnitude on the
  one ON run that reached the step.
- **Actor-side interactive latency (workload c, note-create n=20):** the ONE
  workload where ON completed a full n=20 series. **createToView p50: ON
  8927 ms (rep 1, n=20) / 5841 ms (rep 2, n=17 — hit the 780 s hard cap on
  note 18) vs OFF 1085 / 1171 / 1090 ms (three reps, an 8 % band) — 5.4–8.2×;
  p95 23 335 / 26 451 vs 1328–1496 ms (~16–20×).** ON's per-note cost climbs
  monotonically 1.6 s → 24.9 s (rep 1) and 1.5 s → 26.5 s (rep 2) over the
  series; OFF is flat at 1.1–1.5 s from note 8–10 on. Not at parity.

**Drift-control noise band.** OFF₁ vs OFF₂ (adjacent, bracketing the ON run)
differ by **1.45× on the chat series (328 → 477 ms, load rising 4→9)** and by
**8 % on note createToView p50 (1085 / 1171 / 1090 ms over three reps) and
14 % on note total p50 (3503 / 3998 / 4027 ms)**;
the quietest OFF chat run (load 2.9) came in at 227 ms. So the box's OFF band
spans 227–477 ms across loads 3–9 for chat, ~10 % for note. **Every ON gap
above is 5×–1000× — far outside that band — and the ON arm's failure to
complete the chat and lunch journeys is a set relation, not a latency, so it
is load-insensitive by the v1 rules and reproduced at 1-min load 3.9.**

Verdict vocabulary: **SLOWER (attributed, §3)** where ON produced a number;
**UNMEASURABLE (harness red under ON at this tip)** for the headline
send→other-browser series. Not INCONCLUSIVE: the OFF baseline and drift
control are clean and the ON failures reproduce at quiet load.

## 2. Binaries, posture, runs, load

**Binaries** (two `deno task build-binaries toolshed` builds from `59b5329ae`,
`COMMIT_SHA=59b5329ae…`, `dist/toolshed` moved aside after each build; a
third from `fadc2efb1b` for the ablation):

| binary | built with | sha256 (first 16) | `/api/meta` | `/api/health/stats` |
|---|---|---|---|---|
| `toolshed-off` | flag UNSET (default) | `882b2a324b01bbc3` | `gitSha 59b5329ae…`, `shellServerExecutionDefine: null` | no `servingLoop` key |
| `toolshed-on` | `EXPERIMENTAL_SERVER_EXECUTION=true` | `028b0a0743498ebf` | `gitSha 59b5329ae…`, `shellServerExecutionDefine: "true"` | `servingLoop` present; log line `Server-execution v2: serving loop ON (service did:key:z6MksHnZ…)` |
| `toolshed-on-f5` (ablation) | `EXPERIMENTAL_SERVER_EXECUTION=true` at `fadc2efb1b` | `81bb8f9eeac43232` | `gitSha fadc2efb1b…`, define `"true"` | `servingLoop` present |

Posture was read from `/api/meta` + `/api/health/stats` **before every run**
(recorded in each `driver.log`/`meta.json`/`stats-pre.json`); every ON run
shows define `"true"` + `servingLoop`, every OFF run define `null` + no
`servingLoop`. The test process carried the same posture as the server
(`EXPERIMENTAL_SERVER_EXECUTION=true` set for ON, unset for OFF — the
`[chat-series] arm=` label and the PiecesController's declared posture both
read env-else-default).

**Per-run recipe** (fan-out B verify report §2 / CI ON-lane recipe): stray
check on the port (only my ports 8950–8953; nothing foreign touched) → 1-min
load recorded → **fresh cwd = fresh store** (`./cache/memory/` empty) → binary
booted `--background --log-file --port=P` with `PORT/API_URL/MEMORY_URL` all
on P → posture read → ONE test file run from `packages/patterns` with
`LOG_LEVEL=warn HEADLESS=1 API_URL=http://localhost:P SPACE_NAME=bench-<run>`
and `deno test -A --no-lock --v8-flags=--max-old-space-size=4096
--trace-leaks <file>` (the flags `tasks/integration.ts` uses for the patterns
lane), hard-capped with `gtimeout --kill-after=30 <600–900 s>` → post stats
read → load recorded → toolshed PID killed → port verified free → orphaned
headless shells (ppid 1, not present before the run) killed — none ever were →
store `commit` table counted by class.

**Run ledger** (1-min/5/15 load before → after; ✓ = test green):

| run | workload | arm | port | load before → after | test wall | result |
|---|---|---|---|---|---|---|
| smoke0 | chat n=3 @0.5 s | OFF | 8950 | 9.2/20.6/47.4 → 10.5/19.5/45.8 | 33 s | ✓ (pipeline check only — EXCLUDED from all numbers) |
| smoke0 | chat n=3 | ON | 8951 | 10.6/18.8/44.8 → 18.5/19.5/35.8 | 368 s | ✗ lockdown stall — the same failure as t1 (the journey never reached the series leg, so the differing series parameters are moot). Excluded from every latency number (load 10–18); it IS one of the "3 tip attempts, 0 completions" (smoke0, t1, t2), and the verdict rests on t1/t2 |
| t1a | chat n=20 @2 s | OFF₁ | 8950 | 4.03/14.3/28.5 → 6.05/13.1/27.0 | 61 s | ✓ series |
| t1 | chat n=20 @2 s | ON | 8951 | 5.73/12.9/26.9 → 6.23/8.25/20.0 | 340 s | ✗ lockdown stall (300 s), no series |
| t1b | chat n=20 @2 s | OFF₂ | 8952 | 6.21/8.21/19.9 → 9.27/8.71/19.2 | 66 s | ✓ series |
| abl-f5 | chat n=20 @2 s | ON @fadc2efb1b (full stack) | 8953 | 11.3/9.31/18.4 → (killed) | >540 s | ✗ still running at 8 m+ when my tool timeout killed it; no step timings; server log: lease-lost / wave-commit-rejected |
| n1a | note n=20 | OFF₁ | 8950 | 3.42/8.45/12.9 → 5.66/7.66/12.1 | 105 s | ✓ 2/2 steps |
| n1 | note n=20 | ON | 8951 | 5.45/7.59/12.0 → 7.36/6.47/9.26 | 502 s | series COMPLETED (n=20); step 1 then failed the afterEach browser-console gate (2× `[RuntimeClient Error] callback:error "Cannot read properties of undefined (reading 'split')" at splitDefinitions`); step 2 ✓ |
| n1b | note n=20 | OFF₂ | 8952 | 6.85/6.38/9.21 → 4.76/5.87/8.73 | 91 s | ✓ 2/2 steps |
| t2 | chat n=20 @2 s | ON (attempt 3) | 8951 | **3.90**/5.56/8.52 → 2.94/4.39/6.48 | 600 s (cap) | ✗ stalled from t≈0: piece-start commit `ConflictError`, `sync-load-failure`, 11× `lease-lost` + 11× `wave-commit-rejected` on the server; hard cap hit before the test's own 300 s failure |
| t2b | chat n=20 @2 s | OFF₃ | 8952 | 2.94/4.39/6.48 → 3.21/4.25/6.28 | 57 s | ✓ series |
| l1a | lunch | OFF₁ | 8950 | 2.95/4.17/6.25 → 3.97/4.31/6.23 | 23 s | ✓ |
| l1 | lunch | ON | 8951 | 3.97/4.31/6.23 → 3.53/3.91/5.37 | 363 s | ✗ "both browsers see 2 love it (merge)" 300 s |
| l1b | lunch | OFF₂ | 8952 | 3.41/3.88/5.35 → 3.27/3.84/5.31 | 12 s | ✓ |
| n2 | note n=20 | ON (rep 2) | 8951 | 3.27/3.77/5.24 → 3.84/3.33/4.18 | 780 s (cap) | 17/20 notes done when the hard cap hit (on note 18's "wait for note count"); per-note timings recovered from the log |
| n2b | note n=20 | OFF₃ | 8952 | 3.69/3.30/4.16 → 5.47/4.12/4.37 | 115 s | ✓ 2/2 steps |

The load gate (`wait-load.sh 5 15`: poll every 60 s, up to 15 min) was
applied before the first measured triplet (waited 01:52→01:56 UTC, load
33.5 → 4.24) and before the note triplet (load 6.2 → ≤5). Runs that started
above 5 are marked in the table (t1 ON 5.7, t1b OFF 6.2, n1 ON 5.5, n1b OFF
6.9): they are reported with their load; the verdict rests on the runs at
≤4 (t2/t2b, l1a/l1/l1b) and on set relations.

## 2a. Workload (a) — two-browsers chat, send-click → other browser renders

`CF_CHAT_MESSAGE_SERIES=20 CF_CHAT_MESSAGE_DELAY_MS=2000`. The series clock
starts BEFORE the send click and stops when browser 2's
`#trusted-conversation-preview` shows the text (MutationObserver + CDP
binding, no fixed poll), so it is actor dispatch + commit + propagation — an
upper bound on README §3.3's "intent-commit → observing client's derived
update", byte-identical across arms.

| run | arm | n | median (test) | p50 | p95 | q1 / q3 | min / max | mean | load in test (1/5/15) |
|---|---|---|---|---|---|---|---|---|---|
| t2b | OFF₃ | 20 | **227** | 227 | 498 | 212 / 275 | 167 / 498 | 257 | 3.21/4.25/6.28 |
| t1a | OFF₁ | 20 | 328 | 328 | 1069 | 295 / 482 | 162 / 1069 | 400 | 6.05/13.1/27.0 |
| t1b | OFF₂ | 20 | 477 | 477 | 921 | 373 / 645 | 288 / 921 | 504 | 8.60/8.57/19.2 |
| t1, t2, (smoke0) | ON | **0** | — | — | — | — | — | — | journey never reaches the series leg |
| abl-f5 | ON @fadc2efb1b | 0 | — | — | — | — | — | — | same |

Raw series (ms, in order):
- t2b OFF₃: `383 167 227 178 182 181 187 236 213 227 212 221 237 380 498 271 216 267 377 275`
- t1a OFF₁: `492 162 247 311 329 286 312 411 299 275 295 293 507 825 1069 312 328 395 482 373`
- t1b OFF₂: `559 373 354 288 441 371 365 381 300 381 645 477 461 683 921 584 698 572 702 526`

Per-step StepTimer (same code path in both arms; ms; the ON rows end where
the run stalled):

| step | OFF t2b (load 3) | OFF t1a | OFF t1b | ON t1 (load 5.7) | ON smoke0 (load 10–18) |
|---|---|---|---|---|---|
| navigate + login all profiles | 552 | 467 | 635 | 610 | 947 |
| initial "No profile" (all) | 1097 | 1101 | 1467 | 1242 | 2146 |
| Alice save + own status (actor-side) | 283 | 323 | 442 | **2182** | 5688 |
| Bob sees Alice before save | 2 | 3 | 4 | 2 | 5975 |
| Bob save + own status (actor-side) | 303 | 377 | 498 | **1717** | 3175 |
| cross-browser name propagation (all pairs) | 5 | 6 | 15 | **4521** | 7211 |
| message propagation (first → all) | 4 | 28 | 42 | **3026** | 7045 |
| lockdown propagation (first → others) | 3 | 4 | 4 | — stalled: Alice's own `#group-chat-manager-chip` stayed "Everyone is admin" for 300 s | same |
| post-lockdown message (non-admin → admin) | 24 | 21 | 26 | — | — |
| room propagation (first → all) | 3 | 3 | 4 | — | — |
| client action runs (Alice / Bob) | 957 / 1267 | 957 / 1301 | 948 / 1344 | 341 / 252 (partial) | 348 / 251 |
| client commitConflicts | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |

ON attempt 3 (t2, load 3.9) never printed step timings (hard cap 600 s hit
before the test's own 300 s wait expired): its test log shows a piece-start
`ConflictError` at t≈0 ("the started graph's setup writes did not land"), the
"has been running for over 1m/2m/4m/8m" markers, and one
`sync-load-failure`; its server log has 11× `lease-lost … lease renewal
failed; in-flight wave aborts` across all 3 active spaces and 11×
`wave-commit-rejected … producer does not hold the live execution_lease`.

## 2b. Workload (b) — lunch-poll two-user vote (currently ON-skip-listed)

| step (ms) | OFF l1a | OFF l1b | ON l1 |
|---|---|---|---|
| navigate + login both | 1339 | 931 | 1767 |
| both active space roots ready | 1232 | 894 | 1348 |
| both runtimes idle | 311 | 256 | 190 |
| host name filled / host joined | 62 / 39 | 48 / 27 | 23 / 35 |
| both join lands (count reaches 2) | 11 | 14 | **1652** |
| option A propagates to both | 80 | 53 | **7873** |
| both cast green concurrently | 843 | 440 | **22 943** |
| both browsers see 2 love it (merge) | 100 | 84 | **300 030 → FAILED** (Bob's browser stuck at "1 love it") |
| both voters' swatches visible on both | 1 | 1 | — |
| option B vote lands (3 votes) | 182 | 257 | — |
| total / result | 4200 ✓ | 3005 ✓ | 335 861 ✗ |

The ON failure is the F4 residual verbatim (one served `castVote` no-ops):
counters `events.appended 9 / processed 11`, `authoredSeen 25`,
`derivedCommits 43`, `waves 44` of which **40 budget-exhausted**,
`structureLoadTerminal 160 / Rearmed 25`, `demandArrivals 19`, `outbox 2/2`,
`lease held 3 / lost 0`, `push prioritizedSessions 17 / followerSessions 11 /
mixedFlushes 7`; one server `event-view-lag drain deferring` warning. The gate
is RED 0/1 here (skip list says BIMODAL 1/2 on the fixer binary) — reported,
not relied on, per protocol.

## 2c. Workload (c) — single-user note-create series (actor-side)

`CF_NOTE_CREATE_TIMING_SERIES=20` (no inter-create delay knob exists in this
tree — see deviations). Same test, same n, byte-identical.

| run | arm | n | createToView p50 | p95 | min / max | total p50 | p95 | returnToHome p50 | p95 | load in run |
|---|---|---|---|---|---|---|---|---|---|---|
| n1a | OFF₁ | 20 | **1085** | 1496 | 324 / 1511 | 3503 | 9798 | 2427 | 8636 | 3.4 → 5.7 |
| n1b | OFF₂ | 20 | **1171** | 1328 | 315 / 1686 | 3998 | 7726 | 2670 | 6542 | 6.9 → 4.8 |
| n2b | OFF₃ | 20 | **1090** | 1366 | 275 / 1448 | 4027 | 11 932 | 2821 | 10 703 | 3.7 → 5.5 |
| n1 | ON rep 1 | 20 | **8927** | 23 335 | 1592 / 24 915 | 12 645 | 50 077 | 3550 | 26 741 | 5.5 → 7.4 |
| n2 | ON rep 2 | 17 (capped) | **5841** | 26 451 | 1514 / 26 451 | 9521 (p50 of 17) | 57 333 | — | — | 3.3 → 3.8 |

Raw createToView (ms, notes 1..20):
- OFF n1a: `447 400 377 377 333 376 324 1186 1243 1211 1075 1496 1279 1325 1091 1118 1085 1018 1162 1511`
- OFF n1b: `762 450 498 395 557 511 315 343 1269 1328 1140 1244 1223 1285 1171 1247 1214 1259 1184 1686`
- OFF n2b: `615 509 556 593 646 428 346 275 276 1206 1118 1282 1300 1366 1090 1448 1144 1227 1229 1230`
- ON n1:  `1592 2305 3122 4210 5086 5542 5771 7329 11009 8927 6378 10374 15018 13761 15240 16688 19151 20973 23335 24915`
- ON n2 (17 of 20): `1514 2623 3448 4754 5841 6340 5691 5481 6656 4349 5388 7010 10450 13099 13038 15235 26451`

Raw total (create + return-to-home, ms):
- OFF n1a: `503 500 552 674 775 973 1174 2429 2876 3716 3503 5435 6383 7363 6299 6868 6869 7198 9798 10478`
- OFF n1b: `863 603 739 829 1218 1362 1605 2028 3218 3998 4120 4316 4550 4543 4769 5340 5800 7461 7726 9912`
- OFF n2b: `704 652 885 1172 1288 1231 1501 1858 2275 4027 4522 5548 6811 8409 9369 6935 5632 6281 11932 12185`
- ON n1:  `1649 2413 4584 6003 7717 9093 8355 9592 12645 10776 13715 21916 25091 28147 30449 21089 36272 44262 50077 87074`
- ON n2 (17 of 20): `1912 4078 3911 4991 6232 7306 7974 9521 11213 8249 10653 17132 25242 24992 27477 33571 57333`

The OFF series step at note 8–10 (0.3–0.6 s → 1.1–1.4 s) is present in all
three OFF runs (a list-size threshold in the space page); ON has no plateau —
its per-note cost keeps growing ~1.2–1.5 s per note in both reps, and rep 2
(the QUIETER run, load 3.3) was the slower one, so this is not load.

## 3. Counter attribution (why ON is slower / does not complete)

`servingLoop` block after each ON run (OFF has none by construction):

| counter | chat t1 (partial) | chat t2 (stalled) | chat smoke0 | lunch l1 | note n1 (completed series) |
|---|---|---|---|---|---|
| waves | 36 | 119 | 35 | 44 | 298 |
| **wavesBudgetExhausted** | **19 (53 %)** | **99 (83 %)** | 26 (74 %) | **40 (91 %)** | **169 (57 %)** |
| authoredSeen / effectAcks | 20 / 0 | 62 / 0 | 20 / 0 | 25 / 0 | 128 / 21 |
| derivedCommits | 36 | 108 (store: 109) | 35 | 43 | 297 |
| structureLoadTerminal / Rearmed / Deferred | 80 / 21 / 0 | **382 / 38 / 0** | 80 / 21 / 0 | 160 / 25 / 0 | 334 / 114 / 0 |
| undemandedNarrowingRuns | 0 | 0 | 0 | 0 | 57 |
| events appended / processed / coalescedPerWaveMax | 6 / 6 / 1 | 27 / 38 / 1 | 6 / 6 / 1 | 9 / 11 / 2 | 93 / 95 / 2 |
| memo hits / misses | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| outbox queued / completed / failed / budgetDeferrals | 0/0/0/0 | 0/0/0/0 | 0/0/0/0 | 2/2/0/0 | 0/0/0/0 |
| push prioritized / follower / mixedFlushes | 18 / 10 / 7 | 83 / 33 / 29 | 20 / 12 / 8 | 17 / 11 / 7 | 0 / 0 / 0 |
| lease held / lost | 3 / 0 | **3 / 33** (11 per space × 3 spaces; server log: 11× `lease-lost`, 11× `wave-commit-rejected`) | 3 / 0 | 3 / 0 | 4 / 0 |
| watermarkLag / demandArrivals | 3 / 17 | 4 / 57 | 2 / 15 | 1 / 19 | 3 / 0 |
| supersededWrites / reactivationBackoffs / parkDisposeTimeouts / earlyEmitRefusals | 0/0/0/0 | 0/0/0/0 | 0/0/0/0 | 0/0/0/0 | 0/0/0/0 |

What the counters say:

1. **Wave cadence is the bottleneck, and the waves are running long.** 53–91 %
   of waves exhaust the flush deadline (`DEFAULT_FLUSH_DEADLINE_MS = 100`,
   `packages/runner/src/executor/space-server.ts`), i.e. a wave routinely
   needs >100 ms of wall time on a fresh store with two users and one small
   piece. Every served consequence waits for a wave, so cross-user steps land
   in the 3–8 s range and the note-create actor path (which under ON waits
   for the served derivation instead of its own commit) in the 1.6–25 s
   range. Server-side `slow-traverse 110–179 ms` warnings on single docs
   (note ON) show individual traversals alone exceeding the whole wave budget.
2. **The per-note cost grows with the space:** `structureLoadTerminal` 80 →
   160 → 334 across chat → lunch → note and the monotonic 1.6 → 24.9 s
   createToView series say each new structure adds work to every subsequent
   wave (terminal loads re-armed 21 / 25 / 114 times), which is the shape of
   the "structureLoadDeferred spin" the protocol names, expressed here through
   the terminal/re-arm counters (Deferred stays 0).
3. **Lease loss under quiet load (t2, load 3.9; and abl-f5):** `lease.lost
   = 33` (11 per space × 3 active spaces: 11× `lease renewal failed;
   in-flight wave aborts` + 11× `wave-commit-rejected: producer does not
   hold the live execution_lease` (TTL 15 s, renew every
   5 s — `packages/memory/v2/execution-lease.ts`). Renewal failing while the
   1-min load is 3.9 means the serving process itself blocked ≥10 s (long
   waves / traversals), not the box. This is the OW29 "live churn residual"
   the F4 triage recorded as unreproduced on the fixer binary; it reproduces
   here 2/4 ON chat attempts.
4. **Two served handlers no-op (correctness, not latency):** the chat
   lockdown toggle (Alice's own chip stays "Everyone is admin"; the handler
   `commitTrustedAdminToggle` in `cfc-group-chat-demo/trusted.tsx` returns
   early when `prepareTrustedAdminToggle(currentUserAdminRole(myProfile,…),…)`
   is null — the same class as the lunch F4 residual, a served run reading a
   per-user value as empty; hypothesis for the owner, not triaged here) and
   the lunch second `castVote` (F4). `events.processed ≥ appended` in both,
   so the events were served — the served run wrote nothing.
5. **What is NOT the cause:** push priority IS engaged (prioritized 17–20,
   follower 10–12, mixedFlushes 7–8) — no "push not engaged" false parity;
   outbox and memo are idle (no effect-channel latency; the lunch `#now`
   effect completed 2/2); client commitConflicts are 0/0 in every run and
   client action runs are 250–350 per browser (no OW32 loop — fan-out B's
   fix holds); `supersededWrites`, `reactivationBackoffs`,
   `parkDisposeTimeouts`, `earlyEmitRefusals`, `foreign*Refusals` all 0.
6. **ON is not paying for amplification:** the note workload wrote 425
   commits under ON vs 971–989 under OFF (2.3× fewer) and still ran 8×
   slower — the cost is wave latency and served-run duration, not commit
   count.

## 4. The ratio metric (testing.md §4: `derivedCommits / (authoredSeen − effectAcks)`)

| workload | ON ratio (counters) | budget | ON store commits (authored + derived) | OFF store commits (all authored-class under OFF) | note |
|---|---|---|---|---|---|
| chat (t1, partial to lockdown) | 36 / 20 = **1.80** | ≤2 pure | 56 (20 + 36) | 608 for the FULL journey incl. the 20-post series (identical in all three OFF runs) | partial ON journey — not the same window as OFF's 608 |
| chat (t2, stalled) | 109 / 62 = 1.74 | ≤2 | 171 (62 + 109) | 608 | stalled run kept waving |
| chat (smoke0, load 10–18) | 35 / 20 = 1.75 | ≤2 | 55 | 251 (n=3 series) | excluded from latencies; ratio load-insensitive |
| lunch (l1, red at merge) | 43 / 25 = **1.72** | ≤2 pure | 68 (25 + 43) | 398 (l1a) | steady-state window not reached |
| note (n1, series completed) | 297 / 107 = **2.78** | ≤3 effectful (effectAcks 21) | 425 (128 + 297) | 989 (n1a) / 971 (n1b) / 989 (n2b) | the one clean like-for-like: OFF ≈ 9.1–9.2 total commits per logical write (971–989 / 107), ON ≈ 4.0 total / 2.78 derived-only |
| note (n2, 17/20, capped) | 214 / 78 = **2.74** | ≤3 effectful (effectAcks 18) | 310 (96 + 214) per counters | — | consistent with n1 |

§4's trigger (≤2 pure / ≤3 effectful) is **not breached** on any ON run —
the amplification requirement is met where it can be measured; it is the
latency requirement that fails. `derivedCommits ≈ waves` throughout (one
derived commit per wave), matching fan-out B's observation.

## 5. Deviations from the protocol (verbatim), and what a quieter box would add

1. **"measure through `deno task integration --port-offset=NNN`" (plan
   preamble / testing §1) — deviated:** runs used the compiled binaries booted
   `--background --log-file` on private ports, exactly the fan-out B verify
   report §2 / CI ON-lane recipe, because a source-run toolshed cannot bake
   the ON shell define (`/api/meta.shellServerExecutionDefine` is `null` in a
   source run → a MIXED posture). The test file, its `deno test` flags
   (`-A --v8-flags=--max-old-space-size=4096 --trace-leaks`, `LOG_LEVEL=warn`,
   `HEADLESS=1`, `API_URL`) are those `tasks/integration.ts` passes for the
   patterns lane; `--no-lock` added per repo rule; `--no-check` (CI) not used
   (irrelevant to behaviour).
2. **`CF_NOTE_CREATE_TIMING_DELAY_MS` does not exist in this tree** (only in
   `docs/history/…/client-passivity.md`); the note series ran back-to-back
   (delay 0), byte-identical across arms.
3. **n ≥ 20 per arm on the chat series was NOT achieved for ON — 0 series in
   3 tip attempts + 1 ablation attempt** — because the ON arm never reaches
   the series leg. The ON latency evidence is the per-step StepTimer numbers
   (n=1 per step per run, 2 runs with timings) and the completed note-create
   series (n=20 in ON rep 1; rep 2 reached 17/20 before the 780 s hard cap).
   This is the finding, not a shortcut; the harness was not tuned.
4. **Load:** four measured runs started at 1-min load 5.5–6.9 (marked in §2);
   my own run adds ~2 to the 1-min load (2 headless browsers + toolshed +
   test). The smoke runs (load 9–18) are excluded from every number. The
   verdict rests on the ≤4-load runs (t2/t2b chat, l1a/l1/l1b lunch) and on
   set relations (completion / no completion, counters).
5. **Three-way:** OFF–ON–OFF done for chat (t1a/t1/t1b) + ON–OFF (t2/t2b),
   note (n1a/n1/n1b + ON n2 / OFF n2b), lunch (l1a/l1/l1b). The middle control for
   "is it the F5 revert?" was attempted once (`fadc2efb1b`, full stack, ON):
   killed at 9 min by my tool's 10-min foreground timeout before its own
   15-min cap, no step timings; its server log shows the same lease-lost /
   wave-commit-rejected churn as tip t2. Counted as "did not complete", not
   timed; not repeated (the tip already had 3 attempts).
6. **The server ran with the real staging LLM gateway** (CI's ON lane sets
   `CFTS_AI_GATEWAY_URL=""`); no LLM effect was ever admitted (`memo.misses`
   0, `outbox` 0/0 on chat/note) so this cannot have moved the numbers.
7. **Measurement scripts** (`run-arm.sh`, `wait-load.sh`, `extract.py`) exist
   in the scratchpad only; no repo file was written; the ablation worktree
   `bench-c-f5` (detached at `fadc2efb1b`) was created and removed by me;
   nothing pushed, no PR/issue comment.
8. **`--trace-leaks` and `LOG_LEVEL=warn`** as in the integration task; the
   server logged at its default level, so wave-level `debug` lines (e.g.
   `wave-budget-exhausted`) come from the counters, not the log.

**What a quieter box (load ≈0–2 for the whole run) would add:** a tighter
OFF band (the OFF chat median moved 227 → 477 ms between load 3 and 9, so
even ≤5 is not flat here); a 4th–6th ON chat attempt to bound the ON
completion rate (currently 0/3 tip); ≥3 ON note reps; and a clean
`fadc2efb1b` ablation to settle whether the F5 revert changed the ON gate's
completion behaviour (it did NOT change it here — both stacks failed — but
the ablation run was cut short). It would not change the verdict unless the
ON arm's lease-loss / stall behaviour disappears at zero load, which the
load-3.9 stall argues against.

## 6. Flip performance gate

**NOT MET** — cross-user propagation does not beat the client-computed
baseline on the byte-identical workloads: the ON arm is 5–8× slower actor-side
(note, two reps), 30–1000× slower on every cross-user step it completed (chat
steps, lunch steps), and cannot complete the two-browsers or lunch journeys at
this tip (0/3 + 0/1 at fadc2efb1b; lunch 0/1), so the headline
send→other-browser series is unmeasurable; the §4 amplification ratio
(1.7–2.8) is the only criterion met.
