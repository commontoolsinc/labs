---
status: historical
created: 2026-08-18
archived: 2026-08-18
reason: "Stage-C evidence: the instrumented attribution of the first benchmark's verdict — the two dominant latency terms (per-demander demand walk; client whole-sidecar intent watch), the lease feedback loop, and the client arrival gate holding a correctly served value; the tuning-vs-design split."
---

# Stage C — deep attribution of the ON-vs-OFF verdict (server-execution v2, fan-out B tip)

Date: 2026-08-18 (runs 20:26 PDT 08-17 → 09:10 PDT 08-18). Branch
`claude/server-exec-v2-fanout-b`; worktree `/Users/berni/labs-worktrees/attrib-c`
detached at the tip **`fb2292a24`** (above `59b5329ae`: only the tasks-import-map
CI fix `a73147f75`/`fb2292a24`; above `33dcab8e2`: `f5a0cac5c` test pin +
`a2954dec5` deno.yml fix — `git diff --name-only 33dcab8e2..fb2292a24` =
`.github/workflows/deno.yml`, `deno.lock` (+2 lines, `tasks` workspace only),
`tasks/ci-workflow.test.ts`, `tasks/deno.jsonc`, `packages/runner/test/executor-cross-space.test.ts`
— **runtime byte-identical to 33dcab8e2 and 59b5329ae**; `fadc2efb1b` differs
from all of them only by the F5 revert in `data-updating.ts`/`runner.ts`).
REPORT ONLY: temporary instrumentation (`SX_TRACE` one-line traces in
`packages/runner/src/executor/space-server.ts`, `packages/memory/v2/server.ts`,
`packages/runner/src/scheduler/run.ts`, and a bounded chip-render probe in
`packages/patterns/integration/cfc-group-chat-demo-two-browsers.test.ts`) was
built into a scratch binary only, **fully reverted** at the end (§7), nothing
pushed, no comments. Raw artifacts (driver/test/toolshed logs, `/api/health/stats`
pre/post, per-run sqlite stores, client CPU profiles, parsers) live in the session
scratchpad `…/0e87bf81-…/scratchpad/attrib/{runs,cpuprof,cpuprof-off,*.py}`;
the benchmark's own artifacts are beside them under `…/scratchpad/benchc/runs/`
and the 08-17 green-run artifacts (builder `fo/store-on*`, reviewer
`rfb/store-tb*`, fixer `gate/store-tb*`) under the exciting-kalam session
scratchpad. Binaries: the benchmark's `toolshed-on` (59b5329ae, sha 028b0a07…)
and `toolshed-off` were reused (runtime-identical to the tip — verified by
diff above); the instrumented ON binary was built fresh from attrib-c
(`gitSha fb2292a24…`, `shellServerExecutionDefine:"true"`, `servingLoop`
present on every run). Every run: fresh cwd/store, private ports 8960/8961,
posture read from `/api/meta` + `/api/health/stats` before and after, load
sampled every 10 s, toolshed PID killed, port verified free, no orphaned
headless shells (0 in every run). Box load was 3.3–7.7 (1-min) — another
session was running suites concurrently; each run's load is in its driver log.

## 0. Verdicts in one screen

1. **Regression vs steady state → STEADY STATE, bimodal, and the 08-17 greens
   were MASKED.** The two-browsers ON gate fails at the same step (Alice's own
   lockdown chip never re-renders) in 5 of 12 night attempts across three
   binaries whose runtime is byte-identical (t1, smoke0, A1 = 300-s stalls; D4,
   E2 = 45-s stalls caught by the probe) and in 0 of 7 daytime attempts. The
   daytime environment had a configured default LLM model
   (`Default model: anthropic:claude-sonnet-4-6` in every 08-17 start log vs
   `No default model available` in every night log) and its browsers wrote 11–15
   large system-piece (SummaryIndex) authored commits per run every 5–10 s; each
   such unrelated input re-triggers the very path that is stuck (§4), so the
   stall could never last more than a few seconds by day. The test file and
   helpers are unchanged since 08-15/08-12; nothing between 33dcab8e2 and the tip
   touches runtime code, so there is nothing to bisect. Cross-user step latencies
   (2–7 s per served step) are identical in every green run, day and night.
