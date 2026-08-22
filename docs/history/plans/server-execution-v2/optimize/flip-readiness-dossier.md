---
status: historical
created: 2026-08-22
archived: 2026-08-22
reason: "Flip-readiness dossier + the OW38(ii) benchmark re-run at main 0c0261df3: four of the five enumerated flip gates hold (skip list = ONE step entry, OW45 arm B; OW31 BUILT; OW45-OW53 walked closed with OW49's closure-declaration formality outstanding; ON lanes green at head), and the W4 protocol re-run reads server settle all-inputs p50 22-37 ms (sub-second everywhere), chat arrival ON/OFF 1.2-1.9x (was 1.9-2.4x), the W4-failed sender-echo bar now AT PARITY on chat (ON 106/137 vs OFF 108-111 ms p50), note createToView ON below OFF at p50 and plateau-matched (both arms climb into the same list-size plateau; n=20 cannot separate warm-up from size growth), lease.lost 0, {1:16}, OFF witness held in substance (lunch 407/407/405, all authored-only). NEW: the at-floor-derived instrument fired - the resumed counter-click revert is REACHABLE (7/8 trials, 9-11 ms window on loopback; OFF control clean) - the OW33 named residual moves from reachability-unproven to measured-real. The ask to the owner is one decision: is this bar met for the flip?"
---

# Server-execution v2 — flip-readiness dossier and the OW38(ii) benchmark

