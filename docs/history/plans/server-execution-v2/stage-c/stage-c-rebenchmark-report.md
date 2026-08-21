---
status: historical
created: 2026-08-18
archived: 2026-08-18
reason: "Stage-C evidence: the re-benchmark on the tuning trio's tip (b54bf5215) — ON completes every journey but the cross-user series is 31–44× OFF; the design pass's baseline."
---

# Stage C — RE-benchmark on the tuning trio's tip (server-execution v2)

Date: 2026-08-18 (runs 14:35–15:06 PDT = 21:35–22:06 UTC). Branch
`claude/server-exec-v2-stage-c-tuning` at **`b54bf5215`** (= PR #5991's tip
after the independent-review fix batch; the trio's runtime code is that of
`2e9d86478` — the fix batch touched one register doc and two test files),
worktree `/Users/berni/labs-worktrees/fix-tuning`. Same protocol as the first
stage-C benchmark (`stage-c-benchmark-report.md`, 2026-08-17, at fan-out B
`59b5329ae`): OFF → ON → OFF per workload, fresh store per run, binaries built
from the tip, posture verified before every run, load gated and recorded,
byte-identical workloads across arms. Measure-and-report only: no repo file
changed for this part, nothing else pushed, no comment posted. Raw artifacts
(driver logs, test logs, toolshed logs, pre/post `/api/health/stats`, per-run
sqlite stores, 10-s load samples) live under the session scratchpad
`…/scratchpad/rebench/runs/<run>-<workload>-<arm>/`; the measurement scripts
(`run-arm.sh`, `wait-load.sh`, `extract.py`) live beside them and never touched
the repo. Machine-readable per-run extraction:
`/Users/berni/labs-worktrees/stage-c-rebenchmark-results.json` and the one-line
table `/Users/berni/labs-worktrees/stage-c-rebenchmark-results-table.md`.

## 1. Verdict (README §1 vocabulary) and the two honest bars

**SLOWER, attributed (§3) — and now MEASURABLE: the ON arm completes every
byte-identical journey at this tip, so the headline send→other-browser series
exists for the first time.**

