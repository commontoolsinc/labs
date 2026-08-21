---
status: historical
created: 2026-08-18
archived: 2026-08-18
reason: "Stage-C closeout record of the server-execution v2 arc, frozen at the 2026-08-18 handoff: the train, the owner's landing posture, the benchmark and re-benchmark verdicts with the measurement caveat, the attribution, the tuning trio, the double-dispatch dossier, the design-pass state, the open rulings, and the process rules the stage taught. The LIVE coordination state is the plan's."
---

# Server-execution v2 — stage C closeout record (2026-08-18)

**Read this first if you are picking up the arc.** It is the record a
fresh coordinator needs before touching anything: what exists, what was
measured, what was decided, what is still owed, and how the work is run.
It is FROZEN at the date above (a historical record per
[`docs/README.md`](../../../README.md)); the LIVE state — next actions,
open rulings, ticks — is carried by the plan,
[`docs/plans/server-execution-v2.md`](../../../plans/server-execution-v2.md)
(its "Coordination state" section), and the owed rows by the register,
[`verification-coverage.md`](../../../specs/server-side-execution/verification-coverage.md)
§3. When those disagree with this record, they are newer; trust them.

Why this document exists: the owner directed on 2026-08-18 that the
arc's coordination state be carried **on the branch, in files** — an
agent's private memory is not a durable carrier, and this session had
already lost history once. Everything the coordinator's handoff held is
placed here or in the plan/register; the evidence files that lived only
outside the repository (`/Users/berni/labs-worktrees/*.md`) are copied
beside this record (§11).

## 0. Where things stand, in one screen

- **The train**: 21 PRs, all OPEN, zero merged, one linear stack from
  main through Phase 7 and the two fan-out stages, then THREE stage-C
  siblings off fan-out B (§1). Merge-base with `origin/main` is
  `30fdbb92f` (#5786; the stage-A branch merged main up to it on
  2026-08-14 — the handoff's `9d6c9fe00` is an earlier merge point on
  the same branch). Stacked PRs get NO CI (`deno.yml` triggers on main
  only); every claim of green below is a local run.
- **The owner's landing posture** (2026-08-18): *get confidence that
  we're on the right track, then merge everything to main with the flag
  OFF, then continue optimizing; do not land the stack if there are
  fundamental issues that warrant big changes.* So: a CONFIDENCE VERDICT
  first (are there fundamental issues?) → land the stack OFF → optimize
  on main; the flip is later (§2).
