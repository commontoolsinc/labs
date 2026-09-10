---
status: historical
created: 2026-08-24
archived: 2026-08-24
reason: "Measurement record: topics tests and benchmarks ON vs OFF at tip 2ea87cea9 — the post-optimize regime confirmed on a growth-dominated workload, with the OW60 echo-drop guard measured at 0 fires in 20 journey runs; the distilled finding lives in verification-coverage.md OW60, and the bar the report declines to rule stays OW38's, the owner's."
---

# Topics tests + benchmarks, ON vs OFF — measurement report (2026-08-24)

> **Amendment (2026-08-24, coordinator ruling — the frozen body below is
> unchanged).** §1's "no posture breaks in 66 new-tip runs" is scoped to the
> SERVER-BACKED runs. Those are the runs that boot a toolshed and produce the
> `meta.json` / `stats-pre.json` probe files the claim rests on. The pattern
> `.tsx` runs in the same campaign (`topics.test.tsx`,
> `topics-rejections.test.tsx`, `multi-user.test.tsx`, 3 reps per arm each) ran
> through the repo's own runner with NO server by design
> (`PACKAGES_WITHOUT_SERVER`, stated in §1) and carry their posture as the env
> var rather than a probe, so they cannot have been posture-probed and are not
> part of a probe-verified count. This does not disturb any finding: the
> no-server lane's own result is §5.1's multi-user RED, which §5.1 already
> attributes to that lane having no serving loop. The register's OW60 evidence
> note relies only on the 20 probed journey runs (§2b).

*Archived verbatim 2026-08-24; the raw run artifacts it cites (the per-run
`.bench-artifacts/` ledger, logs, stats and series) are not archived here —
they live on the measuring box at
`/Users/berni/labs-worktrees/topics-benchmark/.bench-artifacts/`, committed on
the branch `claude/server-exec-v2-topics-benchmark`.*

Seat: topics-benchmark (`/Users/berni/labs-worktrees/topics-benchmark`,
branch `claude/server-exec-v2-topics-benchmark`). The owner's standing
bar (2026-08-22): "looks like we're fast enough now but we should also
measure the topics tests and benchmarks before we decide it's good
enough." This report measures; it does not rule the bar (register OW38:
the bar is the owner's).

## 1. Method