Seat: flip-dossier, worktree `/Users/berni/labs-worktrees/flip-dossier`,
branch `claude/server-exec-v2-flip-dossier`. Everything below is measured
at **main `0c0261df3`** (`0c0261df3a9c4f8fd89bdbf47bc53db01765eda3`), the
head at seat start; this seat changed no product code. Raw series, the
run ledger, and the instrument artifacts: [`flip-dossier-raw/`](flip-dossier-raw/)
beside this file. Protocol = the W4 acceptance protocol verbatim
([`stage-c/w4-acceptance-report.md`](../stage-c/w4-acceptance-report.md),
itself the re-benchmark's §2 recipe) with the deviations listed in §4.

## 0. The ask

The flip's enumerated gates (plan Phase 7 task 1, the coordination
block's item (8)) are walked in §1: **four of five hold at head**, the
fifth is this benchmark read against the owner's bar. The ON skip list
holds exactly ONE step entry — the default-app reload step, OW45 arm B,
the sibling seat's charge, in flight. Everything else on the owed-rows
ledger (§5) is follow-up class unless the owner elevates it.

**The one decision this dossier asks for (OW38 (ii)): is this bar met
for the flip?** The register's pre-recommendation on file is
"sub-second, within a small constant of OFF" on the cross-user step.
Against that wording, at this head:

- **Server settle** (the owner's ruled comparator, measured explicitly
  via `waitForSettled`/`servingLoop.settle`): all-inputs coverage p50
  **22–37 ms** across all seven ON runs (chat 25/23, lunch 26/22/26,
  note 22/37) — sub-second by 25–40×, and unchanged-to-slightly-wider
  vs W4's 15–28 ms band on a busier box (§4 loads).
- **The cross-user constant**: chat send→other-browser median ON
  376/568 ms vs adjacent OFF 258/303/305 ms — **1.2–1.9× OFF** (W4:
  1.9–2.4×). Lunch cross-user landings all sub-second (joins 253–255 ms,
  merges 309–445 ms); lunch totals ON 4.1–5.0 s vs OFF 3.7–5.0 s —
  overlapping bands.
- **Client-local speculation preserved**: the W4-FAILED sender-echo bar
  now reads **AT PARITY on chat** (ON p50 105.8/137.0 ms vs OFF
  108.0–111.3 ms; W4 had ON 1.5–2.4× OFF) — the client (e) term's cost
  collapsed (ON commitConflicts/commitReverts now 0 vs OFF's up to
  217/264; ON actionRuns 1.0–1.4× OFF vs W4's 2.8–2.9×). The one
  echo still above OFF is the lunch guest-veto (132–296 vs 36–52 ms;
  W4 saw the same residual at up to 181 ms).
- **Note createToView below OFF at p50, ending at OFF's plateau**: ON
  p50 991→**907** and 829→**525** ms; OFF 1 147–1 168 ms; both arms
  END at the same plateau (last-10 medians ON 1 201–1 246 vs OFF
  1 174–1 196) and both arms CLIMB into it — the workload's list-size
  step, not an ON-specific slope; §2c carries the honest arithmetic
  and the n=20 limit. The monotone 1→13.7 s growth witness stays gone.
- **Invariants**: `lease.lost` 0 in 7/7 ON runs; consequence
  multiplicity **{1:16}** in all three lunch stores; no `walkRuns` key
  anywhere; OFF byte-identity witness held in substance (every OFF
  store authored-only, zero derived/system rows; lunch **407 / 407 /
  405** — the adjacent pair byte-equal, the trailing rep a −2 variant;
  §2d).

Two residuals ride beside the ruling, named and non-blocking unless
elevated: (a) **OW45 arm B** (the one skip entry; the sibling seat's
starvation investigation, in flight), and (b) the owed-rows ledger
(§5) — within which one item CHANGED STATE in this dossier's own
measurement: the **at-floor-derived edge is REACHABLE** (§3) — the
resumed counter-click revert fires in 7/8 trials with a 9–11 ms
user-visible window on loopback (arrival-bound, so wider over a real
network). The register recorded this edge as mechanism-demonstrated,
reachability-unproven; it is now measured-real, and the disposition
option on file (hybrid (B)+(C) at equality) is the owner's to take or
decline.

## 1. The gates, walked at head

Gate wording: the coordination block's item (8) — "the ON skip list
back to EMPTY, OW31's ruled posture BUILT, the gate's owed rows
OW45–OW53 CLOSED, deployed binaries exercised ON, and the benchmark
against the owner's ruled bar (OW38 (ii)) — then the flip PR and the
soak." Row cites are register lines in
`docs/specs/server-side-execution/verification-coverage.md` at
`0c0261df3`.

**(1) Skip list EMPTY — ONE STEP ENTRY REMAINS.**
`tasks/server-execution-on-skips.ts` at head: `patterns` = one
step-level entry (`integration/default-app.test.ts`, step "should
persist and reload every rapidly created notebook note", phase-7, the
OW45 arm-B starvation reason); `runner` = `[]`; `runtime-client` =
`[]`; `shell` = `[]`. Every file-level skip is lifted (the last,
`pattern-and-data-persistence`, by the arrival-witness (B) build,
main `03d1a22da`). The entry's lift bar: the starvation closes and the
fixed step greens ON 10/10 quiet-and-loaded. The arm-B seat runs in
parallel with this dossier.

**(2) OW31's ruled posture BUILT — HOLDS.** Register OW31 (line 2645):
ruled 2026-08-18 (write side) + 2026-08-19 (read side), BUILT
2026-08-21 on main (the optimize train; build report
`optimize/ow31-build-report.md`, landed as PR #6156). Pins across
`memory-v2-acl-bootstrap` / `executor-cross-space` / `executor-wave` /
`v2-server-acl` / `server-execution-flag` tests; the
`home-profile-reload-durability` skip lifted 6/6 the same day; residual
(v) (shared-named-space owner transfer) ratified by the CFC owner
2026-08-21.

**(3) Owed rows OW45–OW53 CLOSED — HOLDS with two stated
qualifications.** Walked at head:

- **OW45** (line 5289) — SPLIT, as the gate's own wording anticipates:
  S-A built (with OW31), S-B closed, S-C skipped by ruling, the
  home-profile half discharged (warm request, 6/6 ON gate); the
  default-app reload step's **arm (i) CLOSED 2026-08-22** (#6198,
  test-side race; 16 greens across regimes) and **arm (ii) OPEN** —
  the client first-hydration starvation, red 3/5 loaded, store-verified
  zero data loss. Arm (ii) IS the one skip entry of gate (1) and the
  sibling seat's charge — the same residual counted once, not a second
  blocker.
- **OW46** (line 5472) — **CLOSED 2026-08-21** (`structureLoadStuck`
  counter + warn; `executor-space-server.test.ts` red-first; residual
  discharged with the 6/6 warm-request lift). Two named loss windows
  stay recorded inside the closed row: the process-crash window and
  the mid-activate-arrival sliver.
- **OW47** (line 5532) — **CLOSED, RE-OPENED, RE-CLOSED 2026-08-21**
  (the second layer-naming producer — CFC prepare's internal-verifier
  read; ruled arm (b)); re-close lift: profile-embed ON gate **10/10**
  fresh-store (the reds ran 300 s+ before), name AND bio store-durable
  per run (#6192's four hardened edges ride the row).
- **OW48** (line 5710) — **CLOSED 2026-08-21, premise REFUTED**
  (`ow48-50-wish-path-report.md` §1): the failing compiles consumed a
  STALE localhost:8000 toolshed's bytes (the exact defect #6098
  rejects); no serving-compile relaxation owed. Its §1c residual
  became OW55 (§5).
- **OW49** (line 5729) — **RULED + BUILT + LIVE-EXTINCT; the row's
  formal closure declaration is recorded as the coordinator's call and
  has not been made.** The ifc-narrowing built (#6178; the
  integer⊂number soundness hole fixed in review), 10 fresh-store ON
  runs at the ruling head show zero divergence asserts, and the row's
  own closure condition is recorded as MET. This dossier records the
  state; declaring it is not this seat's to do.
- **OW50** (line 5805) — **CLOSED 2026-08-21 (built)**: wish
  commit-prep failures surface (red-first
  `cfc-prepare-crash-surfacing.test.ts`); the throw-to-rejected-commit
  contract change RATIFIED by the CFC owner. Two open questions ride
  §5's ledger (terminal-classification of modeled CFC refusals;
  raw:wish in the browser under ON).
- **OW51** (line 5837) — **CLOSED 2026-08-21** (option 3 ruled and
  built as the scoped-absence carve-out; `executor-dprime-w0`
  P-arrival-closure watched red ×3 then 9/9 ×3; default-app ON 10/10
  with ZERO `splitDefinitions`; the #6179 review's MINOR-3 transit
  window named in the row).
- **OW52** (line 5946) — **CLOSED 2026-08-21, "NOT a loss"**: the
  storm's 23/40 was the HARNESS settle race (no server-drain step);
  append/dispatch 40/40, zero duplicates; step 5/5 + file 4/4 ON and
  OFF. The row's §7 overreach (group-chat waitFor flakes) corrected
  2026-08-22 — those were a different race, closed by
  `optimize/arrival-wait-hardening-report.md`; the row's own closure
  stands.
- **OW53** (line 5997) — **CLOSED 2026-08-22** (#6194: both halves
  implementation — the sqlite builtins consumed the runtime's ambient
  SERVICE identity where the ruled model carries the run's acting
  principal; both file skips lifted 5/5 + 5/5, #6196's fourth two-tabs
  step 4/4; the fail-closed actor-less arm and the session-identity
  join RULED 2026-08-22). Residuals recorded not closed ride §5 (the
  partition READ-RPC seam; llm-dialog's same-family reads).

**(4) Deployed binaries exercised ON — HOLDS.** The four CI ON lanes
(`.github/workflows/deno.yml`) run the full suites against the
ON-BUILT binary (`build-toolshed-on` bakes
`EXPERIMENTAL_SERVER_EXECUTION=true` into the shell; server, test
process, and baked browser shell all ON): "Package Integration Tests /
server-execution ON" (runner, runtime-client, shell) and "Pattern
Integration Tests / server-execution ON" (10 shards). At head run
(main `0c0261df3`, 2026-08-22): **all 14 ON-lane jobs SUCCESS**, and
the last 8 main runs are green through head. The register's live gates
on ON-built binaries, as its rows record them: group-chat **4/4** with
zero service-DID authored-by/represents-principal atoms (OW59, line
6433); profile-embed **10/10** (OW47, line 5668); home-profile
warm-request **6/6** (line 5376); sqlite pairs **5/5 + 5/5** plus the
#6196 step **4/4** (line 6063); pattern-and-data-persistence **10/10**
(OW33, line 3150); default-app **10/10** zero `splitDefinitions`
(line 5928); lunch **6/6** (line 5120); cellset-lww **5/5**;
convergence-storm step **5/5**, file **4/4** both arms. (This
dossier's own §2 adds 7 more ON integration runs on a freshly built
ON binary at head, all green.)

**(5) The benchmark against the owner's ruled bar** — §2, and the ask
in §0. OW38 (line 3932): half (i) LANDED with W4; half (ii) — the
numeric bar — "stays the owner's ruling; W4 reports the numbers and
does not rule". So does this dossier.

## 2. The OW38(ii) benchmark — the W4 protocol re-run at head

**Binaries** (two `deno task --no-lock build-binaries toolshed` builds
from the clean worktree at `0c0261df3` with `COMMIT_SHA` baked; both
617 263 218 bytes):

| binary | built with | sha256 (first 16) | `/api/meta` | `/api/health/stats` | toolshed log |
|---|---|---|---|---|---|
| `toolshed-off` | flag UNSET (`env -u EXPERIMENTAL_SERVER_EXECUTION`) | `f9ebb1b71038acde` | gitSha `0c0261df3a9c…`, define `null` | no `servingLoop` key | no serving-loop line; `No default model available` |
| `toolshed-on` | `EXPERIMENTAL_SERVER_EXECUTION=true` | `b04a63d0298fb621` | gitSha `0c0261df3a9c…`, define `"true"` | `servingLoop` present | `Server-execution v2: serving loop ON`; `No default model available` |

Both posture-probed before any run, then posture + gitSha read **per
run** (`meta.json` + `stats-pre.json` per run dir; every ON run define
`"true"` + `servingLoop`, every OFF run define `None` + no
`servingLoop`). LLM masking absent per run: 0 `CFTS_AI_LLM_*` keys in
env, `packages/toolshed/.env` absent, `[models] No default model
available` in every toolshed log. Per-run recipe = the re-benchmark's,
unchanged: stray-check on the port (8960 OFF₁ / 8961 ON / 8962
OFF₂,₃ — nothing foreign ever touched them) → load recorded → fresh
cwd = fresh store → binary booted `--background --log-file --port=P`
with `PORT`/`API_URL`/`MEMORY_URL` on P → posture read → ONE test file
from `packages/patterns` (`LOG_LEVEL=warn HEADLESS=1 API_URL=… 
SPACE_NAME=flipbench-<run>`, `deno test -A --no-lock
--v8-flags=--max-old-space-size=4096 --trace-leaks`, `gtimeout
--kill-after=30 520`) → post stats → load recorded → PID-only kill →
port verified free → orphan headless check (none, every run) → store
commit table by class. Load gate `wait-load 5` before every triplet
and rep (it absorbed spikes to 11.9 between groups); 10-s load sampler
per run. Two instrument smokes (chat n=3, lunch; OFF, port 8960)
preceded the ledger. **All 16 ledger runs rc=0** (full ledger with
UTC starts, loads, walls: `flip-dossier-raw/run-ledger.txt`).

### 2a. Chat two-browsers n=20 @2 s

**Arrival (send-click → the other browser renders):**

| run | arm | n | median | q1 / q3 | min / max | in-test load1 | W4 |
|---|---|---|---|---|---|---|---|
| c1a | OFF₁ | 20 | **258** | 192 / 376 | 146 / 738 | 5.4 | 217 |
| c1b | OFF₂ | 20 | **303** | 195 / 333 | 176 / 483 | 5.8 | 253 |
| c2b | OFF₃ | 20 | **305** | 234 / 347 | 173 / 494 | 4.4 | 223 |
| c1 | ON | 20 | **376** | 316 / 650 | 263 / 853 | 5.8 | 520 |
| c2 | ON rep 2 | 20 | **568** | 337 / 620 | 229 / 1 910 | 4.2 | 421 |

Per-post raw in `flip-dossier-raw/chat-series.txt`. **The ON/OFF ratio
is 1.2–1.9× (W4: 1.9–2.4×)**; ON medians straddle W4's (376 below
both W4 reps; 568 above, with one 1 910 ms outlier post at its tail
and q3 620). Both arms read higher-OFF than W4 on this box (§4
loads). The mild per-post climb remains in both arms (ON first-five
263–391 → last-five 441–853; OFF c1a 146–329 → 258–738).

**Server settle (`servingLoop.settle`; the ruled comparator):**

| run | n | value-only p50/p95/max (n) | growth n; TO LANDING p50/p95/max; (coverage p50); grace p50/p95 | event-append p50/p95 (n) | ALL-INPUTS p50/p95/max | waves/input (vo) | landing waves | W4 all-inputs p50 |
|---|---|---|---|---|---|---|---|---|
| c1 | 64 | **29** / 380 / 620 (39) | 25; **311** / 822 / 833; (18); 117 / 463 | 19 / 380 (28) | **25** / 290 / 620 | 1.23 | 4.0 | 18 |
| c2 | 64 | **24** / 351 / 743 (38) | 26; **342** / 584 / 715; (18); 119 / 322 | 21 / 351 (28) | **23** / 278 / 743 | 1.26 | 4.2 | 15 |

`settleAdvances` 54 / 53 (lastDelta 2, dropped 0). Waves 172 / 179;
`wavesBudgetExhausted` 51 / 50 (0.30 / 0.28 per wave; W4 0.41 / 0.20).
Growth-to-landing p50 311/342 vs W4's 487/314 — the tail HALVED on c1's
family. Events 28/28 appended/processed, zero purges/skips/orphans.

**Sender echo (click → the sender's OWN render; W4's one FAILED bar):**

| run | arm | n | p50 | p95 | W4 p50 |
|---|---|---|---|---|---|
| c1a | OFF₁ | 20 | 108.0 | 261.5 | 108.4 |
| c1b | OFF₂ | 20 | 111.3 | 232.1 | 113.5 |
| c2b | OFF₃ | 20 | 110.5 | 165.3 | 109.1 |
| c1 | ON | 20 | **105.8** | 271.5 | 264.4 |
| c2 | ON | 20 | **137.0** | 219.2 | 165.8 |

**The bar's FAIL condition is GONE on chat: ON ≈ OFF** (0.97× / 1.24×
at p50; W4 read 1.5–2.4×). The attribution W4 recorded — the client
(e) intent-tracking term — is corroborated extinct by the churn
counters: ON `commitConflicts`/`commitReverts`/`scheduleRunErrors`
**0 / 0 / 0** on every browser in both reps (OFF: up to 217 / 264 /
264), ON `actionRuns` 1 305–1 340 (Alice) and 920–934 (Bob) vs OFF's
920–1 348 — the 2.8–2.9× W4 excess is gone. `eventLostRaces` 0;
`overlayLateEchoDrops` 0 (W4: 1/run); `overlayCascadeEchoFlickers`
**0** on every browser; `overlayArrivalSweeps` 75/37 (c1), 83/49 (c2).