2. **The wave-latency dominant term is not the flush deadline and not
   `structureLoadTerminal`; there are two dominant terms, one per side.**
   Server: the per-demander **demand-walk effects** (`demand-walk:<space>/<root>`),
   20–250 ms each × (sessions+users) instances × every root whose subtree a
   commit touched — 96 % of an event wave's settle (chat event waves 2.6–3.6 s;
   the 100-ms deadline fires 2.5–8.3 s LATE because the walk loop never yields a
   macrotask, so `wavesBudgetExhausted` is a symptom, not a bound). Client: the
   speculation overlay's intent-tracking sink over the whole, ever-growing
   stream-events sidecar; every fire commits a transaction whose CFC
   flow-relevance probe (`flowLabelWorkExists` → `forEachFlowObservation` →
   `isPrefix`) is O(reads × dereference traces) and runs TWICE per commit — 65 %
   of a 100 %-busy client worker by note 10 (13.1 s of 20.2 s); the ON client's
   `scheduler/run` per note grows 0.6 s → 15.5 s while the OFF client's stays at
   ~80 ms. The serving loop is idle ~90 % of the note run: the note-create
   slowdown (1.5 → 25 s) is client-side.
3. **Lease feedback loop: CONFIRMED as a mechanism from t2's log (11 episodes,
   `wave-commit-rejected` then `lease-lost` on all 3 spaces within 10 ms — the
   whole process's renew timers starved together; settle p95 11.9 s / max 16.2 s),
   NOT triggered in my 10 traced runs (lease.lost 0) but with a thin margin
   (renew gaps up to 10.0 s against a 15-s TTL; deadline lateness up to 8.3 s).**
   Design-parameter issue: renew rides the same macrotask queue the walk loop
   starves.
4. **The chat "no-op" is refuted — the served toggle ran ONCE, wrote the toggled
   state, and the frame was PUSHED to Alice; Alice's client held it.** In E2 the
   toggle event (seq 48, 16:04:13.5) → one handler dispatch → derived commit seq
   50 at 16:04:18.18 (`adminRegistry.everyoneIsAdmin=false`, chip@user:Alice =
   "Can manage admins", chip@user:Bob = "Manager off") → flush#51 SENT 14/15
   upserts including the chip doc in Alice's user scope to BOTH of Alice's
   sessions at 16:04:18.196/.225. The DOM stayed "Everyone is admin" for 48 s;
   `viewSettled()`/`rt.idle()` returned in 1–3 ms and changed nothing; Bob's
   unrelated draft (16:05:04) → the next watermark-advance frame to Alice
   (16:05:06.48) → chip rendered within 4 s. Wake/push-liveness triage: link (a)
   serving loop — NOT quiet (wave committed, W advanced); link (b) push — NOT
   quiet (frame emitted); **link (c) the client's arrival/coverage gate — QUIET.**
   Not multi-dispatch (6 events → 6 dispatches → 6 consequence commits in every
   red chat store), not the F4 served-wish class; a stage-C-lunch `nowTick` fix
   would not touch it. Green runs pass at 1–3 ms after the click = the client's
   speculative echo, not the served result.
5. **Split: three tuning-class fixes buy the most immediately (single CFC probe
   per commit; renew/deadline off the starved queue; retirement re-sweep on
   arrival of the derived frame), but the two costs that grow with content and
   sessions are design-class (per-demander demand walk × roots; client
   intent-tracking over the whole sidecar with a CFC probe per fire).** Fix arc
   in leverage order in §5.

## 1. Regression or steady state — the run ledger

### 1a. What was actually green on 08-17 (and where the "3/3 / 2/2" came from)