**Tip.** Rebased onto `origin/main` at `2ea87cea9` ("CFC envelopes
converge on the cid system", #6199) — includes OW45 arm-B stage 1
(#6210). The parked seat state was committed first as park checkpoint
`97f0745e5` (scratch instrument + driver + old-head smoke0–4), then
rebased. No product-code changes anywhere on the branch; the later
branch commits are bench files and captured evidence only.

**Binaries.** Two `deno task --no-lock build-binaries toolshed` builds
from the clean worktree, `COMMIT_SHA=97f0745e5979` baked (product tree
identical to `2ea87cea9`), both 617 461 362 bytes:

| binary | built with | sha256 (first 16) | `/api/meta` | `/api/health/stats` |
|---|---|---|---|---|
| `toolshed-off` | flag UNSET (`env -u EXPERIMENTAL_SERVER_EXECUTION`) | `849204a9f6e1f5ef` | define `None` | no `servingLoop` key |
| `toolshed-on` | `EXPERIMENTAL_SERVER_EXECUTION=true` | `3da66132e4cc6173` | define `"true"` | `servingLoop` present |

**Protocol** = the flip-readiness dossier §2 recipe (the W4 protocol),
topics edition (`.bench-artifacts/run-topics.sh` / `run-suite.sh`):
stray-port check → load recorded → fresh cwd = fresh store per run →
binary booted `--background --log-file --port=P` (9871 OFF / 9872 ON) →
posture probed **per run** (`meta.json` + `stats-pre.json`) → ONE
workload from `packages/patterns` (`LOG_LEVEL=warn HEADLESS=1 API_URL
SPACE_NAME=topicsbench-<run>`, `deno test|bench -A --no-lock
--v8-flags=--max-old-space-size=4096 --trace-leaks`, `gtimeout
--kill-after=30 520` — 900 for the browser bench) → post stats → PID-only
kill → port-free check → orphan-headless check → store commit counts by
class. Every ON run probed define `"true"` + `servingLoop` present;
every OFF run define `None` + absent — **no posture breaks in 66
new-tip runs**. LLM masking verified per run (0 `CFTS_AI_LLM_*` keys,
toolshed `.env` absent, `No default model available` in every toolshed
log). Load gate before each pair (threshold 6 — see §4), arms adjacent
within a pair, order balanced across pairs. Pattern `.tsx` tests ran
through the repo's own runner (`deno task --no-lock integration
pattern-tests patterns/topics/` — no server by design;
`PACKAGES_WITHOUT_SERVER`), posture = the env var, 520 s cap.

**Percentiles**: nearest-rank (`sorted[ceil(q·n)-1]`) computed offline
from per-event raws (`.bench-artifacts/aggregate.py`). The board bench's
per-segment numbers are `deno bench --json` avg (min–max) over 5
measured iterations (+1 unmeasured warm-up), ns→ms.

## 2. Results

### 2a. Topics tests, per file, ON vs OFF (pass/fail + wall)

**Integration (fresh toolshed per run):**

| file | OFF | ON |
|---|---|---|
| `integration/topics-navigation.test.ts` (n=6/arm) | **6/6 green**, wall med 8 s (8–32) | **6/6 green**, wall med 12 s (11–24) |
| `integration/topic-create-onscreen.test.ts` (n=3/arm) | **3/3 green**, walls 14–25 s | **3/3 green**, walls 20–27 s |
| `integration/topic-board-fixture.test.ts` (n=3/arm, unit) | **3/3 green**, 0–7 s | **3/3 green**, 0–1 s |

**Pattern tests (repo runner, no server; per-file wall from the runner):**

| file | OFF | ON |
|---|---|---|
| `topics/topics.test.tsx` (45 asserts) | **3/3 green**, 15.1–16.3 s | **3/3 green**, 11.4–13.2 s (ON ~25% faster) |
| `topics/topics-rejections.test.tsx` (14 asserts + 13 expected errors) | **3/3 green**, 4.6–5.0 s | **3/3 green**, 4.6–5.3 s |
| `topics/multi-user.test.tsx` (7 asserts, two worker runtimes) | **3/3 green**, 10.1–10.8 s | **3/3 RED**, 10.1–12.1 s — see §5 finding |

topics-navigation store classes flip as designed: OFF 77–79
authored / 0 derived per run; ON 7–8 authored / 29–33 derived.

### 2b. Topics journey benchmark (the seat's instrument; n=10 journeys/arm)

Journey = board create → 2 seed `addTopic` stream events (echo-timed) →
browser cold-load of the populated board → 20-event `addTopic` series at
2 s cadence (per event: **echo** = controller's own `topics` cell holds
the title; **arrival** = the browser's body shows it, same t0) → click a
rendered "Open" link → piece view. All 20 runs rc=0; echo-drop guard
(OW60) fired **0 times in 20 runs** (old head saw ~2/10).

**Steps (ms, nearest-rank p50/p90 over 10 runs):**

| step | OFF p50 / p90 (min–max) | ON p50 / p90 (min–max) |
|---|---|---|
| board create + start (controller) | 2 406 / 4 254 (1 971–5 463) | **1 854 / 2 527** (1 450–3 424) |
| addTopic seed 1 echo (right after create; the OW60 window) | 433 / 836 (342–1 220) | **1 630 / 2 284** (1 339–2 822) |
| addTopic seed 2 echo | 345 / 630 (261–671) | 410 / 945 (280–1 143) |
| fid capture (result.pull + resolveAsCell ×2) | 37 / 64 | 35 / 52 |
| browser cold load: goto + login | 591 / 954 (427–970) | 644 / 802 (578–862) |
| browser renders both seed titles | 1 067 / 1 850 (586–1 913) | 970 / 1 452 (455–1 585) |
| navigate-to-topic: click Open → piece view | 43 / 50 | 44 / 53 |
| **TOTAL journey** | **4 905 / 9 019** (3 820–9 675) | **5 707 / 7 094** (4 455–9 810) |

**Per-event series (pooled, n=200/arm):**

| series (ms) | arm | p50 | p90 | p95 | min | max |
|---|---|---|---|---|---|---|
| echo (sender's own render analog) | OFF | 732 | 1 145 | 1 436 | 280 | 2 147 |
| echo | ON | 1 408 | 2 693 | 3 370 | 580 | 4 624 |
| arrival (send → other surface renders) | OFF | 977 | 1 598 | 1 805 | 304 | 3 010 |
| arrival | ON | 1 473 | 2 840 | 3 553 | 599 | 4 798 |
| gap (arrival − echo) | OFF | 252 | 530 | 619 | 21 | 891 |
| gap | ON | **59** | 134 | 156 | 17 | 188 |

ON/OFF ratios at p50: echo **1.92×**, arrival **1.51×**. The
cross-surface gap **collapses** under ON (59 vs 252 ms p50): once the
sender's own view covers, the other surface is ~60 ms behind — the cost
sits in the shared derivation, not in propagation. Journey stores: OFF
557–559 rows all-authored; ON 201–241 total (27–28 authored + 173–213
derived) — ON writes ~2.6× fewer rows for the same journey.

Supporting instrument (`topic-create-onscreen`, per-topic medians,
n=15/arm, size-5 boards; "offscreen/onscreen" = whether a browser
renders the board — not the arm): offscreen-board per-topic OFF 559 →
ON 776 ms; onscreen write OFF 524 → ON 892 ms; onscreen total OFF 673 →
ON 940 ms; browser render share OFF 161 → ON 28 ms.

### 2c. The repo's canonical topics benchmark (`topic-board-navigation.bench.ts`, 30-topic board, 3 reps/arm)

| segment (ms, avg of 5 iters; min–max) | OFF rep1/rep2/rep3 | ON rep1/rep2/rep3 |
|---|---|---|
| load | 462 / 514 / 427 | 412 / 477 / 474 |
| sign in | 219 / 303 / 266 | 226 / 240 / 343 |
| board (cards appear) | 2 035 / 2 639 / 2 156 | 2 422 / 2 914 / 2 454 |
| open topic | 369 / 613 / 364 | 822 / 877 / 675 |
| crossref follow | 327 / 341 / 301 | 477 / 509 / 527 |
| **journey (end-to-end)** | **3 083 / 3 706 / 3 287** | **4 645 / 5 364 / 4 964** |

All 6 runs green. Load and sign-in at parity; the ON delta concentrates
in open-topic (~1.4–2.2×) and crossref (~1.5×); end-to-end **1.4–1.5×
OFF**. (`topic-board-scale.bench.ts` — the size-sweep shape chart — was
not run: it is the dashboard's long-form artifact and the fixed-size
navigation bench covers the ON/OFF question; noted as an omission.)

### 2d. Server settle-time series (OW38(ii); `servingLoop.settle`, per ON run)

Settle = authored input admitted → derived consequences committed and
covered (`waitForSettled`/`derivedThrough`); `settleAdvances` split out
per W3.1 (26–27/run journeys, dropped 0; effectAcks 0; `lease.lost` 0
everywhere; no `walkRuns` key).

| run | n | all-inputs p50/p95/max | growth n; toLanding p50/p95/max | event-append p50/p95 |
|---|---|---|---|---|
| j1-on | 27 | 19 / 1 956 / 3 131 | 24; 1 115 / 2 105 / 6 094 | 19 / 51 |
| j2-on | 28 | 28 / 1 554 / 2 294 | 25; 1 672 / 3 969 / 4 745 | 28 / 76 |
| j3-on | 28 | 19 / 2 861 / 5 788 | 24; 1 070 / 2 947 / 5 922 | 19 / 548 |
| j4-on | 28 | 21 / 2 540 / 3 757 | 23; 1 294 / 2 680 / 3 841 | 19 / 983 |
| j5-on | 27 | 36 / 3 472 / 4 607 | 25; 1 765 / 3 717 / 10 283 | 35 / 84 |
| j6-on | 28 | 31 / 2 131 / 3 074 | 25; 1 291 / 4 005 / 4 207 | 29 / 68 |
| j7-on | 28 | 21 / 1 652 / 2 780 | 26; 1 194 / 2 253 / 5 298 | 21 / 51 |
| j8-on | 28 | 30 / 1 920 / 2 858 | 27; 1 146 / 2 931 / 3 026 | 28 / 49 |
| j9-on | 28 | 21 / 1 814 / 2 770 | 25; 1 194 / 1 921 / 5 450 | 20 / 52 |
| j10-on | 28 | 19 / 1 465 / 2 316 | 24; 1 043 / 1 762 / 2 372 | 19 / 245 |
| t1–t6-on (nav test) | 7–8 | p50 38–109 | 4–6; toLanding p50 520–866 | — |

**Pooled ON (all 16 runs): all-inputs n=322 p50 = 22 ms, p90 = 1 652,
p95 = 2 731, max = 5 788; value-only n=43 p50 = 32 ms;
growth-to-landing n=279 p50 = 1 227 ms, p95 = 3 921, max = 10 767.**
OFF witness: `servingLoop` absent from every OFF run's stats (no
posture breaks); OFF stores authored-only (zero derived/system rows).

The workload's signature: topics is **growth-dominated** — 279 of 322
settle inputs are structural growth (87%; the chat journey was 39%).
Coverage lands at the dossier's ms-class band (p50 22 ms, matching
chat/lunch/note 22–37 ms), but the growth **landing** — the derived
topic materialized and covered — has p50 1 227 ms vs the dossier's
232–520 ms band on chat/lunch/note. The client-visible ON echo (p50
1 408 ms) tracks that landing series, which is where the topics ON/OFF
delta lives.

## 3. Comparators

- **Stage-C re-benchmark (2026-08-18, `b54bf5215`, pre-optimize)**:
  chat cross-user p50 **7 397–9 734 ms ON** vs 220–242 ms OFF; note
  createToView p50 **4 154 / 3 879 ms ON** vs 1 133–1 185 ms OFF —
  ON was 10–40× OFF.
- **Flip-readiness dossier (2026-08-23, `0c0261df3`, post-optimize,
  same box)**: chat arrival median ON 376–568 vs OFF 258–305 ms
  (1.2–1.9×); note createToView ON 907 vs OFF 1 147–1 168 ms; server
  settle all-inputs p50 22–37 ms; growth-to-landing p50 232–520 ms.
- **This report (topics, `2ea87cea9`)**: the topics workload lands in
  the post-optimize regime, not the stage-C one: arrival 1.51× OFF
  (not 10–40×), board-bench journey 1.4–1.5× OFF, settle coverage p50
  22 ms in the dossier's band. What topics adds to the picture: its
  near-every-input structural growth makes the **landing** series the
  dominant term (p50 ~1.2 s), visible as the ~2× sender-echo and the
  seed-1 echo (1 630 vs 433 ms) right after board create.

## 4. Variance notes

- Ambient: the box's resident daemon pair held 1-min load ~4–6 all
  session, with transient bursts to 10–16 (and one to 161 — §5). The
  dossier-era gate threshold 5 under-admitted at today's ambient, so
  the gate was raised to 6 from t6 on (`gate-threshold` file; noted in
  the ledger). Both arms of every pair ran adjacent in the same load
  band; per-run loads are in the ledger + 10 s samplers.
- ON journey per-run echo medians: 1 191–1 477 ms in the low-load
  cluster (7 runs); 2 199–2 426 ms in the two runs that started at
  elevated load (j2-on, j5-on: in-test load 5.4–11). OFF medians
  459–1 250, elevated at the same moments (j6-off 1 250 at load ~9).
  Load sensitivity is symmetric; pair adjacency holds.
- M1 walls: the t1 pair (32/24 s) ran at the session's first load
  spike; the other five pairs sit at 8–12 s in both arms.
- topics.test.tsx runs consistently ~25% FASTER under ON (11.4–13.2 vs
  15.1–16.3 s, 3/3 vs 3/3) — not investigated further (single-runtime
  happy paths; consistent with fewer local recomputes under ON).

## 5. Anomalies

1. **`topics/multi-user.test.tsx` FAILS under ON, 3/3 reps; green 3/3
   OFF** (the campaign's one red surface). 5/7 assertions fail, both
   personas: the writing runtime's own assertions pass; the OTHER
   worker runtime sees `board.topics` length 0 / `commentCount`
   undefined. The pattern-tests lane runs with NO server by design
   (`PACKAGES_WITHOUT_SERVER`), so this is consistent with ON deferring
   topic materialization to a serving loop that does not exist in a
   two-worker-runtimes/one-in-process-space harness. Recorded, not
   fixed (measurement-only seat). Flip relevance: if the default
   flips, this no-server lane runs ON and goes red unless the lane
   pins OFF or the in-process surface grows the serving role.
   Evidence: `.bench-artifacts/runs/pt{1,2,3}-on/test.log`.
2. **The old head's deferred-start ConflictError went quiet at this
   tip.** At `26be6c909` the ON arm hit `tx-commit-error … ConflictError:
   stale confirmed read … seq 0 conflicted with seq 11` right after
   board create in 2/2 ON smokes. At `2ea87cea9`: **0 occurrences in
   all 66 new-tip runs** (every run's `tx_commit_error_lines=0`).
   Consistent with #6199's commit-boundary changes; not proven causal.
3. **OW60 echo-drop guard: 0 fires in 20 journey runs** (the register
   row records ~2/10 at earlier heads). The barriered-capture window
   (seed writes right after create) was exercised 40 times (2 seeds ×
   20 runs).
4. One campaign interruption: between j6 and j7 a sibling seat's
   loaded-mode gate campaign (six deliberate CPU spinners) drove load
   to 161 and the harness stopped the background task carrying my
   sequence at j7's gate — clean death (no toolshed left, no partial
   run dir), resumed at ambient; nothing of the sibling's was touched.
   j1–j6 pre-date it, j7–j10 post-date it; their medians straddle the
   break indistinguishably.
5. The p1–p3/r1 ledger rows (rc=1, walls 0–7 s) are a harness mismatch
   (plain `deno test` cannot load CTS-transformed `.tsx`), superseded
   by the `run-pattern.sh` series; annotated in the ledger.

## 6. What the numbers say

(No bar ruling here — the bar is the owner's.)

- The topics workload confirms the post-optimize regime on a surface
  the arc had not yet measured: every integration surface green in
  both arms, cross-surface arrival 1.51× OFF at p50 (the dossier's
  chat band), the canonical board bench 1.4–1.5× OFF end-to-end, and
  settle-to-coverage p50 22 ms — squarely in the dossier's 22–37 ms
  band. Nothing anywhere near the stage-C 7–10 s class.
- What topics uniquely shows: a growth-dominated workload moves the
  cost into the growth-landing series (p50 ~1.2 s, p95 ~3.9 s) — the
  sender's own echo under ON waits on it (1 408 vs 732 ms p50), and
  the first write after board create pays it hardest (seed-1 echo
  1 630 vs 433 ms). Once landed, propagation is essentially free (gap
  59 ms vs OFF's 252 ms), the browser's render share drops (28 vs
  161 ms per topic), and the store writes ~2.6× fewer rows.
- One surface is red under ON and was green before: the serverless
  multi-user pattern lane (§5.1) — a lane-posture question the flip
  decision has to address either way.

## 7. Files and pointers

- Report: `/Users/berni/labs-worktrees/topics-measure-report-2026-08-24.md`.
- Branch: `claude/server-exec-v2-topics-benchmark` (pushed; park
  checkpoint `97f0745e5` + evidence commits).
- Ledger (76 entries, per-run posture/loads/walls/stores):
  `.bench-artifacts/run-ledger.txt`. Aggregations:
  `.bench-artifacts/aggregate.py`, `aggregate-out.md`.
- Per-run artifacts (test.log, toolshed.log, meta/stats JSON,
  junit/bench.json, load samples): `.bench-artifacts/runs/<run>/`
  (committed; the srv sqlite stores are repo-ignored `cache` paths and
  stay local on the worktree).
- Drivers: `run-topics.sh` (journey/nav), `run-suite.sh` (any
  file/bench), `run-pattern.sh` (tsx via repo runner), sequences
  `run-sequence.sh`, `resume-j7-j10.sh`, `m3-sequence.sh`,
  `m4-sequence.sh`; binaries rebuilt per §1 (deleted-not-committed;
  recipe + shas in the ledger).