- **Bar (i) — does ON COMPLETE the journeys now (the trio's job)? YES.**
  Two-browsers chat: **2/2 complete with a full n=20 series** (272 s, 251 s
  walls) — the first benchmark had 0/3 at the tip + 0/1 at `fadc2efb1b`
  (lockdown stall 300 s, or lease churn from t≈0). Lunch two-user vote: **2/2
  GREEN** (43 s, 57 s) — the first benchmark had 0/1 (red at "both browsers
  see 2 love it (merge)", 300 s); the ruling on the (α) double-dispatch is
  still pending and its class is still visible in the counters
  (`events.appended 11 / processed 17` in both runs), but it did not break
  the journey in either attempt (the skip list's "bimodal" shape; NOT
  chased). Note-create n=20: **2/2 series completed** (214 s, 237 s; the first
  benchmark's rep 2 hit a 780-s cap at note 18) — rep 2 then failed the
  browser-console gate on the pre-existing `splitDefinitions` error
  (`Cannot read properties of undefined (reading 'split')` at
  `reference-block.ts:62`, 4×), exactly the first benchmark's §2/§6 finding;
  rep 1 passed the gate. `lease.lost` **0** in all 6 ON runs; `events.processed
  == appended` in every chat/note run (28/28, 28/28, 94/94, 94/94).
- **Bar (ii) — is ON "sub-second, within a small constant of OFF" on the
  cross-user step (the design pass's target)? NO — not close; here is the
  baseline the design stage inherits.** The chat series (send-click → other
  browser renders, n=20 @2 s): **ON p50 7 397 / 9 734 ms, p95 13 805 / 14 020
  ms** vs **OFF p50 220 / 221 / 242 ms, p95 288 / 367 / 400 ms** — 31–44× at
  p50, 35–49× at p95, and the ON per-post cost climbs across the series
  (5.3 → 11–14 s). Per-step cross-user timings (same StepTimer, both arms):
  message propagation **2.6–3.0 s vs 6–17 ms**, lockdown propagation **3.3–4.1
  s vs 3–21 ms**, cross-browser name propagation **1.2–2.3 s vs 5–6 ms**, room
  propagation **9.5–10.2 s vs 2–3 ms**; lunch "option A propagates to both"
  **3.1–3.9 s vs 8–9 ms**, "both browsers see 2 love it (merge)" **3.7–6.3 s vs
  35–42 ms**, "option B vote lands" **7.8–9.0 s vs 112–118 ms**. Actor-side
  (note createToView p50): **ON 3 879 / 4 154 ms vs OFF 1 133 / 1 145 / 1 185
  ms** (3.4–3.7×; was 5.4–8.2×), p95 6 606 / 10 454 vs 1 237–1 341 (5–8×; was
  ~16–20×). Every ON cross-user step is 1–2 orders of magnitude above one
  second.

**Drift-control noise band (OFF₁ vs OFF₂ vs OFF₃, bracketing every ON run):**
chat series median 242 / 221 / 220 ms (a 10 % band at 1-min loads 3.3 / 4.4 /
2.3 — tighter than the first benchmark's 227–477 ms because the box stayed at
load 2–5 throughout); note createToView p50 1 185 / 1 133 / 1 145 ms (4.6 %),
p95 1 328 / 1 341 / 1 237 (8 %); lunch OFF walls 17 / 11 s. Every ON gap above
is 3.4×–4 000× — far outside the band. So: **SLOWER (attributed)** on every
workload where a number exists — which is now all of them; PARITY nowhere;
nothing INCONCLUSIVE (baseline and drift control clean, ON reproduced 2/2 per
workload at loads 2–4).

**Versus the first benchmark, in one line:** the trio turned "ON cannot
complete the cross-user journeys; 5–8× slower actor-side" into "ON completes
every journey; 30–45× slower on the cross-user series, 3.4–3.7× actor-side" —
completion fixed, latency still design-class (§3).

## 2. Binaries, posture, runs, load

**Binaries** (two `deno task build-binaries toolshed` builds from `b54bf5215`
with `COMMIT_SHA=b54bf5215…`, `dist/toolshed` moved aside after each; both
352 873 074 bytes):

| binary | built with | sha256 (first 16) | `/api/meta` | `/api/health/stats` | toolshed start log |
|---|---|---|---|---|---|
| `toolshed-off` | flag UNSET (`env -u EXPERIMENTAL_SERVER_EXECUTION`) | `99f1f9900658afde` | `gitSha b54bf5215…`, `shellServerExecutionDefine: null` | no `servingLoop` key | no serving-loop line; `No default model available` |
| `toolshed-on` | `EXPERIMENTAL_SERVER_EXECUTION=true` | `60ab8e0a598b2f40` | `gitSha b54bf5215…`, `shellServerExecutionDefine: "true"` | `servingLoop` present | `Server-execution v2: serving loop ON`; `No default model available` |

Posture was probed once per binary before any run (`…/rebench/probe-{off,on}/`)
and then read from `/api/meta` + `/api/health/stats` **before every run**
(each `driver.log`/`meta.json`/`stats-pre.json`): every ON run define `"true"` +
`servingLoop`, every OFF run define `null` + no `servingLoop`, every run gitSha
`b54bf5215…`. The test process carried the same posture as the server
(`EXPERIMENTAL_SERVER_EXECUTION=true` set for ON, unset for OFF; the
`[chat-series] arm=` label reads `ON`/`OFF` accordingly).

**No configured LLM model — what was checked:** (1) the shell has no
`CFTS_AI_LLM_*_API_KEY` variables (`env | grep -c` = 0, recorded per run as
`llm_env_check`), (2) `packages/toolshed/.env` is absent in the worktree
(`toolshed_dotenv=absent`), (3) every run's toolshed log carries `[models] No
default model available (tried gateway:claude-sonnet-4-6,
anthropic:claude-sonnet-4-6, anthropic:claude-sonnet-4-5).` — 14/14 runs
(recorded as `default_model=` in each driver log). The staging LLM gateway was
reachable (`Adding 🤖 gateway (30 models …)`, same as the first benchmark and
the trio's ledger) but registers no default candidate, so no LLM-driven
SummaryIndex churn could run — the attribution's masking condition is absent.
`memo` 0/0 and `outbox` 0/0 on every chat/note run confirm no effect traffic.

**Per-run recipe** — the first benchmark's, unchanged: stray check on the port
(only my ports 8960–8962; nothing foreign ever touched them) → 1-min load
recorded → **fresh cwd = fresh store** (`./cache/memory/` empty) → binary booted
`--background --log-file --port=P` with `PORT/API_URL/MEMORY_URL` all on P →
posture + default-model line read → ONE test file run from `packages/patterns`
with `LOG_LEVEL=warn HEADLESS=1 API_URL=http://localhost:P
SPACE_NAME=rebench-<run>` and `deno test -A --no-lock
--v8-flags=--max-old-space-size=4096 --trace-leaks <file>`, hard-capped with
`gtimeout --kill-after=30 520` → post stats read → load recorded → toolshed PID
killed → port verified free → orphaned headless shells (ppid 1, not present
before the run) killed — none ever were → store `commit` table counted by
class. Plus the trio ledger's 10-s load sampler per run
(`load-samples.txt`).

**Run ledger** (1-min/5/15 load before → after; ✓ = test green; all 14 runs
gitSha `b54bf5215`, all `No default model available`):

| run | workload | arm | port | start (UTC) | load before → after | test wall | result |
|---|---|---|---|---|---|---|---|
| c1a | chat n=20 @2 s | OFF₁ | 8960 | 21:35:28 | 2.35/2.80/2.77 → 3.30/3.08/2.87 | 61 s | ✓ series |
| c1 | chat n=20 @2 s | ON | 8961 | 21:36:43 | 2.79/2.97/2.84 → **6.17**/4.57/3.57 | 272 s | ✓ **series COMPLETE** (load in test 6.47) |
| c1b | chat n=20 @2 s | OFF₂ | 8962 | 21:42:45 | 4.76/4.62/3.70 → 4.32/4.50/3.71 | 55 s | ✓ series |
| l1a | lunch | OFF₁ | 8960 | 21:43:56 | 4.12/4.45/3.70 → 4.73/4.56/3.76 | 17 s | ✓ |
| l1 | lunch | ON | 8961 | 21:44:24 | 4.48/4.51/3.75 → 4.41/4.47/3.77 | 43 s | ✓ **GREEN** (was red at merge in the first benchmark) |
| l1b | lunch | OFF₂ | 8962 | 21:45:29 | 3.57/4.28/3.72 → 4.08/4.36/3.76 | 11 s | ✓ |
| n1a | note n=20 | OFF₁ | 8960 | 21:45:54 | 3.99/4.33/3.75 → 4.57/4.42/3.84 | 87 s | ✓ 2/2 steps |
| n1 | note n=20 | ON rep 1 | 8961 | 21:47:40 | 3.72/4.24/3.78 → 3.95/4.11/3.82 | 214 s | ✓ 2/2 steps (series n=20; console gate passed) |
| n1b | note n=20 | OFF₂ | 8962 | 21:51:34 | 3.44/3.98/3.78 → 3.92/3.93/3.77 | 82 s | ✓ 2/2 steps |
| c2 | chat n=20 @2 s | ON (attempt 2) | 8961 | 21:53:17 | 3.80/3.90/3.76 → 3.65/3.93/3.83 | 251 s | ✓ **series COMPLETE** (load in test 3.96) |
| c2b | chat n=20 @2 s | OFF₃ | 8962 | 21:57:46 | 3.07/3.78/3.78 → 2.29/3.46/3.66 | 55 s | ✓ series |
| l2 | lunch | ON (attempt 2) | 8961 | 21:58:47 | 2.19/3.42/3.65 → 3.36/3.50/3.66 | 57 s | ✓ **GREEN** |
| n2 | note n=20 | ON rep 2 | 8961 | 22:00:02 | 3.28/3.47/3.65 → 3.54/3.62/3.68 | 237 s | series n=20 COMPLETED; step 1 then failed the browser-console gate (4× `splitDefinitions` `reading 'split'`, pre-existing); step 2 ✓ |
| n2b | note n=20 | OFF₃ | 8962 | 22:04:30 | 3.10/3.51/3.63 → 4.67/4.21/3.91 | 80 s | ✓ 2/2 steps |

The load gate (`wait-load.sh 5 15`: poll every 60 s, up to 15 min) was applied
before every triplet and before every extra ON rep; it never had to wait more
than one poll (the box sat at 1-min load 2.2–4.8 for the whole session; the
first benchmark's ran at 3–18). One ON run (c1) drove the 1-min load to 6.5
during its own series (its 2 headless browsers + toolshed + test); its OFF
partner c1b started at 4.76. The second ON chat rep (c2) ran its series at
3.96 and produced the FASTER series (7 397 vs 9 734 ms p50), so the ON gap is
not a load artifact.

## 2a. Workload (a) — two-browsers chat, send-click → other browser renders

`CF_CHAT_MESSAGE_SERIES=20 CF_CHAT_MESSAGE_DELAY_MS=2000`, byte-identical
across arms (series clock: before the send click → browser 2's
`#trusted-conversation-preview` shows the text, MutationObserver + CDP binding).

| run | arm | n | median (test) | p50 | p95 | q1 / q3 | min / max | mean | load in test (1/5/15) |
|---|---|---|---|---|---|---|---|---|---|
| c1a | OFF₁ | 20 | 242 | 242 | 400 | 218 / 295 | 151 / 400 | 256 | 3.30/3.08/2.87 |
| c1b | OFF₂ | 20 | 221 | 221 | 288 | 195 / 243 | 160 / 288 | 217 | 4.35/4.51/3.71 |
| c2b | OFF₃ | 20 | 220 | 220 | 367 | 176 / 243 | 164 / 367 | 217 | 2.29/3.46/3.66 |
| c1 | ON | **20** | **9 734** | 9 734 | 14 020 | 6 456 / 11 263 | 4 393 / 14 020 | 8 993 | 6.47/4.54/3.55 |
| c2 | ON (attempt 2) | **20** | **7 397** | 7 397 | 13 805 | 6 700 / 9 350 | 5 273 / 13 805 | 8 131 | 3.96/3.99/3.85 |

(p50/p95 as the first benchmark's extractor computes them: sorted[int(f·n)],
so p95 at n=20 is the max.)

Raw series (ms, in order):
- c1a OFF₁: `226 333 151 196 173 287 166 240 204 218 260 295 221 400 382 228 242 255 353 295`
- c1b OFF₂: `200 182 160 160 170 201 168 231 243 288 197 195 211 275 283 221 235 229 238 248`
- c2b OFF₃: `202 176 172 164 174 168 169 260 235 191 220 198 202 367 231 236 232 243 260 245`
- c1 ON:    `5255 5721 5900 4393 4768 6456 7484 11824 10053 7571 8717 11256 11263 14020 10974 12241 11133 9614 9734 11478`
- c2 ON:    `5273 6857 7397 7150 5982 6693 6239 6724 8319 6042 7989 6700 6846 9032 11783 9788 9155 9350 11494 13805`

The ON per-post cost climbs across the series in both reps (first five posts
4.4–5.9 s, last five 9.6–14 s) while OFF is flat at 0.15–0.4 s — the same
grows-with-content shape as the note series (§2c), i.e. the design half's
intent-tracking term is visible on the chat series too, now that it completes.

Per-step StepTimer (same code path in both arms; ms):

| step | OFF c1a | OFF c1b | OFF c2b | ON c1 | ON c2 |
|---|---|---|---|---|---|
| navigate + login all profiles | 604 | 587 | 528 | 563 | 498 |
| initial "No profile" (all) | 1240 | 1225 | 1152 | 1663 | 1149 |
| Alice save + own status (actor-side) | 307 | 308 | 350 | **2344** | **873** |
| Bob sees Alice before save | 2 | 2 | 2 | 1732 | 3 |
| Bob save + own status (actor-side) | 301 | 299 | 292 | **681** | **1040** |
| cross-browser name propagation (all pairs) | 6 | 5 | 5 | **2278** | **1165** |
| message propagation (first → all) | 16 | 17 | 6 | **3018** | **2632** |
| lockdown propagation (first → others) | 3 | 21 | 20 | **3262** | **4094** |
| post-lockdown message (non-admin → admin) | 12 | 15 | 12 | **2521** | **2892** |
| room propagation (first → all) | 2 | 3 | 2 | **10160** | **9463** |
| client action runs (Alice / Bob) | 1006 / 1283 | 990 / 1303 | 975 / 1269 | **2753** / 983 | **2722** / 985 |
| client commitConflicts (Alice / Bob) | 35 / 193 | 36 / 215 | 22 / 205 | 0 / 0 | 0 / 0 |
| `overlayArrivalSweeps` (Alice / Bob) | 0 / 0 | — | — | **89 / 85** | **95 / 86** |
| `overlayLateEchoDrops` (Alice / Bob) | 0 / 0 | — | — | 0 / 0 | 0 / 0 |
| Alice `ipc/runtime:idle` p50 / p95 / max (ms) | — | — | — | 386 / 1435 / 1853 | 412 / 1342 / 1603 |

The lockdown step — the one that stalled 300 s in every red first-benchmark
and attribution run — now lands in 3.3–4.1 s (T2's arrival wake:
`overlayArrivalSweeps` 85–95 per browser per run with the 20-post series, vs
14–25 on the gate-only runs of the trio's ledger; `overlayLateEchoDrops` 0 —
the late-echo rule never fired live, again). Alice's `ipc/runtime:idle` max
is 1.6–1.9 s (the attribution's red runs: 8.7–12 s). Alice (the series sender)
runs 2.7× the client actions of the OFF arm (2 722–2 753 vs 975–1 006) — the
client-side intent-tracking cost the design half owns.

## 2b. Workload (b) — lunch-poll two-user vote (ruling on the double-dispatch pending)

| step (ms) | OFF l1a | OFF l1b | ON l1 | ON l2 |
|---|---|---|---|---|
| navigate + login both | 969 | 886 | 1399 | 1657 |
| both active space roots ready | 1117 | 857 | 898 | 1183 |
| both runtimes idle | 92 | 253 | 182 | 170 |
| host name filled / host joined | 18 / 26 | 45 / 27 | 21 / 7 | 21 / 8 |
| both join lands (count reaches 2) | 15 | 6 | **710** | 7 |
| option A propagates to both | 9 | 8 | **3064** | **3859** |
| both cast green concurrently | 598 | 381 | 596 | **1534** |
| both browsers see 2 love it (merge) | 42 | 35 | **3688** | **6322** |
| both voters' swatches visible on both | 1 | 1 | **4531** | **5546** |
| option B vote lands (3 votes) | 118 | 112 | **7835** | **9049** |
| total / result | 4200 ✓ | 3005 ✓ | 42 s ✓ | 56 s ✓ |

GREEN 2/2 on the trio's tip (the first benchmark: 0/1, red at the merge step
after 300 s; the skip list: bimodal 1/2 on the fixer binary). The double-
dispatch class the pending ruling covers is still there in the counters —
`events.appended 11 / processed 17` in BOTH runs (the LT1 in-process cascade
copy (α), which the trio's drain guard deliberately does not track: it dedupes
the drain against ITSELF only) — but neither run's second `castVote` no-op'd
the merge. Reported, not relied on, not chased. `outbox queued 2 / completed
0` and `memo misses 2 / inflight 2` at the post-read: the lunch `#now` effects
were still in flight when the (fast) test ended — the first benchmark's 363-s
red run had them 2/2 completed; not a regression signal, a read-time artifact.

## 2c. Workload (c) — single-user note-create series (actor-side)

`CF_NOTE_CREATE_TIMING_SERIES=20` (no inter-create delay knob exists in this
tree, as before); same test, same n, byte-identical.

| run | arm | n | createToView p50 | p95 | min / max | total p50 | p95 | returnToHome p50 | p95 | load in run |
|---|---|---|---|---|---|---|---|---|---|---|
| n1a | OFF₁ | 20 | **1 185** | 1 328 | 377 / 1 604 | 2 981 | 8 105 | 1 766 | 6 872 | 4.0 → 4.6 |
| n1b | OFF₂ | 20 | **1 133** | 1 341 | 219 / 1 901 | 3 292 | 6 961 | 1 951 | 5 573 | 3.4 → 3.9 |
| n2b | OFF₃ | 20 | **1 145** | 1 237 | 289 / 1 546 | 2 985 | 7 288 | 1 775 | 6 083 | 3.1 → 4.7 |
| n1 | ON rep 1 | 20 | **4 154** | 6 606 | 1 010 / 13 689 | 7 267 | 17 336 | 1 857 | 10 457 | 3.7 → 4.0 |
| n2 | ON rep 2 | 20 | **3 879** | 10 454 | 1 144 / 12 954 | 7 233 | 20 430 | 2 596 | 9 976 | 3.3 → 3.5 |

Raw createToView (ms, notes 1..20):
- OFF n1a: `525 408 451 412 464 383 433 377 1328 1215 1222 1185 1205 1213 1057 1209 1604 1253 1234 1217`
- OFF n1b: `437 318 337 322 360 219 599 1195 1204 1341 1204 1217 1264 1140 1119 1219 1194 1901 263 1133`
- OFF n2b: `439 335 300 289 404 302 484 1190 1145 1210 1237 1171 1200 1212 1080 1231 1083 1214 1546 1205`
- ON n1:   `1010 1238 1917 2818 1615 3160 4154 4603 4899 5410 3514 3640 3516 5873 5750 4691 13689 5553 5706 6606`
- ON n2:   `1144 1779 3252 1715 2882 4535 3772 3784 3165 4892 5894 3870 8360 3879 4227 6296 10454 6248 12954 8572`

ON/OFF createToView p50 ratio **3.4–3.7×** (the first benchmark: 5.4–8.2×;
the trio's ledger on the final binary: 3.2–4.8×), p95 5–8× (was ~16–20×). The
OFF list-size step at note 8–10 (0.3–0.6 → 1.1–1.4 s) is present in all three
OFF runs, as before; ON still has no plateau — per-note cost grows ~1.0 → 6–13
s over the series (was 1.6 → 25 s), the design half's O(events²) client
intent-tracking term, as the attribution predicted. Both ON series completed
n=20 in 214 / 237 s (the first benchmark: 502 s, and a 780-s cap at note 18).

## 3. Counter attribution (why ON is still slower — and the deltas vs the first benchmark)

`servingLoop` block after each ON run (OFF has none by construction). "First"
= the first benchmark's comparable run (chat t1 partial-to-lockdown / t2
stalled; lunch l1 red; note n1 completed).

| counter | chat c1 | chat c2 | first chat t1 / t2 | lunch l1 | lunch l2 | first lunch l1 | note n1 | note n2 | first note n1 |
|---|---|---|---|---|---|---|---|---|---|
| waves | 131 | 137 | 36 / 119 | 59 | 58 | 44 | 331 | 346 | 298 |
| **wavesBudgetExhausted** (now HONEST: counts every cut cycle, zero-delta ones included — not comparable to the old symptom count) | **777** | **739** | 19 / 99 | 163 | 180 | 40 | 349 | 362 | 169 |
| authoredSeen / effectAcks | 64 / 0 | 64 / 0 | 20 / 62 | 28 / 0 | 27 / 0 | 25 / 0 | 129 / 21 | 129 / 21 | 128 / 21 |
| derivedCommits (store: derived rows) | 131 (131) | 137 (137) | 36 / 108 | 59 (59) | 58 (59) | 43 | 331 (331) | 346 (346) | 297 |
| structureLoadTerminal / Rearmed / Deferred | 379 / 22 / 0 | 377 / 22 / 0 | 80 / 21 / 0 ; 382 / 38 / 0 | 234 / 26 / 0 | 232 / 23 / 0 | 160 / 25 / 0 | 441 / 114 / 0 | 436 / 114 / 0 | 334 / 114 / 0 |
| undemandedNarrowingRuns | 0 | 0 | 0 | 0 | 0 | 0 | 47 | 48 | 57 |
| **events appended / processed** | **28 / 28** | **28 / 28** | 6 / 6 ; 27 / 38 | 11 / 17 | 11 / 17 | 9 / 11 | **94 / 94** | **94 / 94** | 93 / 95 |
| events.coalescedPerWaveMax / skippedIdempotent | 1 / 0 | 1 / 0 | 1 / 0 | 2 / 0 | 2 / 0 | 2 / — | 2 / 0 | 2 / 0 | 2 / — |
| **events.drainInFlightSkips** (new) | **43** | **46** | — | 45 | 44 | — | 38 | 30 | — |
| **lease held / lost** | 3 / **0** | 3 / **0** | 3 / 0 ; 3 / **33** | 3 / 0 | 3 / 0 | 3 / 0 | 4 / 0 | 4 / 0 | 4 / 0 |
| watermarkLag / watermarkClamped / demandArrivals | 166 / 0 / 68 | 170 / 0 / 69 | 3 / — / 17 ; 4 / — / 57 | 54 / 0 / 20 | 63 / 0 / 19 | 1 / — / 19 | 8 / 1 / 0 | 7 / 1 / 0 | 3 / — / 0 |
| memo hits / misses / inflight | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 | 0 / 2 / 2 | 0 / 2 / 2 | 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 |
| outbox queued / completed / failed / budgetDeferrals | 0/0/0/0 | 0/0/0/0 | 0/0/0/0 | 2/0/0/0 | 2/0/0/0 | 2/2/0/0 | 0/0/0/0 | 0/0/0/0 | 0/0/0/0 |
| `outbox.superseded` | not present in this tip's stats | | | | | | | | |
| push prioritized / follower / mixedFlushes | 61 / 51 / 28 | 75 / 57 / 33 | 18 / 10 / 7 ; 83 / 33 / 29 | 21 / 15 / 9 | 21 / 19 / 10 | 17 / 11 / 7 | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 |
| supersededWrites / reactivationBackoffs / parkDisposeTimeouts / earlyEmitRefusals / foreign* refusals | all 0 | all 0 | all 0 | all 0 | all 0 | all 0 | all 0 | all 0 | all 0 |
| server log: `lease-lost` / `wave-commit-rejected` | 0 / 0 | 0 / 0 | 0 / 0 ; 11 / 11 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| server log: `event-view-lag` drain deferrals / `slow-traverse` | 22 / 0 | 16 / 2 | — | 1 / 1 | 1 / 0 | 1 / — | 75 / 1 | 78 / 3 | — |
| browser: `overlayArrivalSweeps` (A / B) · `overlayLateEchoDrops` | 89 / 85 · 0 | 95 / 86 · 0 | n/a (pre-T2) | — | — | — | — | — | — |

What the counters say:

1. **The trio did its job — the completion blockers are gone.** `lease.lost`
   0 in 6/6 ON runs and 0 `lease-lost` / `wave-commit-rejected` lines in any
   ON server log (the first benchmark's t2: 33 / 11 / 11 at load 3.9); the
   drain is exactly-once on chat and note (`processed == appended`,
   `drainInFlightSkips` 30–46 per run — the re-drains the honest deadline
   creates are being caught); the lockdown/served-value arrival that stalled
   for 48–300 s now lands in 3–4 s (`overlayArrivalSweeps` 85–95 per browser
   per run, `overlayLateEchoDrops` 0). The two-browser and lunch journeys
   complete 2/2 each at loads 2–4 (and one at 6.5).
2. **The latency term is the design half's, and it is unchanged in shape.**
   Cross-user steps sit at 2.6–10 s; `structureLoadTerminal` 377–441 per run
   (chat 379 on a COMPLETE journey vs 382 on the first benchmark's STALLED
   one — the per-demander demand walk × roots runs about as much work as
   before, it just no longer starves the renew timer or the deadline); the ON
   per-post / per-note cost climbs monotonically across each series (chat
   5 → 14 s, note 1 → 13 s) — the whole-sidecar intent tracking on the
   client (Alice 2 722–2 753 action runs vs OFF's ~1 000). Neither term is
   touched by T1–T3, by design.
3. **`wavesBudgetExhausted` is now honest and therefore not comparable to the
   first benchmark's:** it counts every cut cycle, zero-delta cycles included
   (777 over 131 waves in c1 ≈ 5.9 cut cycles per wave), where the old value
   was a late-firing symptom (19 of 36 waves). Read it as "how many 100-ms
   slices the settle needed", not as a wave ratio.
4. **The §4 amplification ratio rose with the honest deadline — read it with
   that in mind.** `derivedCommits / (authoredSeen − effectAcks)`: chat
   2.05 / 2.14 (first: 1.74–1.80 on partial journeys), lunch 2.11 / 2.15
   (first: 1.72), note 3.07 / 3.20 (first: 2.74–2.78) — each a hair over
   testing.md §4's ≤2 pure / ≤3 effectful lines, where the first benchmark
   sat just under. `derivedCommits == waves` in every run (one derived commit
   per wave, as before), and the honest deadline commits MORE, SMALLER waves
   per authored input, so the ratio tracks the cycle count now, not the
   per-write amplification; the store confirms ON still writes fewer total
   commits than OFF (chat 195–201 vs 608–612; note 460–475 vs 989). Flag for
   the §4 metric's owner: with an honest deadline the ratio's denominator
   needs a "per logical write" reading or its budget line moves; not a
   regression in work done.
5. **Lunch's (α) class is intact** (`processed 17 > appended 11`, both runs)
   and did not break the merge in 2 attempts — consistent with the skip
   list's bimodal note; the ruling stays pending and this run adds no
   evidence either way beyond "2/2 green today".
6. **What is NOT the cause:** push priority engaged (prioritized 61–75,
   follower 51–57, mixedFlushes 28–33 on chat); outbox and memo idle on chat/
   note; client commitConflicts 0/0 on ON (35–215 on OFF — the OFF client's
   own conflict churn); `supersededWrites`, `reactivationBackoffs`,
   `parkDisposeTimeouts`, `earlyEmitRefusals`, foreign refusals all 0. ON is
   still not paying for commit count (fewer store commits than OFF).

## 4. The ratio metric (testing.md §4)

| workload | ON ratio (counters) | budget | ON store commits (authored + derived) | OFF store commits (all authored) | note |
|---|---|---|---|---|---|
| chat c1 (COMPLETE incl. 20-post series) | 131 / 64 = **2.05** | ≤2 pure | 195 (64 + 131) | 608 (c1a) / 612 / 612 | like-for-like windows for the first time |
| chat c2 | 137 / 64 = **2.14** | ≤2 | 201 | | |
| lunch l1 / l2 (green) | 59 / 28 = **2.11** / 58 / 27 = **2.15** | ≤2 pure (the `#now` effects still in flight at read) | 87 / 86 | 398 / 398 | |
| note n1 / n2 (series completed) | 331 / 108 = **3.07** / 346 / 108 = **3.20** | ≤3 effectful (effectAcks 21) | 460 / 475 | 989 / 989 / 989 | first: 2.78 (n1) / 2.74 (n2 capped) |

See §3 item 4: marginally over the budget lines everywhere, by the wave-count
mechanism, with total commits still 2.1–3.1× BELOW OFF.

## 5. Deviations from the protocol (verbatim)

1. **Hard cap 520 s per test** (the first benchmark used 600–900 s; the trio's
   ledger 600 s) — chosen so a run plus its boot/teardown fits one 10-minute
   foreground tool window; no run came near it (max test wall 272 s), so no
   result was cut short by it.
2. **Same as the first benchmark, unchanged:** compiled binaries booted
   `--background --log-file` on private ports rather than `deno task
   integration --port-offset` (a source-run toolshed cannot bake the ON shell
   define); `--no-check` (CI) not used; `CF_NOTE_CREATE_TIMING_DELAY_MS` does
   not exist in this tree — the note series ran back-to-back (delay 0),
   byte-identical across arms; `--trace-leaks` and `LOG_LEVEL=warn` as in the
   integration task; the server logged at its default level, so wave-level
   `debug` lines come from the counters, not the log.
3. **The staging LLM gateway was reachable** (as in the first benchmark and
   the trio's ledger) but registered no default model — `No default model
   available` in 14/14 runs, `CFTS_AI_LLM_*` keys absent, no toolshed `.env`;
   `CFTS_AI_GATEWAY_URL` was NOT blanked (CI's ON lane blanks it), to keep the
   environment identical to the ledger the register cites. No LLM effect was
   admitted anywhere (`memo` 0/0, `outbox` 0/0 on chat/note).
4. **Extra reps beyond the base OFF–ON–OFF:** c2/c2b (a second ON chat + OFF
   partner), l2 (a second lunch ON), n2/n2b (a second note ON + OFF partner)
   — the same shape the first benchmark had (t2/t2b, n2/n2b) — added to bound
   the completion rate now that ON completes; every extra rep followed the
   load gate.
5. **Ports 8960–8962** (the first benchmark used 8950–8953); stray-checked
   free before every run, verified free after every teardown, and free at the
   end (8960–8963); zero orphaned headless shells in every run.
6. **An `[ERROR][runner] piece-start-commit-failed … the started graph's setup
   writes did not land (stage P2-F, F1)` line appears once, at t≈0, in EVERY
   ON two-browser run's test log (c1, c2, l1, l2; 0 in note and 0 in every OFF
   run)** — the same F1 class the first benchmark's stalled t2 showed at
   t≈0. Here every such run went on to complete green, so it is recorded, not
   triaged; it did not stop the journey at this tip.
7. **`wavesBudgetExhausted` semantics changed** with T3 (an honest count of
   cut cycles) — reported raw and NOT compared as a ratio to the first
   benchmark's values (§3 item 3). **`outbox.superseded` does not exist** in
   this tip's `/api/health/stats` (the outbox block is queued / completed /
   failed / budgetDeferrals) — nothing to report under that name.
8. **The Part-1 fix batch (`b54bf5215`) sits between the trio's code tip
   (`2e9d86478`) and this benchmark:** it changed one register doc and two
   test files, no runtime code (`git diff --stat 2e9d86478..b54bf5215`:
   `docs/specs/server-side-execution/verification-coverage.md`,
   `packages/runner/test/executor-cooperative-yield.test.ts`,
   `packages/runner/test/executor-events-down.test.ts`), so the binaries'
   runtime is the trio's; the gitSha reported by `/api/meta` is the fix
   batch's, as recorded.
9. **Measurement scripts** live in the scratchpad only (`rebench/run-arm.sh`
   — the first benchmark's driver plus the ledger's default-model line and
   load sampler; `wait-load.sh` copied verbatim; `extract.py` re-pointed);
   no repo file was written for this part; nothing pushed after `b54bf5215`;
   no PR/issue comment; the fix worktree was removed at the end and this
   report left in place.

## 6. Flip performance gate

**NOT MET — but the gate is now measurable and the failing term is named.**
The ON arm completes every byte-identical journey (chat 2/2 with a full n=20
series, lunch 2/2, note 2/2 series) with `lease.lost` 0 and exactly-once
dispatch, so README §1's question can finally be asked of a number: on the
cross-user series ON is 31–44× OFF at p50 (7.4–9.7 s vs 220–242 ms), 3–10 s
on every cross-user step vs 2–120 ms, and 3.4–3.7× actor-side (note
createToView) — far outside the 5–10 % drift band, and 1–2 orders above the
design pass's "sub-second, small constant of OFF" target. The residual is the
attribution's design half (per-demander demand walk × roots on the server —
`structureLoadTerminal` 377–441 per run — and the client's whole-sidecar
intent tracking — Alice's 2.7× action runs, the monotone per-post / per-note
growth), which the tuning trio deliberately did not touch. This report is the
design stage's baseline: cross-user step gap ON 2.6–10 s vs OFF 2–120 ms;
chat series ON p50 7.4–9.7 s / p95 13.8–14.0 s vs OFF p50 0.22–0.24 s / p95
0.29–0.40 s; note createToView ON p50 3.9–4.2 s vs OFF 1.13–1.19 s.