**Cross-user gate steps (StepTimer, ms):**

| step | OFF c1a / c1b / c2b | ON c1 / c2 | W4 ON |
|---|---|---|---|
| Alice save + own status | 531 / 477 / 273 | 296 / 395 | 343 / 239 |
| Bob sees Alice before save | 4 / 3 / 2 | 188 / 2 | 207 / 178 |
| cross-browser name propagation | 8 / 6 / 5 | 150 / 153 | 136 / 161 |
| message propagation (first → all) | 7 / 4 / 7 | 133 / 156 | 5 / 5 |
| lockdown propagation | 7 / 7 / 8 | 181 / 180 | 4 / 3 |
| post-lockdown message | 50 / 39 / 3 | 182 / 196 | 5 / 97 |
| room propagation (first → all) | 10 / 3 / 3 | 21 / 291 | 12 / 537 |

Flagged precisely (§4 note 6): three ON micro-steps W4 measured at
3–5 ms now read 130–200 ms (message, lockdown, post-lockdown). The
arrival MEDIANS (above) improved, so this is a step-level shape
change, not a journey regression; the candidate mechanism — the
arrival-witness (B) predicate landed the day before head
(`03d1a22da`) makes retirement wait for a strictly-above-floor or
derived-at-floor cover where the W4-era gate could retire at the
floor — is a hypothesis this seat did not isolate. Absolute values
all sub-300 ms.