The verify report at 33dcab8e2 did **not** run the two-browsers gate ("Not run
this pass (out of scope): … the two-browser gates"). The greens were: builder
3/3 (`fo/store-on2,3,4`, 09:26–10:25 PDT, binary at the build tip; 1m08/1m21/1m23),
reviewer 2/2 (`rfb/store-tb1,2`, 13:08/13:11, 1m02/57 s), fixer 2/2
(`gate/store-tb1,2`, 15:41/15:42, binary `fadc2efb1b`, 1m53/56 s). All seven
were run from a shell whose toolshed logged `Default model: anthropic:claude-sonnet-4-6`
and `Configured to remote storage: http://localhost:8000` (MEMORY_URL unset →
the long-running dev toolshed on :8000; the serving loop and browsers are
unaffected by that, the toolshed's own runtime is). Every night run (benchmark
and mine) logged `No default model available` and `remote storage: http://localhost:<own port>`.

Step timings of the seven greens are the SAME class as the night runs' partial
steps: Alice save 1.3–4.8 s, Bob save 1.0–14 s, cross-browser name propagation
0.007–6.1 s, message propagation 0.002–3.9 s, lockdown propagation 0.002–4.8 s,
post-lockdown message 4.0–12 s (bimodal 3 ms vs seconds — the 3-ms values are
the client's speculative echo, see §4). Latency is steady state; only completion
differs.

### 1b. Ledger — every two-browsers ON attempt on 08-17/18 (default gate params unless noted)

| # | when (PDT) | binary / runtime | load 1-min | result | note |
|---|---|---|---|---|---|
| builder ×3 | 08-17 09:26–10:25 | build tip | n/a | GREEN 3/3 | day env (LLM model, churn) |
| reviewer ×2 | 08-17 13:08–13:11 | review tip 7ddcfa967 | n/a | GREEN 2/2 | day env |
| fixer ×2 | 08-17 15:41–15:42 | fadc2efb1b | n/a | GREEN 2/2 | day env |
| bench smoke0 | 08-17 18:4x | 59b5329ae (series 3) | 10.6 | RED lockdown stall 300 s | store toggled; chip never rendered |
| bench t1 | 08-17 18:57 | 59b5329ae (series 20) | 5.7 | RED lockdown stall 300 s | same |
| bench t2 | 08-17 19:32 | 59b5329ae (series 20) | 3.9 | RED from t≈0 | lease churn (§3), piece-start ConflictError + sync-load-failure |
| bench abl-f5 | 08-17 19:07 | fadc2efb1b (series 20) | 11.3 | killed at 8 m | lease-lost / wave-commit-rejected in log |
| A1 | 08-17 20:26 | 59b5329ae plain, default params | 3.3 | RED lockdown stall 300 s | store toggled at seq 51 (chip@user:Alice "Can manage admins"), never rendered |
| B1 | 20:40 | tip, instrumented (SX_TRACE) | 3.4 | GREEN 44 s | trace: derived frame incl. chip pushed to Alice |
| C1 | 21:13 | tip, instrumented | 6.3 | GREEN 39 s | |
| C2 | 21:14 | tip, instrumented | 4.5 | GREEN 41 s | |
| D1–D3 | 08:52–08:56 (08-18) | 59b5329ae plain + chip probe (probe reader bug) | 5.9–6.8 | GREEN after the 45-s hold | probe unreadable; not counted either way |
| D4 | 08:59 | 59b5329ae plain + probe | 7.7 | **RED-STATE caught**: chip stuck 45 s; viewSettled/rt.idle no effect; Bob's draft nudge → rendered <4 s → GREEN | |
| D5 | 09:01 | 59b5329ae plain + probe | 7.3 | GREEN, chip flipped at 1 ms (echo) | |
| E1 | 09:02 | tip instrumented + probe | 6.1 | GREEN, 3 ms | |
| E2 | 09:03 | tip instrumented + probe | 7.1 | **RED-STATE caught** (as D4), full server trace | §4 |
| E3 | 09:05 | tip instrumented + probe | 7.4 | GREEN, 2 ms | |

Night completion of the DOM-only lockdown wait: 5 stalls / 12 attempts (t1,
smoke0, A1, D4, E2), across 59b5329ae plain, fadc2efb1b and the instrumented tip
— **the gate is bimodal at best on this tree, ~40 % stall rate on a quiet
space, and the outcome is independent of load (A1 red at 3.3, D5 green at 7.3)**.
Test/harness delta since the greens: none (`cfc-group-chat-demo-two-browsers.test.ts`
last changed 08-15 P7 B5; `cfc-browser-helpers.ts`, `pieces-controller.ts`,
`packages/integration`, `cfc-group-chat-demo/*` last changed 08-11/12).
Bisecting 33dcab8e2 → tip is moot (no runtime change); the same stall
reproduces at fadc2efb1b (abl-f5) and at 59b5329ae. Verdict: **steady state,
masked by daytime background churn** (each of the 11–15 unrelated client
commits per green run advances W and re-sweeps the client's overlay — exactly
the "nudge" that unstuck D4/E2 in <4 s).

## 2. The wave-latency mechanism (instrumented breakdown)

Instrumentation: per-wave phase timers around `#waveCycle` (feed drain, event
drain, structure-load pass, `runtime.idle()`, `server.idle()`, `inputSynced`,
deadline lateness, watermark tx, seal chain, `commitWave`, `settled`, push
note, outbox), scheduler-timing deltas per wave (`scheduler/run*` totals),
per-run traces ≥15 ms with the action id and fan-out instance, resubscribe
traces with union-log read counts, `#loadDemandedStructure` per-pass counters,
lease-renew cadence, and the memory-server push path (`noteExecutorCommit`,
flush batches, per-session `sync` decisions and `send`s). Client side: the note
test's own capture knobs (`CF_CAPTURE_NOTE_CREATE_PROFILE_SERIES`,
`CF_CAPTURE_ACTION_RUN_SERIES`, `CF_CAPTURE_NOTE_CREATE_CPUPROFILE_SERIES`) on
ON (N2) and OFF (N3), same n=12.

### 2a. Server per-wave phase totals — note-create ON n=20 (N1: 17 notes in 560 s, 689 waves on 2 spaces)

| phase | total ms | % of wave wall |
|---|---|---|
| wave wall (Σ over 689 waves) | 48 404 | 100 |
| settle (deadline race) | 42 024 | 86.8 |
| ├ scheduler runs during the wave (Δ `scheduler/run`) | 18 856 | 39.0 |
| │  ├ action bodies | 9 978 | 20.6 |
| │  ├ resubscribe | 2 944 | 6.1 |
| │  └ commit | 794 | 1.6 |
| ├ `server.idle()` (memory-server flush drain inside the settle) | 14 506 | 30.0 |
| ├ `runtime.idle()` wait (overlaps runs) | 11 481 | 23.7 |
| ├ structure-load pass (owned) | 1 783 | 3.7 |
| └ `inputSynced` | 228 | 0.5 |
| event drain | 663 | 1.4 |
| `commitWave` | 2 051 | 4.2 |
| watermark tx / seal chain / event notice / settled / outbox | 21 / 0 / 0 / 0 / 0 | ~0 |
| exhausted waves | 122 / 689 (all 54 event-carrying waves + 68 zero-delta) | |
| deadline lateness on exhausted waves | p50 125 ms, p90 443 ms, max 1 155 ms (Σ 21.5 s) | |

The serving loop's total wave time is **48 s of a 560-s run**: in 10-s buckets
it is busy 0.5–4.8 s per bucket (5–25 %) and sits in `#waitForInput` the rest —
**the note-create latency is not the server's**. The per-note round trip seen
from the server is: event wave (0.5–1.3 s) → push → 2–8-s gaps with no server
activity → the client's next subscription/commit → small waves → 8-s gap → …
(timeline 200–262 s in `parse-waves.py` output). `structureLoadTerminal`
growth is a per-new-root one-time probe (2–8 ms per pass, 1.8 s total): the
benchmark's hypothesis that terminal roots are re-walked every wave is refuted;
what does grow is `watchedRootsForSpace` (585 → 1 147 roots) and the demand
walks over them.

### 2b. Server per-wave — chat event waves (two-browsers, tip)

| wave | settle ms | runs | run ms (act / resub / commit) | deadline late by |
|---|---|---|---|---|
| B1 wave#95 (Bob save consequences) | 2 677 | 47 | 2 612 (1 519 / 974 / 101) | 2 578 ms |
| B1 wave#100 (toggle event) | 3 495 | 122 | 3 415 (2 162 / 1 006 / 199) | 3 395 ms |
| E2 wave#93 (pre-toggle re-walks) | 3 572 | 25 | 3 517 (2 277 / 1 075 / —) | 3 473 ms |
| E2 wave#94 (toggle event, seq 49/50) | committed 4.7 s after the append; the trailing settle above ate the deadline | | | |

Runs ≥ 15 ms by action class over whole runs: **E2: `demand-walk:*` 573 runs,
27.5 s (avg 48 ms), plus 263 resubscribes 17.7 s with union logs up to 67 155
reads; every other class < 0.1 s.** C1: 388 walks 14.9 s + 195 resubs 9.5 s. N2
(note): 137 walks 7.0 s + 74 resubs 2.9 s (max 38 600 reads); `raw:wish` 2 × 213 ms.
Instances per walk in chat: 3 (Alice's two sessions + Bob's user); roots
watched: chat 585–634 (232–249 keys), note 1 031–1 147. So the server-side
per-wave dominant term is **the fan-out-B per-demander demand walk: O(roots
touched × demanders × subtree reads) per change, re-run on every commit that
touches anything under a demanded root, followed by an O(reads) resubscribe of
the union log.** The `runsΔ ≈ settle` and `dlLate ≈ settle` columns show the
100-ms flush deadline is nominal: the settle's `runtime.idle()` drives the
scheduler's walk loop without a macrotask boundary, so the deadline timer (and
the lease-renew timer, §3, and the 5-ms push flush timer) can only fire after the
loop drains — `wavesBudgetExhausted` measures how often waves exceed 100 ms, it
does not bound them.