- **Stage C's three items**: OW28 (compile-and-run served) DONE on
  #5968 — built, reviewed, fixed, ledgered; the lunch gate (#5969)
  RE-CHARACTERIZED as served-handler double dispatch — no production
  code, the skip STAYS listed, an owner ruling is owed; the tuning trio
  (#5991) DONE — reviewed (two rounds), fixed, every target met, its
  ledger comment posted 2026-08-18 (§3).
- **Benchmarks**: the first (fan-out B tip) — ON could not COMPLETE the
  two-user journeys; the attribution named the mechanisms; the tuning
  trio fixed completion; the re-benchmark (trio tip) — ON completes
  every journey, `lease.lost` 0, exactly-once dispatch on chat/note, but
  the cross-user series is 31–44× OFF at p50 (7.4–9.7 s vs 0.22–0.24 s)
  and note create-to-view 3.4–3.7× (3.9–4.2 s vs 1.13–1.19 s). Verdict
  vocabulary: SLOWER (attributed); flip performance gate NOT MET (§4).
  The owner's MEASUREMENT CAVEAT applies to how the next benchmark is
  read (§5).
- **What is left is design-class, and it is next**: two terms — the
  server's per-demander DEMAND WALK and the client's whole-sidecar
  INTENT WATCH — with two redesigns pre-recommended by a three-lens
  design pass whose reconciled report was still being written at the
  handoff (§7). Owner rulings pending on that design (§8) plus three
  unruled items carried from before it: the double-dispatch parity gap,
  the late-echo rule's ratification, OW31's write-authority posture.

## 1. The train (verified via `gh` on 2026-08-18; all OPEN, none merged)

Every PR's base is the previous PR's branch. Tips are `origin/<branch>`
at the handoff.

| # | stage | PR | branch | tip |
| --- | --- | --- | --- | --- |
| 1 | A — flag, commit class, CI arms | #5339 | `claude/brave-tu-76e0df` (base `main`) | `63d49dab7` |
| 2 | B — lease | #5349 | `claude/loving-boyd-b1c6db` | `d4aee93bf` |
| 3 | C.1 — emission + consumers + goldens | #5356 | `claude/suspicious-gagarin-849bb6` | `0cf58a0be` |
| 4 | C.2 — basis index | #5367 | `claude/suspicious-gagarin-849bb6-c2` | `1442b468a` |
| 5 | C.3 — flag retirement + archival | #5369 | `claude/suspicious-gagarin-849bb6-c3` | `ce7de16a7` |
| 6 | D — seal-into-wave | #5371 | `claude/practical-gates-54bf64-d` | `c60420113` |
| 7 | E — instance re-keying | #5374 | `claude/server-exec-v2-stage-e` | `5d1eb2c07` |
| 8 | F — host + SpaceServer + watermark | #5439 | `claude/server-exec-v2-stage-f` | `4db5ffa9e` |
| 9 | G — effectful + outbox | #5461 | `claude/server-exec-v2-stage-g` | `183b99dea` |
| 10 | Phase 2 — server derives, client does not | #5522 | `claude/server-exec-v2-phase-2` | `4269ee2da` |
| 11 | P2-F — per-(action × instance) run supply | #5789 | `claude/server-exec-v2-phase-2f` | `7a7f6de8e` |
| 12 | Phase 3 — events-down handlers | #5612 | `claude/server-exec-v2-phase-3` | `0a4451a58` |
| 13 | Phase 4 — client-effect channel | #5613 | `claude/server-exec-v2-phase-4` | `3491c7817` |
| 14 | Phase 5 — cross-space | #5837 | `claude/server-exec-v2-phase-5` | `061c33239` |
| 15 | Phase 6 — push priority, budgets, scale | #5841 | `claude/server-exec-v2-phase-6` | `c75f04f37` |
| 16 | Phase 7 — flip-ready, landed DARK (`SERVER_EXECUTION_DEFAULT_ENABLED = false`) | #5849 | `claude/server-exec-v2-phase-7` | `a73147f75` |
| 17 | fan-out A — instance-keyed serving replica + arrival gate | #5903 | `claude/server-exec-v2-fanout-a` | `ea74739f2` |
| 18 | fan-out B — per-demander run supply | #5924 | `claude/server-exec-v2-fanout-b` | `fb2292a24` |
| 19 | stage C — OW28, compile-and-run served (sibling off 18) | #5968 | `claude/server-exec-v2-stage-c-ow28` | `463ea3887` |
| 20 | stage C — lunch residual + arrival-gate revisit (sibling off 18; no production code) | #5969 | `claude/server-exec-v2-stage-c-lunch` | `eb64d8694` |
| 21 | stage C — the tuning trio (sibling off 18) | #5991 | `claude/server-exec-v2-stage-c-tuning` | `b54bf5215` |

The three stage-C siblings share the base `fb2292a24` and are meant to
be STACKED (in an order the stacker chooses; all three append a delta at
the end of the register's §3, so that spot conflicts trivially) — never
merged into each other by hand. This record itself rides the docs PR
#6009 (`claude/server-exec-v2-stage-c-docs`) off the tuning tip.

Ledgers: #5968 carries the coordinator-round independent review as its
one comment (MAJOR-A supersession wedge, MAJOR-B fan-out cardinality 2,
MINOR-C `createRef` — all fixed as `463ea3887`; three owed rows minted
there: `OW28-supersession-family`, `OW28-instance-family`,
`OW28-createRef`). #5991's ledger comment was posted 2026-08-18
(<https://github.com/commontoolsinc/labs/pull/5991#issuecomment-5337935897>;
§3.3). #5969 has no ledger comment yet.

## 2. The owner's landing posture — and what it changes

Verbatim intent (2026-08-18): *"get confidence that we're on the right
track, then merge everything to main with flag OFF, then continue
optimizing. I don't want to land this stack if there are fundamental
issues that warrant big changes."*

Read as a plan: the near-term deliverable is a **confidence verdict** —
does the evidence show fundamental issues that warrant big changes? — not
the flip. If the verdict is "no fundamental issue", the whole train lands
on main with the flag OFF (OFF byte-identical throughout, by every stage's
own witness), CI regains an honest meaning on main, and optimization
(the design pass) continues there. The flip's ordered gates (plan
Phase 7 task 1) remain the path to ON; they no longer gate landing.

What the stage-C evidence says toward that verdict, in the coordinator's
reading (a recommendation, not a decision):

- Completion blockers were mechanisms, not architecture: the lease
  feedback loop, the client arrival gate, the double CFC probe — each
  closed by a contained change (§3.3), and ON now completes every
  byte-identical journey (§4).
- The remaining gap is two named terms with two scoped redesigns (§7):
  the per-demander demand walk (server) and the whole-sidecar intent
  watch (client). Neither is a change to the serving-loop model, the
  commit classes, the lease, or the wire; both are how demand and intent
  are TRACKED.
- One PARITY gap needs a spec sentence and an owner ruling before the
  ON arm can be called correct on non-idempotent handlers: the
  served-handler double dispatch (§6). It is a dispatch-path dedupe
  question, not a model question.
- The performance BAR for the flip is itself an owner ruling (§5): the
  client-local OFF number is not necessarily the comparator.

## 3. Stage C, item by item

### 3.1 OW28 — `compile-and-run` served as an outbox effect (#5968) — DONE

Third of the flip's ordered gates. Under the flag, fresh compile-and-run
was inert everywhere (client gate suppressed the compile; server
writebacks were unstamped and refused at the seal) — a product
regression relative to OFF. The port: the compile is an outbox effect
memoized on the program hash (`{ requestHash, resolvedHash,
compiledHash }` memo cell); the completion is a marked completion-class
commit that RE-ARMS the derivation; the derivation instantiates the
child in-run (a refinement of the register's "completion-class
writeback" shape, recorded as Flag 1 — a completion-flush instantiation
raced the loop's own child resume). The client reads through for every
outcome. The §4 hit rule keys on `resolvedHash`, not `pending` (the
OFF-shared cell-init clobbers `pending=false`). Root defect found in
passing: `createRef` on an `asSchema` proxy is content-insensitive to
nested `contents` — worked around in the ON arm (`plainProgramOf`), the
OFF-arm collision pinned as a labeled defect (`OW28-createRef`).

Review history: the self-review
([`stage-c/stage-c-ow28-review-report.md`](stage-c/stage-c-ow28-review-report.md))
found 1 MAJOR / 3 MINOR / 3 NIT, all addressed; the coordinator-round
independent review (the PR's ledger comment) found the supersession
wedge (A→B→A within A's compile left `pending=true` forever; fixed —
the ON arm carries no abort signal, every issued effect runs to
`stillCurrent`'s hash re-read, `outbox.superseded` counts) and the
fan-out cardinality-2 wedge (per-request closure state shared across
demanders; fixed — the completion tx is stamped with the issuing run's
identity; a NARROWED compile-and-run node had not landed even at
cardinality 1). Counts at `463ea3887`: runner 1219/0, spec-model 23,
E2E soak 8/8, serving-loop 6/6, check.sh/lint/check-docs clean.

### 3.2 The lunch gate (#5969) — re-characterized; skip STAYS; no production code

The register and skip entry had said "served-wish timing" (`nowTick`
null/stale → `castVote` no-ops). Instrumented investigation REFUTED
that: `nowTick` is always valid at served dispatch (two positive pins
landed — the served interval `#now` wish advances on the serving
runtime; a served handler bound to it reads a current tick). The real
residual is a **served `castVote` DOUBLE DISPATCH of ONE durable event**
— one sidecar entry, one eventId, run 2–5× per click (CAST / TOGGLE-OFF
interleaving) — plus a client-side coin (a late divergent echo the
arrival gate strands). Both are served-execution semantics the spec does
not state → flag-don't-fill: the dossier (§6) went to the owner, the
gate stayed red 0/2 clean at that tip, the skip stays listed. The
arrival-gate revisit ruled KEEP (the gate is client-side; the fan-out
fixes are server-side; live + unit evidence). Review:
[`stage-c/stage-c-lunch-review-report.md`](stage-c/stage-c-lunch-review-report.md).

### 3.3 The tuning trio (#5991) — DONE; ledger posted 2026-08-18

The owner-approved TUNING half of the attribution's split (§4), each
item re-measured on the harness protocol with NO configured LLM model:

- **T1 — one CFC flow-label probe per commit.** `flowLabelWorkExists`
  (O(reads × dereference traces)) ran TWICE per commit; 65 % of a
  saturated client worker on the note series. The negative verdict is
  memoized on the transaction, invalidated by an activity epoch. Both
  arms, verdicts unchanged. Note create-to-view p50 8.9/5.8 s →
  3.8–5.8 s on the trio's own reps (final binary 5.8/3.8 s, interim
  4.2/4.4 s), p95 23–26 s → 7.4–10 s; the series completes n=20 every
  rep (the re-benchmark then read 3.9–4.2 s, §4).
- **T2 — retirement on ARRIVAL + the late-echo rule.** The overlay
  re-sweeps when a served frame lands for a doc a live entry wrote (an
  earlier TRIGGER, predicates unchanged); an event-handler echo sealed
  after its intent's terminal consequence already arrived is jobless and
  not registered (speculation.md §4 step 2, DATED 2026-08-18, pending
  ratification — §8). Also found: the browser bundle dropped
  uninitialized class fields, so leg-C's origin-ack wake had never
  installed in a browser client. Two-browsers gate GREEN 16/16 at
  night-like conditions (was 5 stalls in 12); `overlayArrivalSweeps`
  14–25 per browser per run; `overlayLateEchoDrops` 0 (the rule never
  fired live).
- **T3 — honest deadline + mid-wave renew.** A serving scheduler yields
  one macrotask between settle-loop ACTIONS after a 16-ms slice
  (`setTimeout(0)`; NOT inside the per-demander fan-out loop — tried,
  reproduced a double emission, removed); the SpaceServer renews the
  lease from the yield at TTL/3. Deadline lateness p50 25 ms (was 125;
  seconds on chat waves); renew gaps p50 5.0 s, max 5.1 s (was up to
  10.0 s vs a 15-s TTL); `lease.lost` 0 in all 22 re-measured runs.
- **Companion — the drain's in-flight guard.** The honest deadline
  turned #5969's (β) re-scan variant from rare into 4.25× dispatch of
  the lockdown toggle; the drain now queues a pending entry AT MOST ONCE
  until the store has spoken (release on the wave outcome, not the seal
  — the review's MAJOR-latent). Narrow by construction: drain-own copies
  only; the LT1 in-process copy (α) is untouched (§6).

Review: [`stage-c/stage-c-tuning-review-report.md`](stage-c/stage-c-tuning-review-report.md)
(no blocker; 1 MAJOR-latent + 8 minors, all dispositioned; the fan-out
yield removed after its double-emission repro; the late-echo cascade and
effects arms added; tests hardened). A SECOND, independent adversarial
review of the tip `2e9d86478` followed —
[`stage-c/stage-c-tuning-independent-review.md`](stage-c/stage-c-tuning-independent-review.md)
(LANDABLE-WITH-FIXES; MINOR-1/2/3 addressed at `b54bf5215` — the
register reconciled to the final binaries, the seal→outcome-window pin,
the T2 row's explicit "pending owner ratification"; the pre-existing
effect-channel flake recorded, not fixed; recovered on-branch on
2026-08-18 after the handoff). Ledger comment POSTED 2026-08-18:
<https://github.com/commontoolsinc/labs/pull/5991#issuecomment-5337935897>.
Register: the "Stage C tuning delta (2026-08-18)" in
`verification-coverage.md` §3 carries the final numbers. Suites
(foreground): runner 1 209 / 0 failed, memory 521, toolshed 142,
runtime-client 61, piece 37, spec-model 23; the ON-lane danger sets
green; skip-list validator 17/17.

### 3.4 Benchmark → attribution → re-benchmark

Protocol (all three): built binaries from the tip (`toolshed-off` flag
unset, `toolshed-on` with `EXPERIMENTAL_SERVER_EXECUTION=true`), booted
`--background --log-file` on private ports (a source-run toolshed cannot
bake the ON shell define — a MIXED posture), posture read from
`/api/meta.shellServerExecutionDefine` + `/api/health/stats.servingLoop`
before EVERY run, fresh cwd = fresh store, one test file per run with the
patterns lane's flags, hard caps, OFF → ON → OFF triplets per workload,
1-min load recorded and gated (`wait-load.sh 5 15`), the store's `commit`
table counted by class after each run. Workloads, byte-identical across
arms: (a) two-browsers chat with `CF_CHAT_MESSAGE_SERIES=20
CF_CHAT_MESSAGE_DELAY_MS=2000` (send click → other browser renders); (b)
lunch two-user vote; (c) note-create n=20 (`CF_NOTE_CREATE_TIMING_SERIES=20`,
actor-side). Verdicts follow the README §1 vocabulary (§4).

## 4. Verdicts and the attribution (mechanisms, with the reports' anchors)

**First benchmark — 2026-08-17, `59b5329ae` (runtime byte-identical to
fan-out B `fb2292a24`)**
([`stage-c/stage-c-benchmark-report.md`](stage-c/stage-c-benchmark-report.md)):
**SLOWER where a number exists; UNMEASURABLE for the headline.** Chat: OFF
n=20 three times (p50 227 / 328 / 477 ms at loads 3–9); ON 0 series in 3
tip attempts + 0 in 1 at `fadc2efb1b` — lockdown stall 300 s, or lease
churn from t≈0 (t2: `lease.lost` 33 = 11 episodes × 3 spaces at 1-min
load 3.9). Lunch: OFF 2/2; ON 0/1 (red at "both browsers see 2 love it
(merge)"). Note: ON createToView p50 8 927 / 5 841 ms (rep 2 capped at
17/20 by 780 s) vs OFF 1 085 / 1 171 / 1 090 ms; per-note cost monotone
1.6 → 25 s. The §4 ratio 1.7–2.8 (met). Flip gate NOT MET.

**Attribution — 2026-08-18, instrumented, `fb2292a24`**
([`stage-c/stage-c-attribution-report.md`](stage-c/stage-c-attribution-report.md)),
verdicts in one screen:

1. **Steady state, bimodal, MASKED by day.** The two-browsers ON gate
   stalled at the same step in 5 of 12 night attempts across three
   runtime-identical binaries and 0 of 7 daytime attempts; the daytime
   environment had a configured default LLM model whose SummaryIndex
   churn (11–15 unrelated authored commits per run) re-triggered the
   stuck path every few seconds. Nothing to bisect (no runtime change
   between the greens' tip and the benchmark's).
2. **Two dominant latency terms, one per side.** Server: the
   per-demander **demand-walk effects** (`demand-walk:<space>/<root>`,
   20–250 ms each × demanders × every root a commit touched — 96 % of
   an event wave's settle; the 100-ms deadline fired 2.5–8.3 s LATE
   because the loop never yielded a macrotask; the design lenses later
   sharpened the walk's cost — `JSON.stringify` over a query proxy at
   ~7 reads per property, re-fired by value-only changes — §7).
   Client: the speculation overlay's intent-tracking `cell.sink` over
   the WHOLE stream-events sidecar (`overlay-destination.ts`
   `trackIntent`, `path: []`), each fire committing a tx whose CFC
   flow-relevance probe ran twice — 65 % of a 100 %-busy worker by note
   10; the ON client's `scheduler/run` per note grew 0.6 → 15.5 s while
   OFF's stayed ~80 ms. The serving loop was idle ~90 % of the note run.
3. **Lease positive-feedback loop confirmed** from t2's log (settle
   10–16 s → renew starved → lease lost on all three spaces within
   10 ms → wave abort → reactivate → cold re-derive → longer settle);
   not triggered in the 10 traced runs but with a thin margin (renew
   gaps to 10.0 s vs 15-s TTL).
4. **The chat "no-op" refuted**: the served toggle ran ONCE, wrote the
   toggled state, the frame was PUSHED to Alice; the CLIENT's
   arrival/coverage gate held it 48 s (the derived value arrived
   without a covering W under an exhausted wave; nothing re-swept until
   the next authored input). Third class: client-side retirement
   liveness of a correctly served value on a quiet space.
5. **Double dispatch quantified**: ≤ 1.2× on chat/note (0 re-dispatches
   in chat; 3–5 % of drains in note), 1.15–1.67× on the lunch `nowTick`
   shape — the exhaustion → extra-work feedback runs through the demand
   walk, not handler re-dispatch, on these workloads.
6. **The split**: tuning (single CFC probe; retire on arrival; yield +
   mid-wave renew — the trio, §3.3) vs design (the walk; the intent
   watch — §7). Owner-approved 2026-08-18.

**Re-benchmark — 2026-08-18, trio tip `b54bf5215`**
([`stage-c/stage-c-rebenchmark-report.md`](stage-c/stage-c-rebenchmark-report.md)):
**SLOWER, attributed — and now MEASURABLE.** Bar (i), does ON complete:
YES — chat 2/2 with full n=20 series (272 s, 251 s walls), lunch 2/2
GREEN (43 s, 57 s), note 2/2 series (214 s, 237 s); `lease.lost` 0 in
6/6 ON runs; `events.processed == appended` on chat/note (28/28, 94/94);
`drainInFlightSkips` 30–46 per run (the re-drains being caught). Bar
(ii), sub-second within a small constant of OFF: NO — chat series ON p50
7 397 / 9 734 ms, p95 13 805 / 14 020 vs OFF p50 220 / 221 / 242, p95
288–400 (31–44× at p50); cross-user steps ON 2.6–10 s vs OFF 2–120 ms
(message propagation 2.6–3.0 s vs 6–17 ms; lockdown 3.3–4.1 s vs
3–21 ms; room 9.5–10.2 s vs 2–3 ms; lunch merge 3.7–6.3 s vs 35–42 ms);
note createToView ON p50 3 879 / 4 154 ms vs OFF 1 133–1 185 (3.4–3.7×).
The ON per-post / per-note cost still climbs across each series (chat
5 → 14 s; note 1 → 13 s) — the intent-tracking term, now visible on chat
because it completes; `structureLoadTerminal` 377–441 per run — the walk
runs about as much work as before, it just no longer starves the timers.
The §4 ratio rose with the honest deadline: chat 2.05 / 2.14, lunch
2.11 / 2.15, note 3.07 / 3.20 — a hair over ≤2 / ≤3, by the cycle-count
mechanism (more, smaller waves per input; total commits still 2.1–3.1×
BELOW OFF) — a §4 TRIGGER breach that needs its human inspection
(register OW37). Lunch's (α) class intact (`appended 11 / processed 17`
both runs) and did not break the merge in 2 attempts. Flip gate NOT MET;
this is the design stage's baseline.

## 5. The measurement caveat (owner, 2026-08-18)

The OFF "4–42 ms" figures for cross-user steps and the 0.22-s chat
series are CLIENT-LOCAL numbers: under OFF the client computed the value
itself and rendered its own run; speculative client-side execution
STAYS under ON (and stays fast) — so the OFF number is not necessarily
the comparator for the flip. **The honest server metric is
time-to-SETTLE on the server**: authored input admitted → the derived
consequences committed and W covering them (`waitForSettled` /
`derivedThrough` on the space), measured explicitly and separately from
the browser-render series. The several-second chat sends are far too
high regardless of comparator. Two consequences recorded here so the
next benchmark does not repeat the omission: (1) the next benchmark
MEASURES SERVER SETTLE TIME EXPLICITLY (register OW38), alongside the
send→other-browser series it already has; (2) the flip's performance BAR
is itself an owner ruling (§8), pre-recommended by the design pass as
"sub-second, within a small constant of OFF" for the cross-user step —
to be restated against the settle metric.

## 6. The double-dispatch dossier (summary — the dossier is #5969's)

One durable event, one eventId, dispatched N× (2–5 on the lunch gate).
Mechanism (#5969's Flag 1, `file:line` at `fb2292a24`): the served click
handler's `castVote.send()` takes the LT1 same-space arm — it writes the
durable entry in its own tx AND queues the event IN-PROCESS for the same
wave (no `streamEntry`; "the batch owns the mark"). If that run misses
the flush deadline, (α) the LT1 leftover stays in the scheduler queue
and runs in a later wave carrying no `streamEntry`, so its consequences
commit UNMARKED, and (β) the appending wave re-arms the scan, so the next
drain queues the SAME id again WITH a `streamEntry` — the second run. A
second (β) variant needs no cascade: an entry drained but not yet run
when a cycle ends is queued AGAIN by the next cycle's re-armed drain.
Under OFF the same pattern is exactly-once BY CONSTRUCTION (one in-process
queue, one handler registration per stream link) — a served-execution
PARITY GAP, not a pattern bug. `events.processed > events.appended` is
NOT a signature (re-drains inflate `processed`; in-wave LT1 cascades
count in neither); the per-event run counts from the stores are.

State at the handoff: the trio's drain guard closes (β) NARROWLY (the
drain dedupes against ITSELF; events.md §4 says so). Still owed:
(α) — the deadline-time purge of unrun LT1 leftovers — and the
cross-producer spec sentence. Recommendation (#5969's (ii), the
coordinator's too): events.md §4 states *"one durable entry = one
COMPLETED delivery to its handler, regardless of dispatch path or
reference count; an entry not completed in the wave that appended it is
dispatched by the drain alone"*, enforced by (α) the deadline-time purge
(discriminator `served !== undefined && served.streamEntry ===
undefined`; synchronous at the deadline decision) plus the per-eventId
drain skip keyed on a mark-bearing copy (the guard is that half); the
sub-clause the sentence must also decide: orphan delivery for
DERIVATION-kind LT1 emitters (a superseded per-doc drop re-emits
nothing, so a purge would lose it — today it runs as an orphan
consequence). NOT (iii) "make handlers idempotent" — contradicts OFF
parity. Same class elsewhere: the two-browsers lockdown toggle (bound
directly to the click; the re-drain variant only). Register: OW35.

## 7. The design pass — state at the handoff

Three lens reports on the two design-class terms were in (one of them
SPEC-BLIND — reading the mechanism without the spec, to test whether the
spec's wording forced the cost); the convener's reconciled report
(`stage-c-design.md`) was NOT yet written when this record was made
(absent from the report channel) — it is PENDING and, when it lands,
belongs beside this record. What the lenses established, as carried by
the coordinator's handoff:

- **(d) The demand walk.** serving-loop.md §1's "the demand WALK … runs
  once per demanding pair, each run following THAT demander's redirects"
  is a CONSEQUENCE clause, not a MUST — and a normative reading is
  self-inconsistent with the ruled per-node instancing (the fan-out
  design's own model). Redesign: a **STRUCTURAL WALK** — one shallow read
  per container, one probe per leaf, whole reads at links; value-only
  changes do NOT fire it — with one walk node per (scope-name, root id).
- **(e) The intent watch.** Redesign: a **non-reactive
  storage-notification listener** keyed on the outstanding intent set —
  O(outstanding), zero transactions, zero CFC probes, no scheduler node.
  Interim (if the full listener waits): a schema-narrowed sink instead of
  the whole-sidecar `path: []` sink.

Pre-recommended rulings the design puts to the owner (all recommended
"as stated"; none ruled at the handoff): no lazy demand (a watch IS
demand; W forbids lazy-on-read); the walk is a "structural subscription"
— amend serving-loop.md §1's wording (the paragraph at lines 57–62 of the
tuning tip); the walk re-runs on STRUCTURAL change only; the intent
watch need not be a scheduler effect; tracked-entry-only sidecar read;
no idle-demander tier; the per-entry `consequenced` mark is not a client
dependency; pin drops/errors ride `consequenceOf`; scopes.md §9's
"ragged instance sets" tripwire (line 527) is inconsistent with §2's
ruled ragged transients — amend §9; and the flip's performance BAR
itself (§5).

## 8. Open owner rulings at the handoff (with the recommendations on file)

1. **Served-handler DOUBLE DISPATCH** (§6): the events.md §4 invariant
   sentence + (α) purge + orphan-delivery sub-clause. Recommendation:
   (ii). Register OW35. Trigger: before the lunch skip lifts; before the
   ON arm is called correct on non-idempotent handlers.
2. **The late-echo arrival-gate rule** (§3.3 T2): implemented in #5991 as
   a DATED speculation.md §4 step-2 predicate (with the cascade-jobless
   and effects-not-enacted arms), never fired live; #5969 had called it a
   candidate rule / owner call. Ratify, or mark pending. Register OW36.
3. **OW31 — the service-principal write-authority posture** (owner-
   everywhere under the flag vs a read-only ACL class): travels with the
   flip PR; does not gate landing the stack OFF (the grant is flag-gated).
4. **The design-pass ruling set** (§7), including the flip's performance
   BAR (§5).
5. Carried from #5968's Flags (ratify or direct): instantiation in the
   derivation rather than a completion flush; `resolvedHash` as the hit
   marker; live-runtime completion-commit failure staying pending until
   re-activation (fetch parity); `plainProgramOf` as an ON-arm workaround
   for the `createRef` proxy insensitivity (owed rows on that branch).

## 9. Ordered next actions (as understood at the handoff; the plan is live)

1. Bookkeeping: #5991's ledger comment (the trio's independent review
   verdict + fix batch, as #5968's has). DONE 2026-08-18 — posted
   (§3.3); the second review round's report recovered on-branch (§11).
2. The design pass: the convener's `stage-c-design.md`; the owner's
   rulings on §7's set; then the two redesigns (structural walk; the
   storage-notification intent listener, schema-narrowed sink as
   interim) — built to the harness protocol with NO LLM model, re-
   benchmarked measuring server settle time explicitly (§5).
3. The CONFIDENCE VERDICT to the owner (§2): the evidence above plus the
   design pass's scoping; the double-dispatch ruling is the one parity
   item that must be stated before "correct under ON" is claimed.
4. On "no fundamental issue": land the train on main with the flag OFF —
   the stage-C siblings stacked, CI's default lanes the OFF posture — and
   continue the design work on main.
5. Then the flip's ordered gates as the plan lists them: the ON skip list
   EMPTY (lunch after the ruling; `topics-navigation` OW30;
   `pattern-and-data-persistence` and the two runtime-client STEP entries
   OW33), the deployed-topology binaries exercised ON, OW31 ruled, the
   honest benchmark against the ruled bar — then the flip PR and the
   soak.

## 10. Process rules learned in stage C (how this work is run)

- **The report channel is on-branch now.** Subagents (benchmark,
  attribution, reviews, design panels) write REPORT FILES; the
  coordinator reads files, not memory. Reports lived at
  `/Users/berni/labs-worktrees/*.md` outside the repo — that is why this
  record exists. New reports go beside this record in
  `docs/history/plans/server-execution-v2/` (with the history header),
  and the plan's coordination block is updated in the same PR.
- **Fetch before dispatch; never `git checkout` a named branch.** A
  sibling session operates on the same remote concurrently. Every
  dispatch starts with `git fetch origin` and a fresh worktree
  (`git worktree add /Users/berni/labs-worktrees/<slug> -b <branch>
  origin/<base>` or detached at a SHA); push with `git push -u origin
  HEAD:<branch>`; PRs stack with the previous branch as base.
- **Foreground suites, sized caps.** Run suites and gates in the
  FOREGROUND with explicit hard caps that fit the tool window (the
  re-benchmark chose 520 s per test so boot + run + teardown fits one
  10-minute window; the first benchmark lost an ablation run to a
  foreground timeout at 9 min). Backgrounded runs are lost runs.
- **NO configured LLM model when benchmarking or gating.** Verify per
  run: the toolshed log's `No default model available`, no
  `CFTS_AI_LLM_*` keys in the environment, no `packages/toolshed/.env`;
  the daytime greens of 08-17 were masked by exactly that churn.
  Posture per run: `/api/meta.shellServerExecutionDefine` (`"true"` ON /
  `null` OFF) and `/api/health/stats.servingLoop` present/absent; the
  test process carries the same posture as the server; the toolshed's
  own `MEMORY_URL` must be its own port (the daytime recipe pointed at a
  foreign :8000 dev toolshed).
- **Built binaries, not a source run**, for any ON gate — a source-run
  toolshed cannot bake the ON shell define (mixed posture).
- **Stacked PRs get no CI** — `deno.yml` triggers on main only. Every
  green is a local run; say so, with counts, in the PR.
- **The ON skip list was INERT from Phase 4 to P7** — `deno test
  --ignore` never applied to explicitly listed files; the P7 fixer made
  it effective. A skip must be seen to skip (the loud
  `[server-execution ON arm] … SKIP` line).
- **Read logs with `/usr/bin/grep -a`** — the sandbox `grep` is `ugrep
  -I` and silently skips the toolshed logs (they carry color bytes); the
  attribution's first two trace reads were false negatives.
- **Counters over latencies; verdict vocabulary fixed** (README §1:
  FASTER / PARITY / SLOWER (attributed) / INCONCLUSIVE, plus
  UNMEASURABLE when the harness is red under ON); no latency quoted
  above load ~5; drift control = adjacent OFF runs bracketing every ON
  run; causation by ablation.

## 11. Evidence in this folder

`stage-c/`:

- [`stage-c-benchmark-report.md`](stage-c/stage-c-benchmark-report.md),
  [`stage-c-benchmark-results-table.md`](stage-c/stage-c-benchmark-results-table.md),
  [`stage-c-benchmark-results.json`](stage-c/stage-c-benchmark-results.json)
  — the first benchmark (2026-08-17, `59b5329ae`): report, one-line
  table, machine-readable per-run extraction.
- [`stage-c-attribution-report.md`](stage-c/stage-c-attribution-report.md)
  — the instrumented attribution (2026-08-18, `fb2292a24`).
- [`stage-c-rebenchmark-report.md`](stage-c/stage-c-rebenchmark-report.md),
  [`stage-c-rebenchmark-results-table.md`](stage-c/stage-c-rebenchmark-results-table.md),
  [`stage-c-rebenchmark-results.json`](stage-c/stage-c-rebenchmark-results.json)
  — the re-benchmark on the trio tip (2026-08-18, `b54bf5215`).
- [`stage-c-ow28-review-report.md`](stage-c/stage-c-ow28-review-report.md)
  — #5968's adversarial review + author resolutions.
- [`stage-c-lunch-review-report.md`](stage-c/stage-c-lunch-review-report.md)
  — #5969's two-round self-review.
- [`stage-c-tuning-review-report.md`](stage-c/stage-c-tuning-review-report.md)
  — #5991's adversarial review + builder disposition.
- [`stage-c-tuning-independent-review.md`](stage-c/stage-c-tuning-independent-review.md)
  — #5991's second review round: the independent adversarial review of
  the tip `2e9d86478` (LANDABLE-WITH-FIXES; MINOR-1/2/3 → `b54bf5215`),
  recovered verbatim from the coordinator's session transcript (added
  after the handoff, 2026-08-18).
- [`stage-c-ow31-scope-report.md`](stage-c/stage-c-ow31-scope-report.md)
  — the OW31 write-authority scoping report behind the 2026-08-18
  ruling (added after the handoff; the register's OW31 row carries the
  ruling and the work order).

`fan-out/` (the design behind fan-out stages A/B, 2026-08-16, P7 head
`6d18d6998`; kept here because stage C is that design's closeout stage):

- [`fanout-run-supply-design.md`](fan-out/fanout-run-supply-design.md)
  — the design scout's design + implementation plan (§A–§K).
- [`fanout-design-panel.md`](fan-out/fanout-design-panel.md) — the
  adversarial panel (BUILDABLE-WITH-AMENDMENTS).

Not in this folder (pending at the handoff): the design pass's
reconciled report `stage-c-design.md` (§7). Raw run artifacts (driver /
test / toolshed logs, per-run sqlite stores, CPU profiles, the
`run-arm.sh` / `wait-load.sh` / `extract.py` scripts) stayed in the
sessions' scratchpads and are described in each report's preamble.