### 2b. Lunch two-user vote (3 ON reps)

| step (ms) | OFF l1a / l1b / l2b | ON l1 / l2 / l3 | W4 ON |
|---|---|---|---|
| navigate + login both | 566 / 485 / 458 | 1 850 / 2 095 / 1 998 | 1 387–1 536 |
| both join lands (confirmed roster, both) | 39 / 20 / 9 | **253 / 254 / 255** | 254 ×3 |
| option A propagates to both | 38 / 9 / 43 | 33 / 14 / 534 | 368–585 |
| both cast green concurrently | 773 / 612 / 572 | 130 / 133 / 245 | 95–125 |
| both browsers see 2 love it (merge) | 11 / 10 / 9 | **309 / 436 / 445** | 305–396 |
| both voters' swatches visible on both | 1 / 1 / 1 | **1 / 1 / 1** | 1 ×3 |
| option B vote lands (3 votes) | 246 / 117 / 161 | 147 / 237 / 120 | 139–210 |
| total | 5 017 / 3 651 / 3 843 | 4 060 / 4 367 / 5 022 | 3 815–4 268 |

**3/3 GREEN**, every swatch wall 1 ms, joins at the 253–255 ms class
(W4's band exactly). Server settle: value-only p50 **22 / 18 / 20 ms**
(n=19/19/21); all-inputs **26 / 22 / 26 ms** (W4 17/20/17);
growth-to-landing p50 286 / 310 / 232 (W4 258–520). `settleAdvances`
10 / 10 / 12. Events **11/11, 11/12 (1 LT1 leftover purged), 11/12
(1 purged, 1 drain-skip)** — the (α) machinery visible, W4's shape.
Consequence multiplicity **{1:16} in all three ON stores** (verified
per store from `consequence_of`; zero MULTI rows). Flickers: host
**0 / 1 / 0**, guest 0 / 0 / 0 — the W4 floor reading, ms-class.
`lease.lost` 0/0/0.

**Sender echo per event (ms; ON l1/l2/l3 vs OFF l1a/l1b/l2b):**

| echo | OFF | ON | W4 ON |
|---|---|---|---|
| host-join | 72 / 60 / 54 | 81 / 77 / 78 | 83–196 |
| host-add-option-A | 228 / 89 / 89 | 115 / 114 / 121 | 74–83 |
| guest-join (speculative) | 93 / 40 / 40 | 80 / 70 / 83 | 41–63 |
| guest-veto-B | 47 / 52 / 36 | **132 / 252 / 296** | 42–181 |

The joins hold at-or-near OFF; **the veto echo remains the one
above-OFF echo** (2.5–8.2× OFF, worse at the top than W4's max 181 ms
— the W4 residual, persisting, absolute values sub-300 ms).

### 2c. Note-create n=20 single-user

| run | arm | n | createToView p50 / p95 / min / max | first-10 med → last-10 med | W4 p50 |
|---|---|---|---|---|---|
| n1a | OFF₁ | 20 | **1 147** / 1 200 / 256 / 1 279 | 325 → 1 174 | 1 193 |
| n1b | OFF₂ | 20 | **1 168** / 1 252 / 314 / 1 312 | 379 → 1 196 | 1 100 |
| n2b | OFF₃ | 20 | **1 159** / 1 256 / 265 / 1 290 | 397 → 1 184 | 1 178 |
| n1 | ON | 20 | **907** / 1 428 / 267 / 2 145 | 751 → 1 246 | 991 |
| n2 | ON rep 2 | 20 | **525** / 1 874 / 246 / 2 852 | 471 → 1 201 | 829 |

Raw series in `flip-dossier-raw/note-series.txt`. **ON below OFF at
p50 in both reps, and PLATEAU-MATCHED — read with the honest
arithmetic, not a bare "flat":** both arms CLIMB into the same
plateau. By first-10→last-10 medians the OFF arms rise 3.0–3.6×
(325→1 174, 379→1 196, 397→1 184 — the workload's known list-size
step: n1a's raw series jumps 256→1 166 at note 7) and the ON arms
rise 1.66× and 2.55× (751→1 246, 471→1 201), ENDING at OFF's plateau
(1 201–1 246 vs 1 174–1 196) with no ON-specific excess above it.
What the bar's wording measures — a slope ≈ OFF's, no unbounded
ON-side growth — holds: the re-benchmark's monotone 1→13.7 s witness
stays gone, and the last-10 medians of the two arms coincide. What
n=20 CANNOT do is separate warm-up from size-dependent growth within
the series (the ON arms start higher and climb less; a longer-series
leg is a cheap follow-up if the owner wants it before ruling — flagged,
not filled). **Both ON note runs passed the
browser-console gate** that failed rc=1 in W4 on the pre-existing
`splitDefinitions` error — that error is extinct at head (OW51's
build; the ON run's 10/10-zero-occurrences gate is the register's).
Server settle: value-only p50 **20 / 19 ms** (n=86/85); all-inputs
**22 / 37 ms** (W4 28/22); growth-to-landing p50 **264 / 306** (W4
454/438 — improved); event-append p50 16 / 17 (n=86/85).
`settleAdvances` 64 / 57. `undemandedNarrowingRuns` **63 / 49** (W4
57/53 — the flag-5 shape, unchanged). Events 86/87 (3 drain-skips)
and 85/85 (10 drain-skips), purges/refusals/orphans 0.

### 2d. The §7 (d′) block, OW37, and the OFF witness

Per ON run (`flip-dossier-raw/<run>.demand-block.json`): chat
`demandedRows` 2 279/2 303, `demandedWriters` 223/223 (W4's exact
figure), `demandRootEnters` 223, leaves 0, `demandPassMs` **9.0/9.0
ms per pass** (W4 4.8–11.3); `pushGrowthWakes` 134–161 vs
`watchWakes` 247–251. **No `walkRuns` key in any run's stats**
(asserted over the full JSON per run). `demandArrivals` 54/44 (chat),
20–21 (lunch), 0 (note; the OW33-era note shape). `warmRequests` 0
everywhere (no park in these journeys).

**OW37 re-read** (derivedCommits / (authoredSeen − effectAcks), raw
and advance-subtracted):

| run | raw | minus advances | budget | ON store commits (a+d) | OFF stores |
|---|---|---|---|---|---|
| chat c1 | **2.69** | **1.84** | ≤2 pure | 236 (64+172) | 611 / 609 / 611 |
| chat c2 | **2.80** | **1.97** | ≤2 | 243 | |
| lunch l1 | **2.07** | **1.70** | ≤2 | 83 (27+56) | 407 / 407 / 405 |
| lunch l2 | **2.15** | **1.78** | ≤2 | 85 | |
| lunch l3 | **2.30** | **1.85** | ≤2 | 89 | |
| note n1 | **3.00** | **2.31** | ≤3 effectful (acks 20) | 392 (113+279) | 953 / 989 / 989 |
| note n2 | **2.85** | **2.24** | ≤3 | 378 | |

**The bound holds on the advance-subtracted reading in every run**
(W4's c1 read a hair over at 2.16; every run here is under). Total ON
store commits stay 2.5–4.6× BELOW OFF.

**OFF byte-identity witness:** every OFF run's stats carry NO
`servingLoop` key (pre and post, asserted per run); every OFF store is
authored-only (zero derived/system rows). Lunch **407 / 407 / 405**
(per the committed ledger: l1a and l1b byte-equal at 407 with the
principal space at 403; the trailing l2b a −2 variant at 405,
principal space 401) — so the byte-equal-across-reps property held
for the adjacent pair and NOT for the trailing rep, a run-to-run
variance of the same kind the note family already shows; the W4-era
recorded family was 398 ×3 (the workload itself moved in the
intervening merges). Chat 611/609/611 (W4: 608/612/612 — the same ±4
family). Note 953/989/989 (W4: 971/989/971 — 989 reproduced exactly
twice; 953 a variant of the recorded bimodal kind). The witness's
hard half — authored-only stores, no derived or system rows anywhere
OFF — holds without exception. This seat did not
re-run the OFF runner suites (§4 note 3) — the ON lanes and default
lanes at head (gate 4) carry the suite-level witness.

**Engagement (the "never report a zero-read leg as parity" rule):**
every ON leg's serving loop demonstrably engaged — derived commits
56–279 per run, settle series n=27–113, `demandedWriters` 223 (chat),
events processed 11–87 — and every OFF leg demonstrably did not (no
`servingLoop` key, authored-only stores). No zero-read leg is quoted
as parity anywhere above.

## 3. The at-floor-derived instrument — the edge is REACHABLE

The register's OW33 named residual (line 3169; the fork memo's
"Named residual" block): an event-handler echo on a RESUMED instance
whose floor equals the prior session's wave-commit seq retires through
the sweep gate's backstop on that derived-class cover — a flash-revert
window until the served consequence lands. Recorded state:
"mechanism demonstrated in review; **reachability unproven**";
confirming instrument on file: "a resumed counter-click at the true ON
topology — check whether the sealed echo's floor equals the target's
confirmed cover, and measure the revert window."

**Run here (external-observation form): the edge FIRES.** Instrument:
an untracked runner-level script (source snapshot:
`flip-dossier-raw/atfloor-instrument.ts.txt`; it lives outside the
test suites and changes nothing) — per trial, session A creates a
1-per-click counter piece in a fresh space, clicks once, waits for the
durable value 1, disposes; session B (fresh runtime, same space)
resumes the piece by entity id (`getCellFromEntityId` +
`runtime.start`, the persistence test's Phase-4 idiom), attaches a
value sink, then clicks as its FIRST interaction and logs every
observed value transition. A 2 → 1 → 2 sequence after the click is
the revert window, sink-to-sink.

| arm | trials | reverts | windows (ms) | click→first-echo (ms) | hydration |
|---|---|---|---|---|---|
| ON (`toolshed-on`, posture verified) | 8 | **7** | 9, 10, 10, 10, 11, 11, 11 | 7–10 | 0 ms ×8 |
| OFF control (`toolshed-off`) | 2 | 0 (obs `[1,2]`, clean) | — | 6–8 | 0 ms ×2 |

Seven of eight ON trials observed `[1, 2, 1, 2]`: the echo lands in
7–10 ms, retires ~9–11 ms later back to 1, and the served consequence
restores 2. The OFF control never reverts. The eighth ON trial read
pre-click 0 (its resumed hydration raced the prior consequence's
client arrival) and went `[0, 1, 2]` clean — a different shape — and
logged one `SES_UNHANDLED_REJECTION: Document of:fid1:gqApGg… was
delivered with a broken schema ref: cid:fid1:Ta0kc8… is not delivered
and verified in this replica`, recorded verbatim (one occurrence,
non-fatal, not chased; log: `flip-dossier-raw/atfloor-instrument-on.log`).

**Reading, honestly bounded:** the externally-observed signature —
resumed instance, first interaction, echo retires before the served
consequence, consequence restores — matches the flagged mechanism's
construction exactly, and only under ON; the instrument does NOT
internally verify the floor-equality (the sealed echo's floor vs the
cover's seq), so a different retirement path producing the same
visible revert is not excluded. The measured window is
**arrival-bound**: 9–11 ms on quiet loopback ≈ the served settle+push
gap, so it widens with real network latency. Two instrument
limitations in the as-ran revision (both found in review, neither
undermining the measured verdicts): the B-click's `editWithRetry`
result was not awaited — it resolves `{ok}|{error}` rather than
throwing, so a rejected click could in principle read as a false
"no revert" — and a trial that threw skipped its dispose/close
cleanup. Neither bit here: every counted trial's FINAL value was 2,
which is the click's own consequence landing (a rejected click cannot
produce it), and zero counted trials errored. The live worktree copy
is hardened (awaited click with fail-on-error, try/finally
lifetimes); the committed snapshot stays byte-verbatim as-ran with a
marked annotation header. The register's
"reachability unproven" no longer holds — the row should say
**observed, 7/8 at head, window measured** — and the disposition
option already on file (hybrid (B)+(C) at equality: derived-class AND
cover seq not in the entry's basis-seq set) is the owner's decision.
This dossier changes no register text; the coordinator folds this in
with the ruling.

## 4. Deviations from the W4 protocol (verbatim)

1. **Loads.** W4 quoted no latency above 1-min load 5. This box's
   ambient (a resident ~100%-CPU daemon pair) sat at 4.2–5.8 all
   session; in-test 1-min maxima ran 4.5–8.5 (worst: n1a's 8.48; the
   note runs 5.2–8.5, chat 4.5–6.9, lunch 4.6–5.6). The gate held
   run STARTS below 5 (it absorbed spikes to 11.9 between groups);
   both arms of every adjacent pair ran in the same band, so the
   ON-vs-OFF comparisons stand; the W4-absolute comparisons carry
   this load handicap — which makes the improvements conservative,
   not inflated. Full per-run loads: the ledger + per-run
   `load-samples.txt` (worktree).
2. **The ON note runs skip the reload step** (the OW45 arm-B entry,
   `1 step ignored` in both ON runs' output) — W4's pre-skip ON runs
   executed it. The createToView series precedes that step and is
   unaffected; ON-vs-OFF store totals on note are not
   step-count-comparable at head (OFF runs the step, ON does not).
3. **The OFF runner-suite re-run was not repeated here** (W4 §5 ran
   the full runner population OFF at its tip). The head's default
   lanes and ON lanes (gate 4, all green at `0c0261df3`) carry the
   suite-level witness; this seat's OFF evidence is the per-run
   posture + store-class witness.
4. **The instrumented per-note client `scheduler/run` pair (W4's
   n3p/n3pb) was not repeated**; bar-4 evidence here is the primary
   series' plateau match and ON-below-OFF p50s (§2c's arithmetic).
5. **Percentiles** are nearest-rank (sorted[ceil(q·n)−1]) computed
   from the dumped settle series; the in-test `[chat-series]` and
   `[sender-echo]` summary lines are the HARNESS's own statistics —
   its n=2 p50 reads as the upper of the two samples (visible in the
   lunch echo summaries), which is why §2b's lunch echo table quotes
   the per-event values directly, and at n=20 (chat) the two
   conventions coincide to within one rank.
6. **The two instrument smokes ran on the FIRST binary pair** —
   source-identical builds from the same clean worktree, made before
   the `COMMIT_SHA`-baked rebuild (which is why smoke0-chat's ledger
   entry records sha `db152c149819e559` and probe `gitSha=?`);
   smoke0-lunch and every ledger series run used the rebaked pair
   (`f9ebb1b7…` off / `b04a63d0…` on). Smokes are instrument
   validation, never series data; the ledger records what actually
   ran, so the entry stands with this annotation (also carried in
   the ledger's header).
7. **Three chat ON micro-steps read 130–200 ms where W4 read 3–5 ms**
   (message/lockdown/post-lockdown propagation) while the arrival
   medians improved — flagged in §2a with the (B)-predicate
   hypothesis, not isolated here.
8. **The at-floor instrument** (§3) is this dossier's addition (the
   register's named instrument, run in external-observation form);
   its 8-trial ON run + 2-trial OFF control ran outside the ledger's
   triplet discipline, gate-checked at load 3.1, fresh spaces per
   trial, one fresh-store server boot per arm.

## 5. The owed-rows ledger (open follow-ups; none flip-blocking unless the owner elevates)

| item | row / cite | state | blocking? |
|---|---|---|---|
| OW45 arm B — default-app first-hydration starvation | OW45 (5289); the ONE skip entry | OPEN; sibling seat in flight; store-verified zero data loss | **YES — the skip-list-EMPTY gate hangs on it** |
| OW58 — consequence-notice resolved-error guard wedge | OW58 (6354) | OPEN; probe-confirmed, pre-existing since Phase 3; code fix owed its own (α)-critical pass | no (owner: next seal pass or first live sighting) |
| OW57 — the α3 gate-race test construction | OW57 (6320), CT-2060 | OPEN; #6184 hardened, reduced-not-eliminated (14/15 + 1 identical red) | no (test-harness class) |
| Served-terminal RowLabelCommitError seal | inside OW54 (6199) | VERIFIED sibling, deliberately out of scope: wave-rejected arm requeues + re-drains (two paths, one fate); the direct-commit arm alone terminal-classifies | no |
| Byte-binding / compiled-cache integrity | OW56 finding 1 (~6266) | OPEN; owner ruled FOLLOW-UP ("we're not in prod yet"); recommended small fix = bind the bytes | no (owner-ruled follow-up) |
| OW55 — API_URL pattern-fetch trust | OW55 (6215) | OPEN; flip-follow-up family, no lift trigger | no |
| OW56 — server-owns-compilation end state | OW56 (6235) | FUTURE row (the owner's ideal on record); finding 2 (dual-write) an efficiency follow-up | no |
| llm-dialog identity family | OW53 residuals (6068) + OW59 out-of-scope | OPEN; same family as the sqlite fix, no ON surface pins it yet; + the bare `llmDialog:` effect keys quirk | no |
| OW60 — the echo-drop smell | OW60 (6455) | OPEN; ~2/10 occurrence, absorbed by the barriered capture; board stays correct; spec decision (OW51 disposition?) unruled | no |
| At-floor-derived edge + instrument | OW33 named residual (3169) | **STATE CHANGED by §3: reachable, 7/8, window 9–11 ms loopback**; disposition option on file (hybrid (B)+(C)) awaits the owner | no, unless the owner elevates on §3's numbers |
| Transient prep-crash re-drain question | inside OW54 (6189) | OPEN, unruled (as-built: transient prep-crashes seal terminal error); on the owner's one-liner list | no |
| sqlite partition READ-RPC residual | OW53 residuals (~6086) | OPEN; flagged-not-filled; blocks the session split's live completion coverage, no live surface reaches it | no |
| Read-through hash obligation | speculation.md:47–54 (not a register row) | PINNED obligation inherited by the arrival-witness train's read-through work | no |
| OW49 closure declaration | OW49 (5729) | Conditions recorded MET; the declaration is the coordinator's call, outstanding | no (a formality, but gate (3)'s wording reads cleanest once made) |

## 6. Files and pointers

- This dossier:
  `docs/history/plans/server-execution-v2/optimize/flip-readiness-dossier.md`.
- Raw (committed, small): [`flip-dossier-raw/`](flip-dossier-raw/) —
  per-ON-run `settle-series` / `settle-advances` / `demand-block`
  JSON (7 runs), `run-ledger.txt`, `chat-series.txt`,
  `lunch-steps.txt`, `note-series.txt`, the at-floor instrument's ON
  log + source snapshot.
- Big artifacts (worktree, untracked, not committed): per-run dirs
  with `test.log`, `toolshed.log`, `meta.json`, `stats-pre/post.json`,
  `load-samples.txt`, and every run's sqlite store, under
  `/Users/berni/labs-worktrees/flip-dossier/.bench-artifacts/runs/<run>/`,
  beside the driver scripts and `sha256.txt`. The binaries themselves
  were deleted after the runs (disk); their build recipe (§2) and
  sha256 (ledger + §2's table) reproduce them.
- Protocol ancestry: [`../stage-c/w4-acceptance-report.md`](../stage-c/w4-acceptance-report.md)
  (and through it the re-benchmark's §2 recipe); comparator ruling:
  the plan's measurement-caveat bullet + register OW38.
- The coordination state this dossier feeds: the plan's Phase 7 task 1
  and the coordination block's item (8).