### 2c. Client side — where the note-create seconds go (N2 ON vs N3 OFF, n=12, same test/knobs)

Per-note client `scheduler/*` totals (worker, from the test's profile capture; ms):

| note | ON run | ON run/commit | ON run/action | ON resub | OFF run | OFF action |
|---|---|---|---|---|---|---|
| 1 | 636 | 399 | 195 | 30 | 136 | 98 |
| 4 | 5 222 | 4 150 | 734 | 310 | 72 | 46 |
| 7 | 8 950 | 7 344 | 1 050 | 526 | 75 | 46 |
| 10 | 14 735 | 12 039 | 1 670 | 930 | 87 | 51 |
| 12 | 15 547 | 12 799 | 1 753 | 972 | 77 | 47 |

Client createToView/returnToHome (ms): ON N2 notes 1..12: 1585/448, 4077/147,
2817/2099, 4246/3163, 5624/2932, 5977/674, 10740/757, 6848/957, 5292/6315,
7905/11510, 14292/2308, 11038/10659; OFF N3: 457/70 … 1151/2553 (total per note
0.5–3.7 s). Worker CPU profile, note 10: **ON wall 20 160 ms, sampled 20 159 ms
(100 % busy)** — `flowLabelWorkExists` 13 059 ms inclusive (64.8 %),
`forEachFlowObservation` 11 999 ms, `isPrefix` 9 005 ms self (44.7 %); caller
chains: `finalizeSchedulerAction → finalizeReactiveActionCommit →
startReactiveActionCommit → prepareTxForCommit → flowLabelWorkExists` 5 309 ms
AND `… → commit → flowLabelWorkExists` 5 361 ms (the probe is evaluated twice per
transaction: `Runtime.prepareTxForCommit` and again in
`ExtendedStorageTransaction.commit()` when the first found nothing), plus
`send → set → trackIntent → sink → subscribeToReferencedDocs → sinkHelper →
prepareTxForCommit/commit → flowLabelWorkExists` 1 311 ms; `handleRequest`
(shell IPC) 3 673 ms (`handleCellGet` 1 858, `handleCellSend` 1 716);
`createViewProxy` 2 801 ms. **OFF note 10: 3 196 ms wall; `flowLabelWorkExists`
absent from the profile; `handleCellGet → convertCellsToLinks/createViewProxy`
1.6 s.** Trend ON notes 2..11: `forEachFlowObservation`/`isPrefix` = 49 %, 47 %,
42 %, 42 %, 52 %, 45 %, 36 %, 36 %, 40 %, 39 % of a wall that grows 5.1 → 20.2 s.
Client action-run trace, note 10 ON: 82 runs, 1 757 ms of action time — 13× the
`sink:<space>/of:stream-events:ltWXQx9…` effect at ~99 ms each, 3× a second
sidecar sink, computeds ≤ 8 ms; the commit-prep cost above is outside the
recorded action duration.

Mechanism: under ON every client `send()` on a stream is an intent; the
speculation overlay's `trackIntent` (`overlay-destination.ts`) installs
`cell.sink()` on the WHOLE stream-events sidecar (`path: []`) to see the
`consequenced` mark. The sidecar accumulates every event of the session; every
server mark (each wave that consequences an event) re-fires the sink; each fire
reads all entries (links, payloads → read activities and dereference traces),
and its transaction commit runs the CFC flow-relevance probe
(`forEachFlowObservation` over `tx.getReadActivities()`, `probeBelongsToDereference`
= `isPrefix` over the doc's trace sources) — twice — so the client cost per note
≈ (#events so far)² and the worker saturates. Under OFF no intent exists (handlers
run locally), the probe never has a large read set, and the client scheduler
spends ~80 ms per note. This is the "client passivity" contract failing in the
opposite direction from the design's intent: the ON client does 100–200× more
scheduler work per note than the OFF client, none of it derivation.

### 2d. The exhaustion → multi-dispatch feedback term (PR #5969's mechanism), quantified

| run | events appended | processed (= handler dispatches) | Σ drained per wave (trace) | eventIds with 2 consequence commits (store) | re-scan waves (events>0, feed=0) | factor |
|---|---|---|---|---|---|---|
| chat B1/C1/C2/E1/E2/E3 (tip) | 8 | 8 | 8 | 0 (of 8) | 0 | 1.00× |
| chat A1/t1/smoke0 (red) | 6 | 6 | 6 | 0 (of 6) | — | 1.00× |
| chat fixer gate tb1 / review rfb tb2 (green, day) | 8 | 10 | — | 1 / 0 | — | 1.25× |
| chat t2 (lease churn) | 27 | 38 | — | 0 (of 27) | — | 1.41× (11 = lease-lost requeues) |
| note N1 / N2 (mine) | 72 / 62 | 74 / 65 | 74 / 65 | 16 of 72 / 8 of 48 | 0 / 0 | 1.03–1.05× dispatch, 1.11–1.22× consequence commits |
| note bench n1 / n2 | 93 / 72 | 95 / 74 | — | 15 of 79 / 8 of 72 | — | same class |
| lunch l1 (bench) | 9 client (+4 LT1 same-space) | 11 (handlerAction 15) | — | 1 of 13 | — | 1.15–1.67× per client event |

Every event-carrying wave in every run was exhausted (deadline late by seconds),
yet in the chat workload no event was dispatched twice; in the note workload
3–5 % of drains are re-dispatches and 11–22 % of eventIds end with two
consequence commits (the LT1 in-process/drain double-run of #5969, visible in
`consequence_of`); the lunch shape (LT1 `nowTick` sends) is where the multiplier
is largest. So on these two workloads the exhaustion → extra-work feedback runs
**through the demand walk (each extra commit re-walks roots × demanders), not
through handler re-dispatch (≤1.2×)**; the re-scan variant (`#eventDeferrals`
never clearing) produced 0 feed-less event waves here (`drainEv` Σ 0.66 s in N1).

## 3. The lease feedback loop — confirmed mechanism, thin margin, not triggered on quiet runs

Lease: TTL 15 s, renew every 5 s on a `setInterval` in the SpaceServer;
`renew()` fails only when the row already EXPIRED (`expires_at > :now`
guard), i.e. when the process missed two consecutive renewals — the main
thread was starved of macrotasks for > 10 s. That is the same starvation the
flush deadline suffers (§2b), so long settles are the trigger.

**t2 (benchmark, load 3.9, lease.lost = 33 = 11 episodes × 3 spaces):** the
server log has 11 identical episodes at 02:35:22, 02:35:40, 02:38:08, 02:38:29,
02:38:49, 02:39:11, 02:40:23, 02:41:04, … each = one `wave-commit-rejected
… producer does not hold the live execution_lease` (wave-accumulator) followed
within ~10 ms by `lease-lost` on ALL THREE active spaces — three independent
renew timers missing together is a starved event loop, not a slow sqlite write.
t2's stats: `scheduler/execute/settle` p95 11.9 s, max 16.2 s (vs 2.1–4.5 s p95
in green chat runs); `scheduler/run` n = 7 656 (4–6× a green chat run) with
`demandArrivals` 57 and `structureLoadTerminal` 382 (vs 17–30 / 94–108): t2 was
in a churn state from t≈0 (its test log shows the piece-start `ConflictError`
plus a `sync-load-failure`; the browsers kept re-subscribing, every arrival
re-armed the walks for that demander, and each wave re-walked 600+ roots × 3
instances). Timeline confirms the loop the task hypothesised: 10–16-s settle →
renew starved → lease lost → wave abort (`park("lease-lost-abort")`) →
reactivate on the next admission/session open → cold runtime → boot re-derive
of everything demanded → longer settle → next episode 18–150 s later; 11
requeued events (processed 38 for 27 appended) ride along. **Confirmed as a
design-parameter feedback (renew and deadline share the starved queue), and it
alone explains t2's non-completion.**

**My 10 traced runs (chat ×7, note ×3): lease.lost 0 everywhere; renew gap p50
5.0–7.9 s, max 10.0 s (C2 and E2 each had 3 renewals > 10 s late), deadline
lateness p90 3.2–5.5 s, max 8.3 s (E2).** The loop runs within ~2× of the
lease-loss threshold on a two-user chat with ~250 demanded keys; anything that
doubles a settle (a third session, a couple hundred more roots, a busier box)
crosses it. Renewal never fires mid-wave because the renew callback is a
macrotask behind the walk loop.

## 4. The "served handler no-op" — refuted; the quiet link is the CLIENT's arrival/coverage gate

Evidence chain for the chat lockdown toggle (E2, instrumented tip; A1/t1 stores
tell the same story without the trace):

1. **One dispatch.** `events.appended 8 / processed 8`, `handlerAction 8`, Σ
   drained-per-wave 8, one `consequence_of` commit per eventId in every red and
   green chat store (§2d). No client-side double either: one 1 156-byte
   stream-events append per click.
2. **The store is right.** Derived commit seq 50 (16:04:18.18, 4.7 s after the
   append at seq 48 / 16:04:13.5): `adminRegistry` set to
   `{bootstrapAdmin: Alice, everyoneIsAdmin: false}` (space scope), chip
   `computed:fid1:V_X_fuBDW44cqCOnUs6aPNp88StzwqOvi4qNGQNjByY` = "Can manage
   admins" in `user:<Alice>` and "Manager off" in `user:<Bob>`; watermark
   advanced in the NEXT commit (seq 51). t1/A1: identical shape (seq 49 append →
   seq 51 derived → seq 52 watermark; head of the chip doc in Alice's scope =
   "Can manage admins"; nothing else ever committed).
3. **The push side emitted the frame.** flush#51 (16:04:18.195–.240) evaluated
   all four sessions of the space and SENT: Alice session `866c3b…` 14 upserts
   (sample includes `comput…QNjByY@user:d…gUYx9N`, i.e. the chip in Alice's
   scope), Alice session `e4025d…` 15 upserts, Bob 19, service 24; the watermark
   frame 50→51 followed at .274. Both of Alice's connections got a `send` line
   with `type=sync`; no `SUPPRESSED`, no rollback, no `untouched`.
4. **The client held it.** Alice's DOM stayed "Everyone is admin"; the probe's
   `viewSettled()` (2 ms) and `rt.idle()` (1 ms) did nothing (the client
   runtime was idle and "settled" — the value was received, not pending pull
   work); at 16:05:04 Bob typed a draft (a client authored commit that produced
   NO frame for Alice's sessions — both `untouched`), the loop derived Bob's
   computed (seq 53, Alice untouched) and advanced W (seq 54); the ONLY frame
   Alice received in that window was the watermark doc `of:ser…ermark@space`
   51→54 at 16:05:06.479 — and her chip read "Can manage admins" at the next
   probe read (< 4 s). D4 (plain binary): identical sequence.
5. **Green runs are the echo.** In D5/E1/E3 the chip flipped 1–3 ms after the
   click — long before the server's 2.6–4.7-s event wave — i.e. the client's
   speculative handler run rendered it; the served frame later retired the echo
   in place. In red runs the echo is absent or shows the old value and the
   served value stays hidden.

Wake/push-liveness triage the coordinator asked for: **(a) serving loop —
not quiet** (input-driven cycle ran, derived commit landed within 4.7 s, W
advanced, then correctly idle-waited: nothing was pending); **(b) push — not
quiet** (frame emitted to both sessions ~80 ms after the commit); **(c) the
client's arrival/coverage gate — quiet.** The code names the shape:
`overlay-destination.ts` retires speculation entries only from `#sweep`, which
runs from the watermark-doc sink, the origin-ack observer, an intent-notice scan
or a chained retirement — never from the arrival of the derived docs themselves
— under the arrival gate ("every doc instance this run wrote must hold a
CONFIRMED value at seq ≥ floor") and the coverage rule `W ≥ floor`, with the
documented accepted trap "a re-speculation whose run READ a pushed derived value
carries that derived commit's seq in its confirmed basis, so its floor exceeds
every reachable W until the NEXT authored input — the entry lingers on a
then-quiet space", and the assumption "a served node still retires the moment
its derived value arrives (the watermark write rides the SAME wave commit, so
the watermark sink re-sweeps at arrival)". Under an EXHAUSTED wave that
assumption is false by construction: `derivedThrough` is frozen and the
watermark write rides the next settled wave (seq 51 vs the derived seq 50 in E2;
52 vs 51 in t1/A1) — the derived value arrives without a covering W, the
sweep that follows finds it not covered (or a re-speculation over the pushed
value pushes the floor above W), and nothing re-sweeps until the next authored
input lifts W. That is exactly why every unrelated commit (SummaryIndex churn by
day; Bob's draft in the probe) "fixes" it within one flush. The last inch —
which entry lingers (empty handler echo vs re-speculated chip) and why the echo
shows the pre-click value in red runs — needs a client-side trace
(`retireIntent`/`#scanIntentNotices`/`#sweep` decisions via the runner logger,
read through `commonfabric.rt.getLoggerCounts()` from the page; the probe in
this report is the recipe, ~1 red in 3 attempts on a quiet space).

**Class verdict:** not the F4 served-wish class (lunch `castVote` on null
`nowTick`), not the multi-dispatch toggle (dispatch = 1, store correct), a
third class — **client-side retirement/render liveness of a correctly served
and pushed derived value on a quiet space**. The stage-C-lunch fix (nowTick /
LT1 double-run) will not cover it. Whether it also explains part of lunch's
"1 love it" (Bob's browser stuck) is plausible — the same overlay machinery
gates every served result — but was not re-run here.

## 5. Tuning vs design — what each fix buys

| # | fix | class | mechanism it removes | what moves | est. |
|---|---|---|---|---|---|
| 1 | Evaluate `flowLabelWorkExists` ONCE per transaction (cache the negative verdict on `#cfcState` between `prepareTxForCommit` and `commit()`; index `traceSourcesByDoc`/read activities so the probe is O(reads), not O(reads × traces)) | tuning (runner/CFC, client + server) | client commit prep = 65 % of a saturated worker | note createToView p50 8.9 s → ~2–3 s (halving alone), p95 23 s → ~6–8 s; chat actor-side steps 2–4 s → ~1 s; ratio metric unchanged | high, cheap |
| 2 | Retire/render on ARRIVAL: re-sweep the overlay when a derived frame lands for a doc an entry wrote or read (or carry `derivedThrough` on the exhausted wave's commit so W is never behind the derived value the client just received) | tuning-class change in the speculation overlay / watermark coupling | the quiet-space liveness gap of §4 | two-browsers ON completion 7/12 → 12/12; lunch bimodality likely improves; no latency change | high, small |
| 3 | Yield a macrotask between scheduler runs in the settle loop (or run the walk loop off `setImmediate` slices) so the deadline timer, the 5-ms push flush and the lease renew can fire; renew mid-wave from inside the loop as a fallback | tuning (space-server / scheduler) | nominal deadline; lease loss under load (§3) | `wavesBudgetExhausted` becomes a real bound; lease.lost 33 → 0 on t2-class churn; per-step latency unchanged (the walks still run) | high for completion, none for latency |
| 4 | Stop re-walking per demander per change: walk once per root and re-derive only the instances whose narrowed reads changed (B7 already keys cleanliness per instance — extend it to the walk effect), cap the resubscribe union (67 K reads) by walking value-granular slices | design (fan-out B §B4) | server per-wave dominant term (96 % of event waves) | chat cross-user steps 2.4–7 s → sub-second; t2-class churn (walks × 3 × 600 roots) collapses; frees the box for the client | high, real work |
| 5 | Client intent tracking: subscribe to the ENTRY (or the tail) of the stream-events sidecar, not the whole doc; do not run the CFC probe on the overlay's bookkeeping sink transactions | design-lite (speculation overlay) | the O(events²) client cost of §2c | note per-note cost flat instead of +1.2 s/note; with #1 the ON client approaches OFF's ~1 s | high |
| 6 | LT1 same-space in-process + drain double-run and `#eventDeferrals` re-scan (PR #5969) | tuning | ≤1.2× handler work here, 1.4–1.7× on lunch/nowTick shapes | small on these workloads; needed for the lunch gate | medium |
| 7 | Renew cadence/TTL (5 s / 15 s), `DEMAND_WAKE_GRACE_MS` 300, `T_flush` 100 | pure parameters | none of the mechanisms above — longer TTL only hides #3 | do not tune first | low |

Owner call: **this is a design pass with three cheap tuning wins on top.**
#1–#3 are one-week-class changes that make the ON gate complete, make the
deadline and lease honest, and halve the client cost; #4 and #5 are the
architectural terms — the served-side walk cost is O(roots × demanders) per
change and the client-side speculation bookkeeping is O(history) per event —
and they, not `T_flush`, decide whether ON can beat the client-computed
baseline on cross-user propagation.

## 6. Also noticed

- Every ON run, green or red, day or night, logs one
  `piece-start-commit-failed … ConflictError` at t≈0 (the started graph's setup
  writes did not land): the test controller's piece instantiation races the
  first serving wave; it did not decide any outcome here but it is the seed of
  t2's churn (plus its `sync-load-failure`).
- `server.idle()` inside the settle (the memory-server flush drain) is 30 % of
  wave wall in the note run (single waves up to 1.2 s waiting on
  `waitForConnectionQueuesToDrain(max(500 ms, 2×lastRefresh))` and per-session
  graph refreshes); with #3 it should be measured separately.
- `watermarkClamped` 4–10 per note run (settle input barrier) — small.
- The daytime toolshed's own runtime pointed at the foreign :8000 dev toolshed
  (`MEMORY_URL` default; CI sets TOOLSHED_PORT=8000 so the default coincides
  with self there) — harmless for the serving loop and browsers, but a recipe
  drift worth pinning in the harness protocol.
- The shell/grep hygiene lesson: the sandbox `grep` is `ugrep -I` and silently
  skips the toolshed logs (they contain `%c` colour bytes) — use `/usr/bin/grep -a`
  when reading them; my first two trace reads were false negatives.
- The note ON runs still hit the `[RuntimeClient Error] … splitDefinitions
  (reading 'split')` in `notes/reference-block.ts` (benchmark n1 and my N2), a
  note.tsx lift over an undefined per-user value under ON — a served-wish/F2-shape
  candidate for the notes pattern, unrelated to timing.
- The two-browsers test waits for Alice's OWN chip with `waitForText` (DOM
  only) after her own click; the helper file's `waitForSettledText` comment
  describes exactly this hazard for stimuli whose rendering the page must
  produce itself. Under OFF it never mattered (the local run renders); under ON
  it is the difference between "green in 3 ms" and "red for 300 s". Worth a
  harness ruling independent of #2.

## 7. Cleanup

Instrumentation reverted (`git checkout --` on the four files, `git status`
clean), scratch binaries left in the session scratchpad only, no toolshed /
headless-shell / deno process of mine left (checked by port and by `ps`),
worktree `/Users/berni/labs-worktrees/attrib-c` removed. Nothing pushed, no
PR/issue comment.
