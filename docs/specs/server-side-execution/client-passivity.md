# Client passivity: the no-dual-execution end state

**Status: PANEL-AMENDED PLAN (2026-07-26). Theory ruled SOUND WITH
AMENDMENTS by the adversarial panel (21 verified findings, 2 refuted, 8
confirmations — archived verbatim at
`docs/history/development/design/client-passivity-panel-2026-07-26.md`).
P0 built and ACCEPTED, P1 first results in — see §0. The §5b/§5c build
logs are the evidence record; §6 remains the phase table.**

## 0. Where we are and what's next (2026-07-27 consolidation — START HERE)

**Motivation (the owner's end state, unchanged):** all standing
reactive work — computations AND effect builtins — runs server-side;
the client on startup does no compute beyond render; only handler
invocations trigger client-side speculative work, and only the
handler's own writes propagate to the server. Multi-user is the
sharpest payoff: today N clients each recompute everything and thrash
commits against each other; in the end state the server arbitrates
once and clients receive canonical values.

**Where we are — P0 ACCEPTED, P1 measuring (all landed on
`codex/server-execution-w1-2-shared-pool`):**

- The executor-liveness stack works end to end on the real browser
  workload. Six mechanisms, each measured into existence red-first:
  demand grace + shrink gate (navigation blips), sponsor re-anchor
  (`a83598773` — the (connection,session,token) pin heals in place
  across all four consumers), the activation pump (`ea5e315fa` —
  per-piece items, newest-first; control ops wait ≤1 pull), the
  cold-refresh debounce (`869536c75` — growth re-traversals
  duty-bounded per watch), the piece linger (`e47328b36` — removal
  fences authority now, keeps the graph warm), and the admission
  unfreeze (`d28092a64` — set-demand replies at lane application).
- **P0 acceptance (`223bd46e8`):** the persistent-page scenario
  (`CF_NOTE_CREATE_TIMING_SERIES=20 CF_NOTE_CREATE_TIMING_DELAY_MS=
  3000`, fresh store) ENGAGES: claims 78-153/run, settlements
  committing, zero failures; time-to-first-claim ~1.5s warm. The
  storm variant (delay 0) is retained as the published cold-start row.
- **P1 first results (§5c):** single-user engaged cost +7% median
  (adjacent A/B pair; near-parity ex-tail). Multi-user (new
  `CF_CHAT_MESSAGE_SERIES` two-browser leg): engaged PARITY — 602 vs
  637ms propagation — while the server absorbed 594 claimed-attempt
  conflicts for 14 commits at zero client cost. The engaged tail
  (+1.5→4.7s late iterations) is ATTRIBUTED: serving-path schema
  traversals growing with doc count (tracker keys 253→850+), landing
  in client viewIdleWait; conflicts/claims/refreshes exonerated.

**Why multi-user is not faster YET (the honest core):** arbitration
alone cannot speed clients that still execute everything locally —
flag-on today ADDS server execution without REMOVING client
execution. The removal is P3+P5. Today's parity-at-594-conflicts is
precisely the foundation those need.

**Forward steps, in order, each with its motivation and gate:**

1. **Serving-path traversal coverage/memoization — BUILT 2026-07-28
   (§5d), gate substantially met, residuals named.** The instrument
   (`50af1a5d3`) REVISED the attribution: per-wave serving traversal
   time was flat — the mechanism was per-call demand-pull cost growing
   with closure size (8→21ms avg, single pulls stalling the serving
   loop up to 1.2s) at ZERO selector coverage, plus a broken interior
   link-coverage key that had the skip machinery inert for unscoped
   links. Landed (`225a4c6b2` + `9bb9e5eec`): interior skips
   un-broken; `omitWatchCovered` wire opt-in for watch-tracked
   sessions; executor closure-growth pulls integrate the enumerated
   frontier via exact `docs.read` POINT READS (zero traversal; the
   schema-true frontier graph-pull first cut was REFUTED by its gate
   pair — backlinks re-entered the whole closure). Result (§5d):
   `graph.query.demand` 20.6s→3.9s (max stall 1.2s→132ms); engaged
   late-half median EXCESS over flag-off +617→+201ms at ~2× the
   engagement. Residuals → follow-up: (a) same-flush demand+wave
   trigger override sends growth down the full-pull path (233 wave
   re-colds, `graph.query.wave` now the second cost); (b) docs.read
   frontier batching (5.5k calls/9.8s); (c) an unattributed 3.5s
   spike note in the flag-on arm (plausibly the P4 conflict class).
2. **P4 defer-then-(b) — RETRY-DISCIPLINE HALF DONE 2026-07-28
   (§5e); (b)-speculation half stays deferred per D1.** The step-2
   probe found the 594:14 datum had DISSOLVED after step 1 (62
   conflicts for 59 commits — the storm was a stale-replica artifact
   of slow growth pulls; re-probe a datum before building on it). The
   residual: 0ms-gap micro-bursts (one action, 36 straight conflicts —
   the catch-up gate wins instantly while contention persists). Landed
   `e6f1315c7`: consecutive-conflict streak backoff (2nd conflict on,
   25·2^(n-2) ms capped 400; success clears). Gate MET: max streak
   36→5, per-post max 1259→951ms, median within run noise, failed 0.
   REMAINING P4 (deferred until P1 coverage data prices the warm set,
   per D1): the full (b) view-feeding speculation machinery — warm-set
   enumeration/budget, write-targets-in-doc-set, divergence counters,
   D5 hold-never-flicker UX.
3. **P2 serving coverage — first slice DONE 2026-07-28 (§5f); the
   remaining inventory is the OWNER rank question + the R5 effect
   rows.** The taxonomy pass proved the chat leg's
   `malformed-output-surface` ×39/18 was a diagnostic-labeling defect:
   all offenders are the DOCUMENTED §4 output-widening pair
   (well-formed certifier summaries), mislabeled because the
   classifier's pair collapse ran lane-only. Relabeled (`c2cc3891e`,
   admission byte-identical) — the live inventory shifted to exactly
   the truthful classes: `non-space-read-scope` ×191/20 offenders
   (**the C1.5a/C2.5 RANK-DIAL enablement question — owner-gated per
   CA4; 14/15 fixture offenders classify claim-ready at user rank
   with the dial on**), lease-fence ×62 transients, two singletons.
   REMAINING BUILD — **now the whole of step 3, and the next build to
   start** (the computation side closed 2026-07-28, see the §5g note
   below): the R5/R13 effect rows, which no relabel and no rank dial can
   serve. Priority is **crossing-weighted per CP10** — a mid-chain
   unservable strands everything downstream of it, so it outranks a leaf
   with higher raw incidence. The worklist, from the R5 register row
   (context-lattice-execution.md §8 R5) and R13:
   1. **Broker implementations** for the effect builtins that have none:
      `llm`, `sqliteQuery`. (`streamData` was the third; P2.0 corrected
      its kind to `isEffect: true`, pinned by
      `builtin-effect-registry.test.ts`.)
   2. **W2.15-shape descriptors** for computation builtins that lack
      them: `llmDialog` (CONFIRMED a computation — CP6's egress claim was
      REFUTED, it orchestrates effect-classified `llm` nodes with no
      direct egress of its own), `compileAndRun`, `sqliteDatabase`,
      `navigateTo`, `inspectConfLabel`.
   3. **R13 `wish`** — static identity, no descriptor; shape decided by
      the resolver contract (plan W2.15b). Measured ×4 in the flagship
      fixture, so a real hole rather than a corner.
   4. **The served sqlite-op commit path per D2** (routing-layer
      lane-scope admission + row-label re-derivation). D2 says BUILD it;
      the permanent-ruling alternative was rejected because CP21 shows
      the required static detectability is structurally absent.
   Why this is the right next build and not more computation coverage:
   README §1 (2026-07-28) records server-side authority and quota over
   effects as a GOAL of the move rather than deferred hardening, and
   notes these calls already transit our server — so this row
   consolidates control we are already paying for. Gate unchanged:
   inventory empty or per-action-gated — the computation side now IS
   per-action-gated (on the rank dials); the effect rows are the open
   build.
   ALSO CLOSED with the same runs: §5d residual (a) — all 55
   demand→wave trigger overrides were `closure-growth`+`closure-shrink`
   composites (the shrink genuinely needs the full re-walk with
   removes); working as designed, probe (`0cb2ca92e`) stays as the
   permanent split.
   **RANK-DIAL QUESTION ANSWERED 2026-07-28 (§5g) — NOT a flip.** The
   CA4 audit found the gate is not ordering (that invariant was lifted
   with C2.6) but WIRING: all four dials in the bundle are
   programmatic-only with no deployment path, and the browser client
   cannot negotiate `context-lattice-claims-v1` at all — which, through
   the principal-wide cohort gate, makes the two-browser payoff surface
   §5f named unmeasurable today. Measured buy on the real product
   (router seam, three arms): **16 of 20 stranded derivations promoted,
   17 user-rank candidates, ZERO placement regressions** — but two NEW
   per-attempt rejection classes at the §4 write-shape firewall that
   "claim-ready" counting cannot see. LIVE, product SERVED by a real
   executor for two principals up the ladder: `non-space-read-scope`
   **33 events / 19 offenders → 1 → 0**, claim-ready 27 → 43 → 46, ZERO
   failed/unserved settlements and zero firewall rejects at every rank,
   isolation and per-user correctness intact — at roughly double the
   attempts and conflicts (8 → 22 → 21) for 2 → 8 → 9 committed
   settlements. Two live residuals the plan did not predict:
   `dynamic-write-outside-static-surface` ×12 surviving BOTH scoped
   ranks, and **R7's `claim-context-mismatch` acceptance criterion
   failing on the flagship product** (5-6 → 2 → 2, expected hard-zero at
   session rank since C2.10 retired the cause) — DIAGNOSED and FIXED in
   §5g. Claim rank and the engine's effective context were computed by
   two different functions, and only the engine's saw the durable
   monotonic context floor that an ordinary CLIENT run can pin to
   `session`; the host now consults that floor at ISSUANCE and declines a
   claim broader than it, turning a burned run into a free refusal.
   Ladder now **2 → 0 → 0** (hard-zero at both scoped ranks, pinned).
   Sequencing in §5g: `dynamic-write-outside-static-surface` next, then
   client-side negotiation (F5-style gate), then the dial bridge.
4. **P3 passivity mechanism** (per-session subcap, passive-mode
   demand producer, dynamic-reactivation contract, effect-attempt
   journal) — the client stops running standing work. THIS is where
   single-user boot shifts and multi-user gets faster.
5. **P5 passive delivery + warm spaces** (demote-never-retire, D3
   push-then-catch-up boot seed) — makes the persistent-page premise
   true for real returning users; kills the cold-start cliff jointly
   with step 1.
6. **P6 acceptance** — the three-way at protocol n, fully-engaged ≤
   flag-off on interaction AND boot, engagement by counters, cold row
   published alongside.

**BUILD ORCHESTRATION — start here if you are picking the work up:**
[`passivity-arc-orchestration.md`](passivity-arc-orchestration.md)
carries the arc's state, the standing knowledge that is expensive to
rediscover (executor serve discipline, CFC fixture requirements, test
topology, the known-flaky gate, the R5 mechanism, the pre-diagnosed
`llm` hole), and a pre-written delegation prompt per work item. It is
designed so a fresh context can drive the whole arc without re-deriving
any of it; keep its §1 state table and §6 log accurate as work lands.

**Measurement protocol (hard-won, mandatory):** fresh store per run
(`rm -rf packages/toolshed/cache` after stopping the 750 servers);
kill leftover `ms-playwright` browsers between runs; record load
average; full-capture harness output (never `tail`); curl
`/api/health/stats` in the same command right after the harness
exits; compare arms only in ADJACENT pairs; real-Worker e2e suites
run one file per deno invocation; engagement counters on every
number or it reads "not engaged".

## 1. The theory (owner, 2026-07-24; panel-qualified 2026-07-26)

1. All *reactive* operations — standing computations and effect builtins —
   are servable server-side; nothing reactive is client-only. Only event
   handlers (Phase 5) and render are client-inherent. *(Qualified by the
   serving-coverage worklist in §3 — architecture true, registry has
   named holes until P2.)*
2. Therefore a client can stay **passive**: it receives server-pushed data
   and runs no standing reactive work. On a user action (an event), the
   client syncs **only the state change** (the handler's writes), while
   **speculatively** applying the change locally for latency. For
   **claimed and served** actions the canonical value arrives from the
   server. *(CP1: the dynamic fail-open class — revoked claims, unserved
   candidates, firewall discards, de-claimed actions — is
   client-authoritative **by design**; its mandated client rerun-commit
   IS the canonical value. Passivity must keep that rerun executable:
   suppression demotes client machinery, it never deletes it.)*
3. Therefore startup shifts computation from client to server (the client
   boots by receiving materialized state, not by computing it), and
   update "storms" collapse to at most one extra round **for
   non-conflicting interleaves** *(CP7: a read-set conflict on the
   handler commit currently retries on timer backoff, not catch-up
   gating, with an overlay-drop flicker — the conflict path is priced
   and repaired in P4, not assumed away)*.

Goal (retained verbatim as the end bar): **no e2e latency increase from
shifting computation to the server** — fully-engaged flag-on ≤ flag-off,
within noise, on the three-way n=20 protocol (interaction AND boot).
Panel restatement (CP3/CP15): parity is claimed for the
**warm-path/speculation-hit case** and must be *measured and
owner-ratified as budgets* for the tails — canonical-first misses, cold
paths, conflicts, authority crossings, and fail-open reruns (§6 P6).

## 2. Why this is the design's own end state, not a new direction

The register and goals already name every piece:

- **G17** (README §9): "complete-closure client-compute suppression with
  cold remote-owned actions — remove N× local compute — later; Phase 2
  only suppresses writes/effects." Today's flag-on client suppresses
  claimed actions' *writes and effects* but still **runs their
  computations locally** — which is why it holds execution closures at
  all. G17 is the passivity step, designed and unbuilt.
- **§5.B.3 / G13**: dual handler execution — client speculative handler
  run + server authoritative run via signed envelopes; "the client's
  speculative run never commits." The speculation half of the theory is
  pre-designed for handlers. *(CP7 correction: §5.B.3's conflict-retry
  citation is timer backoff in code, not `readyToRetry` — README edit
  owed.)*
- **R10**: "client compute for claimed actions (N× speculation) and
  graph-query subscription serving" is carried as a *standing machinery
  cost* row, resolved by "Phase 3 feed + G17 suppression."
- **F3/F6/F2**: the `docs` watch (view-subscription primitive),
  session-scoped cohort delivery, and 0-DAG member point reads are
  exactly the passive-client delivery substrate — built and measured
  (CP27 confirms the steady-state 0-traversal claim against code and
  counters).
- **§4 expected shape**: "server compute approaches the sum of client
  compute — the §2.1 N× redundancy replaced by 1× client speculation +
  1× server verification per session, which G17 then reduces client-side."
  The theory tightens this: for standing work, 0× client + 1× server;
  speculation only downstream of local events.

## 3. Premise inventory (what "everything runs server-side" is worth today)

**Documented worklist (register, verified at tip by the panel — CP31):**

- **R12 resolved** (C2.8): scoped-lane effect egress landed; broker
  egress is authorized only by the live lane grant at the bound
  generation, acting identity host-derived (CP29 confirms). Residual:
  *offline* egress under standing keys (zero connected sessions ⇒ no
  grant ⇒ no claim), riding OQ1.
- **R13 open**: `wish` has static identity but **no descriptor** — not
  servable; measured ×4 in the flagship fixture (W2.15b owed).
- **R5 open worklist**: effects lacking server implementations — `llm`,
  `sqliteQuery` (broker implementations); builtins lacking server
  descriptors — `streamData`, `llmDialog`, `compileAndRun`,
  `sqliteDatabase`, `navigateTo`, `inspectConfLabel`. **CP6 (blocker):
  `streamData` performs arbitrary fetch egress but is REGISTERED as a
  computation** (no `isEffect`), so the effect/computation line the
  never-speculate-effects rule keys on has corrupt inputs — the P2.0
  classification audit (both registration channels) and a fleet-wide
  kind flip precede any servability work on these. `llmDialog` is a
  register/doc mis-bucketing only (runtime hole refuted).
- **CP21 (serious)**: sqlite unservability is *categorical at the
  routing layer* (`dynamic-sqlite-operation` fires unconditionally) and
  rides arbitrary callers' commits — statically invisible, so a
  claim-then-always-unserve action would leave NOBODY computing under
  naive suppression. P2 carries the owner decision (D2); P3 must handle
  the claim-ready-but-never-servable class regardless.

**Empirical sweep (2026-07-24/26, real browser, base flag-on, n=10): the
executor never ran.** `claimsIssued=0`, `workersStarted=0`,
`workerStartAborts=2`, `parkedWakeAttempts=2 / parkedWakeStarts=0`, with
1,505 demanded pieces across 15 demand snapshots. Cause (toolshed log +
`shared-execution-pool.ts:628`, CP26 confirms in code): the browser
clears execution demand on navigation transitions; `demands.length === 0`
**aborts the in-flight Worker start**; real navigation cadence beats
Worker cold-start; parked wakes skip on the same empty-demand check and
never revive. The pool converges to never-live under the real workload.
CP13 sharpens it: the ONLY demand producer is the client runner's local
piece-start path — the very machinery passivity suppresses — so P3 must
introduce a passive-mode demand producer or the executor never starts at
all. CP14 bounds the fix: demand-emptiness grace is pool-side start/stop
damping ONLY, bounded by the host's session-anchored authority lifecycle
(lease-sponsor drain, lane-grant anchoring), which already disambiguates
blip from departure.

Two consequences:

1. **The unserved-actions inventory is still owed** — it needs a run with
   a live executor (P0 gates P1).
2. **Every fully-engaged e2e number measured this arc had a dead
   executor.** The measured overheads are client-side flag machinery —
   the server-authoritative round-trip the theory depends on has never
   been browser-measured. Every P1+ latency number carries
   `claimsIssued > 0` / `workersStarted > 0` as a validity precondition,
   or reads "not engaged" (CP18/CP26: this program has already shipped
   two unreachable dials and three dead-executor readings).

## 4. The measured baseline the plan must beat (2026-07-24/26, n=20 each)

| quartile avg (ms) | flag-off | base flag-on | fully engaged |
| --- | --- | --- | --- |
| notes 1-5 | 1547 | 2373 | 4342 |
| notes 16-20 | 2491 | 3778 | 7466 |
| all | **2082** | 3091 | 5447 |

With the executor dead in both flag-on legs (§3), the decomposition
reads: **+~1s = client-side flag machinery**, **+~2.4s and growing = the
doc-set client leg**, dominated by revisit-pull amplification (the
docs-watch replace destroys server-side selector coverage; 23× watch.add
DAG at equal call counts). CP11: the exact +1s attribution is contested
across this doc and the implementation plan — the P1 instrument-split
((a) claim/feed bookkeeping, (b) demand signaling, (c) doc-set
reconcile, (d) residual) settles it on the record.

Reading for the theory (CP11-corrected): a passive client issues none of
the **closure-pull share** of this cost; demand signaling, claim/feed
bookkeeping, and membership upkeep are **retained by design** and must
be measured, not assumed deleted. What passivity adds — served-value
round-trips on the interaction path — is exactly the unmeasured quantity
(P1).

## 5. The sharp edges (panel-resolved constraints)

1. **Speculation scope.** (a) direct handler writes only; (b) writes +
   pure computations feeding the current view; (c) never effects —
   structurally excluded, keyed on the **P2.0-audited effective kind**
   (CP6), covering ALL local effect re-execution paths: speculation AND
   the fail-open/revoke rerun (CP17). CP2 (blocker): under (b) the
   client needs a **warm set** — compiled programs, scheduler-graph
   registration, closure docs — whose standing cost is exactly the class
   §4 counts against the hybrid; it must be enumerated, maintained, and
   counter-bounded, never assumed free. The speculable closure =
   **transitive inputs** of view-feeding computations ∪ speculative
   write targets — NOT "≈ the doc-set held" (CP2/CP9/CP23). Scope choice
   is owner decision D1.
2. **Convergence semantics.** The claimed-overlay/settlement machine is
   sound for its built case (CP24) but engages only when the client ran
   the claimed action — P4 extends it to speculative (unclaimed) runs.
   Known repairs: catch-up-gated conflict retry replacing timer backoff
   (CP7); premature drop of CORRECT speculation under the scalar basis'
   false-coverage window becomes a distinct counted case with R11
   windows re-derived — the server settle pipeline is now the sole
   healer (CP8). Divergence UX is owner decision D5 across all three
   cases (true divergence / premature drop / conflict overlay drop).
3. **Executor liveness under real demand cadence** (§3): joint
   demand+claim retention window ≥ measured Worker cold-start;
   parked-wake revival; demand-ADD for never-demanded pieces (creation
   flow, CP22); grace bounded by the host's existing session-anchored
   authority lifecycle — pool damping only, departure semantics
   byte-identical (CP14).
4. **Serving completeness**: P2.0 classification audit first (CP6), then
   the R5/R13 worklist in **crossing-weighted** order — a mid-chain
   unservable action forces an extra authority crossing (push-down +
   client compute + commit + wake) and outranks leaf incidence (CP10);
   sqlite per D2; per-action fallback for anything unservable via the
   existing per-claim routing seam + A3 counters (CP28).
5. **Handler input closures**: handlers read state beyond the view
   (CP23's drop-handler dedup scan is in-closure only by accident of a
   count-in-name); the closure definition is transitive inputs, and
   handler-read-miss semantics (abort speculation vs event-time fetch)
   is a P4 decision with a classifier gate.
6. **Boot path**: warmth is achievable only for **space-rank** state;
   session-rank lane state is **cold at every boot by construction**
   (demand exists only while the session is connected — CP4), and k
   concurrent boots serialize on one space Worker. P1 decomposes boot;
   D3 picks the session-rank seed policy; the P6 k-concurrent-boot gate
   escalates to OQ5 (Worker-per-lane-group) rather than silently
   relaxing (D7). F4b's server-side one-shot boot-root evaluation is a
   named P5 dependency.
7. **Offline / degraded**: resolved by adopting README §5.B.1/§5.B.8
   verbatim — offline = speculation-only reactivation + queued
   source/handler/UI commits; claimed derived writes never flush; the
   reconnect barrier resolves authority; effects are excluded from blind
   replay (CP1/CP17). Passivity is a *connected mode*; the local engine
   is demoted, never deleted.
8. **Mixed fleet / migration**: per-session subcap layered above
   claim-routing-v1, NEVER added to required capabilities (the CP5
   refutation depends on admission-required base caps staying
   admission-required); the P3 wiring surface (server env application at
   construction, shell define, env global, advertisement golden,
   realm-separated negotiation gate) is a named deliverable — this
   program has shipped two unreachable dials (CP18). Rollout is the P5
   **two-stage per-space** sequence: stage A graph-retirement soak in
   hybrid mode (the doc-set substrate's only real-browser soak — its one
   engagement surfaced two storm defects, CP19), stage B passivity flip;
   never the same dial event. Stage-A cost/sequencing is owner decision
   D6.
9. **Confidentiality**: the push-side boundary is **registration-time
   resolution (wire scope key = ProtocolError) + lane-grant-validated
   acting context + per-member read context + FA6 mismatch drop**
   (CP30); **F6 cohort gating is a fail-open delivery-efficiency filter
   and must never be cited as the confidentiality gate** (CP20). P5
   binds these three invariants by name in red-first confinement gates
   (including a cohort-metadata-free broadcast variant). Speculation
   closures resolve entirely within the session's own cohort, fail
   closed (CP16 refuted the leak but the invariant is stated
   positively). Double egress across revoke/mode transitions is closed
   by the P3 effect-attempt journal — durable pre-egress intent +
   completion marker; the Tier-2 intent/attempt ledger's "one engine"
   deferral premise is falsified by passivity (CP17).
10. **Latency accounting (CP3, blocker — the central correction).**
    Served canonical values do NOT ride the handler-write's
    accepted-commit push: they cannot exist yet. The real chain is
    commit RT → executor observation (live or parked wake) → recompute →
    settle (~0.5–0.9s today) → **a second refresh wave** whose
    scheduling includes a drain-wait that grows under concurrent-client
    load → client apply. P1 budgets every component (k ∈ {1,3,10}
    client legs); P6 gates canonical-arrival p50/p95 (D4 sets numbers
    from P1 data, not invented today). Parity therefore rests on
    speculation coverage: P1 classifies every interaction (hit /
    canonical-first / divergence) and P4 ships a predicted-coverage
    statement with live counters (CP15).
11. **Event-time piece creation (CP22, new).** The dominant creation
    flow (`navigateTo(Note({...}))` inside a handler) makes a piece that
    is in no doc-set, no demand snapshot, and has no push to ride —
    first paint waits the full cold chain. P0 covers demand-ADD; P4
    decides speculate-creation-locally vs a declared, budgeted cold
    path; P6 measures creation first-paint as its own class.

## 5b. P0 build log (2026-07-26) — landed, one named residual

P0 shipped in four commits (grace window 7a7470bef, sponsor re-anchor
275f61af0, Worker-init deadline dial 64ec6e24f, cold-start-protection
pin 8fe14ab6f), each red-first with mutation discrimination; pool suite
38/38. The acceptance loop against the real n=10 browser workload then
peeled three successive liveness layers — each fix exposing the next:

1. **Grace** fixed start-aborts-on-navigation-blip; the executor went
   live for the first time (`workersStarted=1`, `parkedWakeStarts=1`) —
   and exposed that with 10s grace its live windows were too short.
2. A 60s-grace probe kept the Worker up all run: 45 scheduler runs, 34
   shadow transactions, **32 candidates claim-ready — and all 32 refused
   with `claim-authority-lost`**: the lease pins its sponsor at
   acquisition and the pre-grace demand churn had been the de-facto
   sponsor rotation. → the **sponsor re-anchor** (diagnostic-driven
   generation replacement, cooldown-bounded).
3. The defaults rerun then failed both Worker starts at exactly the
   library's 30s init deadline (boot completing moments later) → the
   **init-deadline dial** (toolshed default 120s).
4. **P0-R1 CLOSED (087ba15a5):** the Worker's initialize handler gated
   its "ready" reply on `await enqueue(replaceDemand(pieces))` — full
   initial piece activation, which under live client load outlasts any
   deadline while the runtime is already executing. Detaching the await
   (activation still serialized on the work queue; failures via
   postFatal) made starts reliable: 2/2 Workers live, zero
   aborts/failures/expiries, still active at run end, across every
   subsequent acceptance run.
5. **P0 continuation (edbbcd588, 67c529a55):** leg-discriminated decline
   observability (permanent) then peeled two more causes: (a)
   `sponsor-demand-gone` 53/53 — the client publishes a transient EMPTY
   demand set on every same-space navigation and claim issuance
   re-validates the sponsor's demand row at claim time; fixed at the
   producer by the ExecutionDemandShrinkGate (growth immediate, shrink
   held 10s and folded; 53 → 1); the server-side sponsor REBIND
   (re-point a live lease's sponsor triple in place, no Worker restart)
   landed for the session-churn case with generation replacement demoted
   to fallback. (b) Also found and cleaned: the pre-rebind wedged drains
   leak ORPHANED toolshed processes that keep appending to the shared
   log — always verify serverStart before trusting log/stats agreement.
6. **P0-R2 (stale sponsor pin) FIXED — and it exposed P0-R3 (item 7).** The
   instrumented probe run (renewal decline legs + owned-deletion cause
   logs + not-owned sub-legs) overturned the not-owned theory: the rerun
   showed ZERO not-owned declines — instead 54/54 `sponsor-demand-gone`
   with the Worker fully live (166 scheduler runs, 133 shadow
   transactions) and, decisively, **54 authority-loss notes producing
   ZERO pool rebind attempts** (`sponsorRebinds=0`) plus 2 renewal
   declines `durable-renew-refused` that released the leases as revoked.
   Root cause, confirmed in code: the lease pins its sponsor as a
   host-local **(connection, session, token) triple**, and the browser
   breaks that triple routinely without surrendering anything — sessions
   OUTLIVE connections (resume), demand rows are CONNECTION-scoped, and
   an explicit demand clear on page departure removes the pinned row
   without any drain. Four consumers then failed the same stale pin
   differently: claim issuance (`sponsor-demand-gone`), claim renewal
   (revokes the live claim), lease renewal (`authorizeWrite` checks
   `#connections.has(pinnedConnection)` → durable refusal → the pool
   tears the whole generation down within TTL/2), and the ACL
   ineligibility sweep (drains the lease outright). Fix (this commit):
   one shared `#reanchorExecutionSponsorInPlace` — when the pinned
   binding goes stale on a live un-drained lease, re-point it at the
   best live demander of the SAME principal (acquisition candidate
   order) and let THIS operation proceed; decline only when no target
   exists. Wired into all four consumers + the pool-facing rebind now
   delegates to it. Contracts preserved and pinned by tests: the
   "sponsor disconnect drains before a remaining writer can replace it"
   auto-drain is untouched (re-anchor refuses under `drainRequested`);
   re-anchor NEVER crosses principals (new lease-test); the drain-window
   semantics (explicit demand clear leaves the lease renewable) survive
   (the staleness check deliberately excludes the demand row). Red-first
   evidence: claim-issuance/lease-renewal/claim-renewal re-anchor tests
   all failed pre-fix. Also permanent observability: renewal decline
   legs (mirror of claim legs), owned-lease release/abandon cause logs,
   `not-owned[owned-missing|owned-replaced fdo A->B]` sub-legs, and
   pool-side re-anchor SKIP reasons (the 54-notes-zero-attempts
   silence, never again).
7. **P0-R3: demand-alive and claim-ready windows never overlapped —
   three stacked latency mechanisms, peeled with timestamped timeline
   probes.** The post-R2 rerun still declined 54/54 with `rows=NONE` at
   every decline: zero demand rows existed by the time candidates
   reached the host. The timeline probe (demand-row set/clear/sweep +
   claim-ready + decline, all t=) plus pool phase timing decomposed it:
   Worker spawn is a non-problem (300-700ms); the entire gap was the
   `demand-update` batch — 20.7s/28.3s at n=5, **45s/83s at n=20**
   (scales with client load), with the claim-ready burst landing
   exactly at batch completion, after the page (4-12s demand lifetime)
   had departed. Mechanisms, in the order found: (a) the worker's
   `replaceDemand` was ONE monolithic queue item — sequential
   activate+settle-barrier per piece — so candidates, claim activation
   (`run-claimed-action` rides the same queue), and later snapshots all
   waited for the whole batch → split into a structural swap plus
   per-piece work items, with the set-demand reply resolving at the
   structural swap (activation observable via settle()'s fixpoint, not
   the reply). (b) Worker-side emission probes then showed candidates
   DO emit per-piece (first burst 21.5s → 7.8s) but the host attempts
   them only in one burst at set-demand completion: the host holds its
   candidate-admission lane across the whole setDemand await, and a
   later snapshot's structural swap still queued behind the whole pull
   backlog (grow-by-one snapshots every ~1-2s vs 8-20s per heavy
   pull → the backlog only grows). (c) → the **activation pump**: one
   piece per queue item consumed NEWEST-FIRST from a pending set, so
   control operations wait at most the single in-flight pull, and the
   most recently demanded piece (the one a live client is looking at)
   activates next. Fixing the six timing-coupled tests that assumed
   activation completes within microtasks of start()/pool.idle() —
   they now await candidate/settle barriers. Dead-end theory recorded:
   the A24 demandGeneration candidate fence does NOT drop space-lane
   candidates (the space generation is a constant 0; only scoped lanes
   carry live generations).
8. **P0-R3c BUILT — the adaptive cold-refresh debounce.** (Diagnosis
   below written first; the fix as landed:) the per-refresh attribution
   probe overturned the never-held theory — **99.6% of the 562 cold
   refreshes were `closure-growth`** (one watch 147×: every note-create
   and content commit grows some watch's closure and re-ran its FULL
   traversal). Fix: a demand-triggered cold refresh is rate-bounded
   per watch by `COLD_REFRESH_DUTY(4) × its own last refresh cost`
   (clamped [250ms, dial]), so each watch spends a bounded fraction of
   wall time re-traversing regardless of commit rate. Growth events
   inside the cooldown defer their notices via the FB13 carrier; a
   tail timer guarantees the flush when no later wave retriggers;
   wave-triggered re-colds (shrink/re-key/untracked-root — they carry
   removes) bypass the debounce. TWO subtle bugs found red-first by
   the new contract test: (a) the growth detector is deliberately
   EDGE-triggered (old-vs-new target diff — the guard against
   selector-cut links re-colding forever) and the debounced pass's
   point update consumes the edge, so the deferral must carry an
   explicit owed-traversal debt (`#owedColdRefresh`, cleared only when
   the traversal runs, restored on refresh failure — the pre-existing
   FB13 failure path had the same latent consumed-edge gap); (b) the
   owed debt must merge into the cold set BEFORE the empty-wave early
   return, because a deferred notice's retry produces neither point
   tasks nor fresh cold marks. Dial:
   `EXPERIMENTAL_SERVER_PRIMARY_EXECUTION_COLD_REFRESH_COOLDOWN_MAX_MS`
   read lazily in the Worker realm (Workers inherit process env — the
   CF_LOG_TIMING channel); unset/0 = legacy refresh-every-wave (the
   whole existing provider suite pins that contract);
   startServerExecutionPool defaults it to 2000 so server-primary
   implies the debounce. New contract test: two in-cooldown growth
   waves (the second RETARGETS the link) coalesce into ONE traversal
   at the latest sequence — the retargeted-away doc never enters the
   replica.

   **Measurement-hygiene finding (P0-R3c epilogue, 2026-07-27):** three
   consecutive harness failures (the notebook rapid-create test, 23s →
   3m+ stalls) implicated the debounce until a dial=0 control ALSO
   failed — the real driver was the acceptance toolshed's
   **accumulated store** (`packages/toolshed/cache`, 5.7 GB across ~12
   runs since 2026-07-17): a fresh store passed immediately, dial on.
   Consequences: (a) every timing number in this log was measured
   against a monotonically growing store — cross-run comparisons
   (7.8s vs 40s first-candidate) partly reflect store growth, not just
   client load; (b) the acceptance recipe gains a mandatory step:
   stop servers, move/remove `packages/toolshed/cache`, THEN run —
   every measured run starts from a fresh store (the P1/P6 protocol
   inherits this); (c) the first fresh-store run shows the cold-cold
   shape (fresh space + cold compile): first candidates at ~90s,
   declining `not-owned[owned-missing]` — the lease correctly expired
   with its demand long gone, so the n=20 fresh-store ladder is the
   next measurement.

   **Fresh-store n=20 (the current frontier):** test green, workers
   alive all run, ZERO authority failures of any kind (no lease
   losses, no declines — R2 and the demand/liveness stack are fully
   healthy) — and ZERO candidates reached claim-readiness inside a
   **169-second** demand window (the fresh-store first run bootstraps
   slowly: ~7-8s per note). 473 cold refreshes (debounce-bounded) and
   98 shadow transactions show the Worker computing, but the
   first-piece activation pipeline — the pump's activate +
   `cell.pull()` settlement barrier + feed integration under
   continuous client load — never delivered a claim-ready candidate.
   That pipeline is now the ISOLATED remaining blocker: every layer
   around it (authority, demand liveness, batch granularity,
   admission serialization, traversal storms, store hygiene) has been
   fixed and verified. Next probe (P0-R3d): worker-side phase timing
   inside the pump — activateDemand (sync+prepare) vs cell.pull
   (recompute/settle) vs accepted-commit integration stalls — one
   timestamped run names the dominant phase; candidate emission's
   dependency on the routed FIRST commit of each action is the
   companion question (a piece whose actions never complete a routed
   run emits nothing, however healthy the rest is).

   **P0-R3d ANSWERED (fresh-store n=5, phase probes committed as
   permanent [P0R3d] debug logs):** the dominant phase is **`prepare`
   — `runtime.start(cell)` inside `prepareExecutorDemandPiece`: 7.6s
   / 7.6s / 18.1s per piece** (pattern module fetch + compile + graph
   instantiation; the writer lookups around it are trivial), with the
   initial `cell.pull` second (7.4s / 4.0s), `cell.sync`
   milliseconds, and integration wave-passes mostly 1-3ms with
   occasional 1.3-3.2s spikes. With the whole prior stack fixed,
   candidates now emit INSIDE the run (first 22 candidates at 8.2s,
   more at 11.1s) — the first page's ~5.3s demand window just misses
   them (declines: sponsor-demand-gone, no re-anchor target — the
   page was gone). Two named levers for the next build (P0-R3e):
   (a) cut `runtime.start` cold cost — pre-compile/warm the demanded
   pieces' patterns concurrently with sync/feed instead of
   serializing inside prepare (the piece root names its pattern
   before instantiation), and check the pattern-compile service's
   cache behavior for the worker's fetches; (b) the probe ALSO caught
   a `resetClaims` re-instantiation mid-run — the SAME piece prepared
   twice (7.6s then 18.1s) because a lane-wire change reset
   `instantiatedDemand` and the pump re-prepared everything; audit
   whether that reset's blast radius (full re-instantiation) is
   necessary for a lane-only change.

   **P0-R3e probe results (compile-phase timing via the pre-existing
   logger.time seams, CF_LOG_TIMING=pattern-manager,engine):** BOTH
   R3e hypotheses were wrong in the details. (a) The compile cache is
   EXONERATED: the worker HITS the persisted compiled-closure cache —
   `load-pattern-by-identity` 243ms-1.0s, `evaluateRecordGraph`
   359-486ms — so of a 13.9s prepare only ~1.5s is pattern load+eval;
   the 12-32s remainder is GRAPH INSTANTIATION I/O (`runtime.start`
   building and first-running the reactive graph through the worker's
   feed-backed replica — the same per-read round-trip surface as the
   pull). Numbers swing 2-4× with machine load (7.6s → 13.9s → 33.6s
   for the same piece across runs; competing agent sessions share
   this host), so a QUIET-MACHINE note joins the fresh-store protocol
   requirement. (b) The "resetClaims blast radius" reading was wrong:
   per-lane resetClaims is ALREADY surgical (`applyLaneDemands`
   cancels only that lane's attempts and re-emits from templates),
   and the top-level nuke path appears unreachable from the pool. The
   duplicate prepare was plain navigation semantics: a page change
   genuinely removed the list piece from demand → structural stop →
   the next page re-demanded it → full 33.6s re-instantiation in the
   SAME Worker (workersStarted stayed 2).

   **The P0-R3e build, now precisely shaped — worker-side PIECE
   LINGER:** on structural removal, fence AUTHORITY immediately
   (cancel the piece's claimed attempts and release its claims — the
   promptness the executor claim-lifecycle/drain contracts pin) but
   KEEP the graph instantiated for a bounded linger window; re-demand
   inside the window cancels the linger and reactivates instantly
   (the graph never stopped) instead of re-preparing for 13-33s;
   linger expiry performs today's full stop/cleanup, and worker
   stop/resetClaims flush lingers immediately. This is the
   pool-level demand-grace philosophy applied per piece, composable
   with the pump and the debounce; claims for un-demanded pieces
   remain fail-closed server-side regardless (sponsor-demand-gone).
   The deeper instantiation-I/O cost (per-read round trips during
   runtime.start) remains the follow-on lever once linger removes the
   duplicate work.

   **Piece linger BUILT** (dial
   `EXPERIMENTAL_SERVER_PRIMARY_EXECUTION_PIECE_LINGER_MS`, worker-
   realm lazy env read, pool-start default 30000, unset/0 = legacy —
   the shape every existing executor suite pins): removal releases the
   piece's claims host-visibly (the exact action-unregistered shape
   the deferred stop would have posted) and lingers the live graph;
   revival reuses it with no re-activation and no initial pull; expiry
   runs the ordinary stop; reset and worker stop flush immediately.
   Contract test (`executor-piece-linger.test.ts`): a demand blip
   revives without re-preparing (writer-lookup count flat) and an
   expired linger re-prepares. Verification-protocol note learned the
   hard way twice this arc: run real-Worker e2e suites ONE FILE PER
   deno invocation — multi-file batteries contend in-process and
   manufacture timing failures (three "regressions" this session were
   battery/load artifacts, confirmed green serially and at every
   commit via an isolated bisect worktree).

9. **P0-R3f (d28092a64) — candidate admission unfrozen — and the
   terminal P0 frontier.** The decisive n=20 exposed the last
   structural wall: the host serializes candidate admission with
   setDemand, and the worker's set-demand reply awaited the structural
   swap — which queues behind the in-flight pump item, so ONE 37.8s
   first-piece prepare froze admission for the whole demand window
   while 111 emitted candidates queued (admitted in one burst after
   the window, declined). Fixed by replying at LANE APPLICATION with
   the swap detached (authority fencing synchronous; the P0-R1 shape).
   All twelve executor suites green per-file. The post-fix n=20
   frontier: **S1 missed its 29.7s window by ~1.5s (30.8s first
   prepare), S2 missed its 10.9s window by ~2.5s (12.9s prepare)** —
   candidates now attempt within ~200ms of emission, all authority
   machinery healthy, and the ONLY remaining gap to claimsIssued>0 on
   this harness is first-instantiation speed vs page lifetime: the
   `runtime.start` instantiation-I/O cost (which scales 2-4× with
   concurrent client load and machine contention). Two admissible
   closers, choose by intent: (i) the instantiation-I/O workstream
   (batch/pipeline the per-read round trips during graph build — a
   runner-core performance arc); (ii) recognize the harness's 5-30s
   page lifetimes as the pathological cold case the P5 warm-space
   design (demote-never-retire, push-then-catch-up) exists for, and
   let P6's measured scenario include a persistent page (real pages
   live minutes) — in which case the CURRENT stack already engages.
   Both are legitimate; (ii) matches the plan's own steady-state
   theory and unblocks P1's measurement program immediately.

10. **P0 ACCEPTANCE ACHIEVED (2026-07-27) — the persistent-page leg
   ENGAGES.** Owner-approved sequencing: (ii) first with the cold row
   retained, then (i) scoped by P1 data. The harness gained
   `CF_NOTE_CREATE_TIMING_DELAY_MS` (an inter-create delay models a
   real session: the demand window grows with the delay while the
   concurrent write load does NOT; delay 0 remains the cold-start
   storm row). First engaged run — fresh store,
   `CF_NOTE_CREATE_TIMING_SERIES=20 CF_NOTE_CREATE_TIMING_DELAY_MS=
   3000` (~90s window vs ~15-30s activation): test green, and
   **claimsIssued 78 (4 reissued), acceptedActionAttempts 60,
   settlementsCommitted 18, settlementsNoOp 42, settlementsFailed 0,
   claimedActionConflicts 96** (mid-run read shortly before the
   harness wind-down; only 13 sponsor-demand-gone declines ALL RUN vs
   54-92 in every storm run — candidates were claimed, not declined).
   Every P0 mechanism is load-bearing in this run: re-anchor (R2),
   pump (R3a/b), cold-refresh debounce (R3c), piece linger (R3e),
   admission unfreeze (R3f). The conflict count is the CP-panel's
   predicted speculation leg (client racing server on the same
   actions) — P1/P4 territory, now MEASURABLE. The server executed
   standing work authoritatively on behalf of a live client for the
   first time in the arc. NEXT: P1's instrumented program runs on
   this scenario (engagement counters now non-zero by construction);
   the cold row keeps being published as cold-start truth; lever (i)
   (instantiation-I/O, doc-set bulk-seed first) proceeds against P1's
   cold-start-distribution budget.

   Original diagnosis (superseded in one respect — the dominant class
   was growth, not never-held): the demand-pull traversal scaler.
   With the pump landed,
   the n=20 rerun put a 27s demand window against a ~40s first pull —
   the pull cost SCALES with the same client load that defines the
   window, so the worker structurally loses the race on this harness.
   The feed counters pin it exactly: `graph.query.demand` = 858 calls,
   93,932 managerReads, dag 2,576, **coveredSelectorSkips = 0** —
   ~97% of all read work; the persistent-tracker paths DO skip
   (watch.add 1,385 skips, watch.refresh 3,905), but the executor
   replica's cold-watch pull path issues STATELESS `graph.query`
   (fresh tracker + manager per call, `reuse=undefined` in the wire
   handler) ~21× per piece. Exact mechanism (v2-host-provider's
   accepted-commit integration): a watch whose FIRST pull has not
   completed has no held entities (`#watchEntities` miss), so EVERY
   wave that dirties its root re-marks it cold ("Registration never
   completed a pull; a named root is a cold repull") and the wave
   pipeline — serial by construction — runs ANOTHER full
   `refreshWatches` traversal for it at that wave's sequence. Under a
   note-per-1-2s client, that is ~21 serial full traversals per piece
   before the first one's closure ever lands, each slower than the
   last because they compete with the client on the same engine; the
   worker's `cell.pull()` settlement barrier waits behind this
   pipeline, hence first-pull cost SCALING with client load (the §4
   baseline's 23× revisit-pull amplification, now located to the
   line). The genuinely-warm paths are fine: steady waves take exact
   point reads, and only 15/881 queries were wave-triggered
   re-traversals (shrink/re-key/root-re-establishment — the narrow,
   correct cases). Fix design (needs a panel pass — it cuts into
   F5/CP3 second-wave and FB13 deferral semantics): COALESCE cold
   refreshes for never-held watches — while a watch's first cold
   refresh is in flight, later waves that would re-cold it instead
   BLOCK their notices into the existing FB13 deferred-notice queue
   (the machinery already used when a cold refresh FAILS: notices
   defer, never lost, and retry integrates them); when the first
   refresh completes and holds entities, the deferred notices retry
   through the cheap point-read path at their own sequences. Net: one
   traversal per genuinely-cold root + point-read catch-up, instead
   of one traversal per wave. Secondary (independent) lever: the
   server's session-attributed `graph.query` could consult the
   session's per-branch TrackedGraphState for covered queries — but
   the coalescing fix removes the repeat calls at the source, so
   measure after it before adding server-side complexity. Contract
   tests to hold green: executor-provider-parity / provider-demand /
   FB13 deferral fixtures, and CP3's second-refresh-wave delivery.

**(superseded numbering below)**
   with the deadline at 120s the Workers RAN (43 scheduler runs, 32
   claim-ready) but `DenoSpaceExecutor.initialize` never completed
   within the run under live browser load — the start's completion
   handshake (not the boot) outlasts minutes while the Worker is
   demonstrably executing, so the pool never marks the generation live
   (both starts died as close-time aborts). Next session: instrument the
   initialize path (which await outlasts — ready handshake, lane wire,
   initial settle?) on the live workload; P1's cold-start distribution
   measurement rides the same instrumentation. Until P0-R1 closes, every
   e2e number still reads "not engaged" per the P6 validity rule.

The P1 unserved inventory now has real data across three runs: the
serving holes on this workload are tiny (`malformed-action-observation`
1-2×, `incomplete-static-surface` 1×, `dynamic-write-outside-static-
surface` 2×) — consistent with R5/R13 being the only structural gaps.

## 5c. P1 first results (2026-07-27): the engaged three-way, n=1 per arm

The first per-iteration flag-off vs flag-on comparison on an ENGAGED
system (persistent-page recipe, fresh store + quiet machine per run;
full-capture protocol — no `tail` on the harness output). Run B
engaged from **iteration 2** (first claim-ready at **+1.5s** from
first demand — the warm-compile fast path with every P0 fix
load-bearing; contrast 21-38s in the storm runs), and finished at
claims 153 / attempts 77 / committed 24 / noop 52 / **failed 0** /
conflicts 95.

| iter | A flag-off (ms) | B flag-on (ms) | Δ |
| --- | --- | --- | --- |
| 1 (cold) | 706 | 606 | -99 |
| 2-20 (engaged) median | 908 | 975 | **+67 (+7%)** |
| spike iters 8 / 18 | 842 / 1265 | 1725 / 3308 | +883 / +2043 |
| full-run median (q1-q3) | 879 (663-1033) | 967 (830-1525) | |

Reading, with the honesty rules applied: (a) the bar ("engaged ≤
flag-off") is NOT yet met at the median — but the gap is +7% with
overlapping quartiles at n=1 per arm, against a day of 2-4×
machine-load swings: directional, not final; the protocol's n=20 per
arm decides. (b) The delta DECOMPOSES visibly: a small steady
overhead (~+30-100ms on most iterations, several iterations
NEGATIVE) plus large spikes on exactly the iterations where
claimed-action conflicts land (95 conflicts; iters 8/18) — the
client racing its own server executor on the same actions, i.e. the
CP-panel's predicted speculation leg. The next P1 instrument is
per-iteration conflict attribution (correlate conflict events with
iteration windows) feeding P4's defer-then-(b) speculation design —
if conflict-retry stalls explain the tail, the steady-state engaged
cost is already ~parity and P4 is where the bar gets met. (c)
Cold-start (iteration 1) was FASTER flag-on in this run — noise, but
consistent with the executor absorbing no client work while cold.

**Conflict attribution (Run C, the timestamped transact-conflict
probe — permanent, mirrors the decline legs):** the spike hypothesis
is REFUTED, replaced by two better findings. Run C: claims 95 /
committed 28 / failed 0; conflicts split **41 claimed-attempt vs 2
client-commit**. (a) The claimed-attempt conflicts cluster on
iterations 7-10 (12-14 each) whose latencies are NORMAL (751-1211ms)
— a claimed attempt losing its race retries server-side and costs
the client NOTHING; the conflict machinery is client-free. (b) The
escalating tail (iterations 12-20: 1.5s → 4.7s, monotone) carries
ZERO conflicts — the engaged overhead SCALES WITH LIST SIZE. Next
instrument: per-note growth-work attribution (per-iteration
claim/settle counts + debounced growth-refresh costs + feed delivery
volume on the growing closure), pointing at the same
growth-refresh/feed surface P0-R3c bounded per-event but which
remains linear-per-event on an ever-bigger graph.

**Multi-user first pass (owner hypothesis: flag-on should be FASTER
— server arbitration replaces commit thrashing):** two-browsers
group chat 15s off vs 16s on (inner step 7s vs 9s) — noise at n=1,
but the run ENGAGED in a 9s window (claims 41 / committed 13 /
conflicts 16): multi-user engages far faster than single-user
(warm pattern cache + two continuous demand sessions). The
convergence-storm suite gained `CF_STORM_TOOLSHED=1` (points the
storm at the integration toolshed; default stays the standalone
B1/B2 pins): storm case 932ms off → 843ms on (−10%), suite 14s →
9s — DIRECTIONALLY with the hypothesis, but the flag-on storm
claimed only 1 action (the case runs <1s — mostly un-engaged), so
this is not yet an engaged multi-user measurement. The instrument
that would decide the hypothesis: a PERSISTENT two-browser scenario
(both sessions open 60s+, continuous posting at a human cadence) —
the multi-user twin of the persistent-page leg, measuring observer
convergence latency and per-post latency off vs on.

**Persistent two-browser A/B (built: `CF_CHAT_MESSAGE_SERIES` /
`CF_CHAT_MESSAGE_DELAY_MS` on the two-browsers test — 20 alternating
posts at 2s cadence, per-post send→other-browser-sees timing;
default unset keeps the assertion flow byte-identical):** flag-off
median **602ms** (q1 478 / q3 827, growing 256→~900 across the
series) vs flag-on median **637ms** (+6%, q1 461 / q3 921, one 2.1s
spike) — PARITY within noise, not faster. But the flag-on run was
deeply engaged: **claims 66 / committed 14 / noop 102 / failed 0 /
conflicts 594** — the server's claimed attempts lose races
constantly under two-client write pressure and retry server-side
with ZERO client-visible cost (the client-free-conflicts finding at
scale). Both arms grow with transcript length, so that growth is
flag-INDEPENDENT client work. Interpretation — the honest resolution
of the expects-faster hypothesis: multi-user cannot get faster from
arbitration alone while BOTH clients still execute everything
locally; flag-on today ADDS server execution without REMOVING client
execution. The removal is precisely P3 (per-session subcap
passivity) + P5 (passive delivery / demand-time closure); this
measurement establishes their foundation — server arbitration at
client-parity cost even under 594 conflicts — and the
594-retries-for-14-commits ratio is the P4 defer-then-(b) motivation
QUANTIFIED (the executor should defer attempts it is about to lose).
n=1 caveats apply; the scenario is a one-command re-run for n
growth.

**Growth-work attribution (subagent deep-pass over Runs A/B/C logs)
— the tail mechanism NAMED:** per-window Spearman attribution
exonerates every first-guess quantity (wave-pass volume: flat/
saturated in head AND tail; cold refreshes and claim traffic:
front-loaded, ANTI-correlated ρ≈−0.5..−0.6; conflicts: zero in the
tail) and convicts **slow schema traversals on the toolshed's
SERVING path** — the only quantity co-growing with the tail in both
flag-on runs (ρ≈+0.75): tracker keys grow 253→850+ with the note
count, individual traversals cross the 100ms log floor around note
12-15 and stack 2-12 per iteration, delaying the commit-ack/push
chain the client's runtime-idle gate waits behind — exactly where
the sub-timing decomposition puts the growth (viewIdleWaitMs: tail
excess +1155ms in C vs +375 flag-off). Two clean controls: head
means are near-identical across all three runs, and a 27.6s
background prepare ran through Run B's windows 2-9 with client
iterations at baseline — executor saturation AMPLIFIES (process
contention on spike iterations) but does not drive. Confirming
instrument (specified, not yet built): floor-less per-iteration
traversal timing tagged by call-site (subscription push / candidate
eval / cold refresh / wave-pass) + an event-loop-lag sampler + a
client-transact→ack→push timestamp chain. The remedy direction the
counters point at: traversal memoization/coverage on the serving
path over the accumulated doc graph — the SAME server-side
session-tracked-coverage surface as P0-R3c's option (i), now
implicated by client-visible data, feeding P2/P5 design.

**Measurement-hygiene finding #2 (run-sequence drift):** a
replication pair (A2/B2) showed BOTH arms degrading monotonically
with wall-clock order (A1 908 → B1 975 → C 1211 → A2 1543 → B2
2898 medians — monotone in TIME, not arm), and B2 failed to engage
(41 claims, 0 commits). Cause found: leftover Playwright browser
processes from prior runs (one spinning at 104% CPU; load average
20+). Protocol additions: kill leftover `ms-playwright` browsers
between runs, record load-average with every run, treat
cross-run pooling as invalid — only ADJACENT pairs (or future
within-run interleaving) compare arms. The A1/B1 adjacent pair
(+7%) remains the valid single-user datum; A2/B2 is discarded.

| Row | Builds | Red-first gate(s) | Dial | Acceptance | Resolves |
| --- | --- | --- | --- | --- | --- |
| **P0 — executor liveness + demand lifecycle** | Joint demand+claim retention window (pool start/stop damping only, bounded by host session-anchored authority); parked-wake revival; demand-ADD for never-demanded pieces; lane reconcile keeps consuming raw snapshots | Start-under-navigation-cadence pool test; departure-parity fixture (disconnect mid-grace ⇒ no post-disconnect claims, Worker stopped ≤ grace+TTL, parked-space parity byte-identical); grace ≥ measured cold-start with margin | Grace-window duration | Live Worker + `claimsIssued>0` on the real n=10 workload; zero claim-lapse from same-space navigation; departure parity green | CP12 CP14 CP22 CP26 |
| **P0b — keep-warm cost accounting** | Worker-seconds + memory at zero demand, reported against the §4 cost-honesty budget | Counter + report row exist | same | Grace-window fleet cost owner-visible | CP12 |
| **P1 — true baseline** (every number carries engagement counters or reads "not engaged") | Instrument-split of the flag-on delta (claim/feed vs demand vs reconcile vs residual — settles the CP11 contradiction on the record); per-component served-value budget with second-wave canonical-arrival timestamps, k∈{1,3,10}; boot decomposition (space-rank cold/warm, session-lane cold, F4b, reconnect); two-client conflict leg; speculation-coverage classification; crossing-count inventory (wish, R5, handlers, sqlite-by-caller); stale-confirmed windows; cold-start distribution; claim-lapse + executor-death recovery; handler-reads-outside-closure incidence; fail-open incidence; unserved-actions inventory | Engagement counters are the gate | n/a | Published per-component budget table; the contradicting doc corrected | CP1 CP3 CP4 CP7 CP8 CP10 CP11 CP12 CP15 CP21 CP23 CP26 |
| **P2 — serving coverage (P2.0 first)** | **P2.0**: builtin classification audit through BOTH channels + kind↔egress regression test; reclassify `streamData` as effect; reconcile R5 rows; fleet-wide kind flip before servability. Then R5 brokers/descriptors + R13 `wish` in crossing-weighted order. Sqlite per **D2** (served sqlite-op commit path at the routing layer OR permanent ruling with static detectability) | Kind↔egress test; per-builtin contract tests; sqlite admission or classifier-refuses-claim fixture | Per-builtin servability entries | P1 inventory empty or per-action-gated; no statically-invisible never-servable class | CP6 CP10 CP21 CP25 CP31 |
| **P3 — passivity mechanism (suppression + demand + reactivation)** | Per-session subcap above claim-routing-v1 (never required-cap), bound to the per-claim routing seam + A3 counters; **complete wiring surface as a named deliverable** (server env apply, shell define, env global, advertisement golden, realm-separated negotiation gate); **passive-mode demand producer** (intended-running roots → `session.execution.demand.set`, session-liveness bound preserved); **dynamic-reactivation contract** (registrations + closure metadata recoverable; claim invalidation ⇒ bounded demand-time closure fetch + one fail-open run + normal commit); claim-lapse transition semantics defined before P5; **effect re-enablement gate + effect-attempt journal** (durable pre-egress intent + completion, keyed by inputHash — Tier-2 ledger pulled forward); claim-ready-but-never-servable handling; mixed-fleet hardening fixture | Realm-separated negotiation gate (dial on ⇒ subcap advertised ∧ suppression counter > 0 on the real workload; off ⇒ zero); zero-local-starts client still yields live Worker + claims; reactivation fixture; effect-journal fixture | Per-session passivity subcap; per-action fallback via A3 | Suppression engages by counters in a realm-separated topology; no egress path bypasses the broker's live-lane-grant consult | CP1 CP5(r) CP12 CP13 CP17 CP18 CP21 CP28 CP29 |
| **P4 — speculation** | Scope per **D1**; if (b): warm set enumerated separately from the view doc-set, maintenance protocol, standing cost counter-bounded, cold warmup path; closure = transitive inputs; handler-read-miss semantics (pick one, classifier-gated); never-speculate-effects on audited kind; speculable closure within own F6 cohort fail-closed; **write targets registered in doc-set before/with commit**; catch-up-gated conflict retry (`readyToRetry`, timer as fallback bound); premature-drop counted distinctly; R11 windows re-derived (server as sole healer); instantiation decision (speculate creation or budgeted cold, CP22); predicted-coverage statement + hit/miss/divergence counters; divergence UX per **D5** | Write-outside-view-membership settlement fixture (no husk); two-client concurrent-dedup divergence fixture; conflict catch-up-retry fixture; warm-set upkeep counters live | Speculation scope per action class (effects structurally excluded) | Warm-set cost measured and budgeted, not assumed zero; coverage counters shipping | CP2 CP6 CP7 CP8 CP9 CP15 CP16(r) CP22 CP23 CP24 |
| **P5 — passive delivery + demand-time closure (re-scoped: DEMOTE, never retire)** | Standing closure pulls demoted to **demand-time** (registration + closure metadata retained — the path fail-open reactivation and offline ride); membership = view subscription ∪ live speculative write targets, FA4 written-not-read export retained; **F4b server-side one-shot boot-root evaluation**; session-rank seed per **D3**; server-side closure-resolution-on-navigation cost row; selector coverage preserved across watch replace or O(membership-delta) replace; boot publishes derived demand with subscription; **two-stage per-space rollout** (stage A graph-retirement soak in hybrid mode with storm counters clean, stage B passivity flip — never the same dial event, cost per **D6**); confinement gates binding registration-time resolution + lane-grant acting context + per-member read context + FA6 by name (incl. cohort-metadata-free broadcast variant) | Written-not-read membership fixture; stage-A storm-counter soak criteria; confinement fixtures (incl. lane-grant principal case); reconnect replace O(delta) or budgeted | Stage A: per-space graph-retirement admission; stage B: per-session passivity | Stage-A soak archive predates any passivity enablement; passive clients issue no standing pulls; demand-time fetch proven by the P3 reactivation fixture | CP1 CP4 CP9 CP11 CP13 CP19 CP20 CP27 CP30 |
| **P6 — acceptance** | **End bar verbatim: three-way n=20, fully-engaged ≤ flag-off within noise, all quartiles, interaction AND boot, guard clean.** Engagement defined by counters (passive sessions, claimsIssued, workersStarted, suppression advancing) — any zero ⇒ "not engaged", never parity. Gated legs: canonical-arrival p50/p95 under k-client load (**D4**); p95 interaction gate + coverage budget; k∈{3,10} concurrent passive boots vs flag-off (failure escalates to OQ5 per **D7**); two-client conflict; first-interaction-after-park; interact-during-executor-death; reconnect catch-up budget (own measurement, not the hybrid's figure); creation first-paint (cold + warm); mixed-chain fixture with asserted bound; double-egress fixtures (drain-between-egress-and-writeback + offline variant, exactly one external call); fail-open leg (latency × P1 incidence); "guard clean" includes the P5 confinement fixtures + stage-A soak evidence | The legs are the gates | n/a | All legs green or individually owner-ratified (FA16 OR-row pattern); the headline bar is not negotiable | closes the measurement half of every finding |

Parent-doc edits owed with P-rows: README §5.B.3 retry citation (CP7);
R5 register rows for `streamData`/`llmDialog` (CP6/CP31); the
implementation-plan three-way attribution sentence (CP11).

## 5d. Step-1 build + gate (2026-07-28): the serving-path fix, one refuted cut, the honest gate

**Instrument first (`50af1a5d3`, permanent):** floor-less
`totalMs`/`maxMs` on every `traversalByOperation` bucket; wave
drain-vs-fanout split + per-wave `Memory: wave:` log; `Memory:
transact ack:` chain leg; toolshed 1s serving sampler (per-op deltas +
tracked-graph gauge + 100ms event-loop-lag window, both arms). The
confirm run (flag-on, engaged: claims 78 / committed 12 / failed 0;
load ~20-26) REVISED §5c's attribution:

- Drain-wait was DEAD (88ms total; the 2×-last-refresh budget never
  engages) — the compounding-drain hypothesis eliminated.
- Per-wave serving traversal time was FLAT early→late (refresh 2.8s→
  2.5s per 45s half) — aggregate serving does not grow.
- The mechanism: PER-CALL demand-pull cost grows with closure size
  (`graph.query.demand` avg 8.3→21.0ms early→late; 20.6s/run total;
  single synchronous pulls up to 1.2s blocking every concurrent
  ack/push — lag≥100ms events 20→32 with 1.3-2.6s stalls all late) at
  ZERO selector coverage (0 skips vs ~6k on the watch paths).
- The adjacent flag-off arm (claims 0): both arms grow (+36.9 vs
  +64.7 ms/note OLS) — flag-on EXCESS +27.8 ms/note; late-half median
  excess +617ms (1588 vs 971).

**The fix (`225a4c6b2` + `9bb9e5eec`), three composable mechanisms:**

1. Interior link-coverage skips UN-BROKEN: `isLinkedDocumentCovered`
   keyed unscoped links as `<space>/undefined/<id>` (vs
   `getTrackerKey`'s `?? "space"`), so the interior skip machinery was
   inert for the COMMON link shape; plus the DAG walker's ARRAY branch
   (lists!) had no coverage check at all. Fixed + `coveredLinkSkips`
   counter. Immediate effect: intra-traversal dedup engages (the query
   stats fixture now counts 24 skips where shared subgraphs re-walked;
   loads stay one-per-doc), watch-path refreshes stop at covered
   boundaries, and 5/2396 notebook golden-oracle invocations return
   covered-null holes per the established querySchema contract
   (goldens regenerated per the documented workflow).
2. `omitWatchCovered` graph.query opt-in: the server seeds the query
   traversal's tracker from the SESSION's tracked watch surface —
   covered descents skip, covered docs are omitted, callers must
   merge. Engine probe: 1 read / 2 DAG / 0 getDocAtPath vs 2/4/2.
   Refused under an acting context (tracker keys are scope CLASSES).
   NOTE the architectural discovery: the EXECUTOR session registers no
   server-side watches (it lives on the F1/F2 notice+point-read feed),
   so this opt-in can never serve the executor's pulls — it stays for
   watch-tracked callers.
3. Executor frontier growth pulls (`9bb9e5eec`): the growth detector
   already enumerates the grown targets; the (debounced) growth
   refresh integrates them via exact `docs.read` POINT READS and walks
   the new subgraph CLIENT-side — the held set is the boundary, so
   backlinks into held docs terminate immediately; zero server
   traversal; snapshots merge; the revised held doc applies as an F2
   point update; bounded loudly (16 rounds / 2048 docs, spill back to
   the pending set). Dial
   `EXPERIMENTAL_SERVER_PRIMARY_EXECUTION_COVERED_GROWTH_PULL`,
   toolshed default ON.

**The REFUTED first cut (gate honesty):** `225a4c6b2` originally
rooted a schema-true `graph.query` at the frontier. Its adjacent gate
pair measured it WORSE than the full pull — excess slope +52.5 ms/note
(vs +27.8 pre-fix), demand 27.9s / max stall 2.5s, reads UP — because
the frontier's BACKLINKS re-entered the entire held closure and
nothing bounded the walk (no server-side tracked surface for the
executor session). The client-bounded point-read walk replaced it same
day. Flag-off stayed stable across pairs (+36.9 → +38.1 → +36.3
ms/note), so the within-pair comparisons are valid.

**Gate2 pair (post-`9bb9e5eec`; load ~12-21):**

| quantity | pre-fix pair | gate2 pair |
| --- | --- | --- |
| flag-on engagement | claims 78 / committed 12 | claims 136 / committed 28 / failed 0 |
| `graph.query.demand` | 1743 calls / 20.6s / max 1201ms | 456 calls / 3.9s / max 132ms |
| frontier reads | — | `docs.read` 5552 calls / 9.8s / max 906ms |
| flag-on med notes 2-10 / 11-20 | 879 / 1588 | 763 / 1252 |
| flag-off med notes 2-10 / 11-20 | 664 / 971 | 663 / 1051 |
| late-half median EXCESS | **+617ms** | **+201ms** |
| early-half median excess | +215ms | +100ms |
| OLS slope excess | +27.8 ms/note | +34.2 ms/note (one 3.5s spike note drags OLS; median halves are the robust read at n=20) |

**Verdict:** the mechanism is CONFIRMED and the dominant serving cost
collapsed 5× with the max stall down 10×; the engaged tail excess
collapsed 3× at ~2× the engagement. The gate ("tail slope ≈
flag-off") is substantially but not strictly met: +201ms late-half
excess and a spike class remain. Residuals, named for follow-up
rather than silently absorbed: (a) same-flush demand+wave trigger
override — a watch marked closure-growth (demand) AND
untracked-root/re-key (wave) in one flush takes the WAVE trigger and
the full-pull path (233 wave-classified growth re-colds;
`graph.query.wave` 250 calls / 5.3s is now the second serving cost);
(b) frontier read batching (5.5k point reads could coalesce); (c) the
unattributed 3.5s spike note (plausibly the P4 conflict class —
re-examine after step 2). The remaining excess is at the level where
the plan's own next steps (P4 speculation discipline, P3/P5 removal
of client work) are the levers.

## 5e. Step-2 probe + residual defer (2026-07-28): the 594:14 datum dissolved; streak backoff

**Probe first (permanent `[P4] conflict-retry:` line, `b3505ab09`):**
the catch-up-gated retry ALREADY existed on both realms (scheduler
`readyToRetry` + the host provider's conflict-retry barrier), so the
594:14 chat ratio meant gated re-attempts still losing. The post-step-1
chat run rewrote the picture: **62 conflicts for 59 commits (~1:1)** —
the 594 was mostly stale-replica churn from the slow growth pulls that
step 1 removed. Retry anatomy: 42 retries, ALL gated, catch-up wait
median 1ms; the residual was ONE action re-losing in a 0ms-gap burst
(36 straight conflicts) — the catch-up gate resolving instantly while
the contention window persisted. Per-post median 542ms (flag-ON —
faster than the pre-fix flag-OFF arm's 602ms; the owner's
multi-user-should-win direction shows its first sign, n=1).

**The residual defer (`e6f1315c7`):** consecutive-conflict streak
backoff at the scheduler's conflict re-queue — first conflict keeps
the immediate catch-up-gated retry, the 2nd-onward waits
25·2^(n-2) ms capped at 400ms, any success clears the streak
(WeakMap on the scheduler facade). Gate run: **max streak 36 → 5**
(histogram 40×1 / 32×2 / 10×3 / 2×4 / 1×5; 1.7s total backoff),
committed 56 / failed 0, per-post median 683ms q3 769 **max 951**
(probe run: 542/677/1259 — median within run-to-run noise, tail max
IMPROVED). The wasted-server-work class is gone without settlement
latency loss.

**Method note for every future step:** re-probe a motivating datum
before building on it — the 594:14 was measured pre-step-1 and did
not survive it; the build that datum originally justified (a full
pre-attempt defer machinery) would have been aimed at a ghost.

## 5f. Step-3 first slice (2026-07-28): the malformed-output-surface class was a labeling defect

An isolated-worktree taxonomy pass instrumented both
`malformed-output-surface` return sites in
`classifyStaticActionServability` over the rollout-products group-chat
case: **15/15 offenders were the documented context-lattice §4
output-widening pair** — broad + scoped instance of ONE doc/path,
`writes` verbatim identical to `directOutputs`, every entry
individually root-value — i.e. well-formed certifier output. The
classifier's pair collapse ran only under an active lane
(`laneRank !== "space"`), so at space rank the pair hit the plurality
check and reported a shape complaint, hiding the real class: scoped
UI derivations (profile labels, send-button booleans, rosters) that
are simply unservable until the rank dials. 14/15 classify
claim-ready at USER rank with `serverPrimaryExecutionUserRankCandidates`
on (1 needs the session dial).

Fix (`c2cc3891e`): at space rank the same pair SHAPE resolves the
broad instance and falls through to the scope checks —
admission byte-identical, diagnostic truthful
(`non-space-write-scope` / in practice `non-space-read-scope`, since
these lifts read scoped cells too and the read check fires first).
Two C1.9/C2.2 admission pins reconciled with their byte-identity
rationale preserved. Live chat-leg gate: `malformed-output-surface`
**39 → 0**; inventory now `non-space-read-scope` ×191/20 (the
owner-gated rank class, correctly named) + lease-fence ×62 + two
singletons. Engagement: claims 116 / committed 54 / failed 0.

Same runs closed §5d residual (a): all 55 demand→wave trigger
overrides were `closure-growth`+`closure-shrink` same-flush
composites — the shrink leg genuinely requires the full re-walk
(removes), so the override is design-correct; the
`executor cold trigger override:` probe stays as the permanent split.

**The pending OWNER question this leaves on the table:** enabling the
C1.5a/C2.5 rank dials for real deployments (CA4 ordering: memory-side
claim-rank stage + cohort advertisement + the dials) is now the
single decision standing between the chat product's computation
inventory and claim-ready — the measured payoff surface is 20
offender actions × the multi-user legs. The effect rows (R5 brokers,
R13 wish, sqlite per D2) remain build work either way.

## 5g. The user-rank dial: CA4 audit + the measured buy (2026-07-28)

Answering §5f's pending owner question. Nothing here is enabled by
default; both probes below land as re-runnable artifacts so the numbers
are reproducible rather than re-derived.

### The prerequisite audit — what is MET and what is not

The dial "bundle" is four independent switches, not one. Their
mechanisms are all built; **none of them is reachable from any
deployment's configuration.**

1. **Memory-side claim-rank ladder reaches `user` — MECHANISM MET,
   DEPLOYMENT WIRING ABSENT.** The ladder is
   `space → user → session → cross-space-read`
   (`packages/memory/v2.ts:1520`), the stage gates issuance and renewal
   at `#executionClaimRankEnabled`
   (`packages/memory/v2/server.ts:2394`, consulted at `:2372` and
   `:6391`) and lane opening at `executionUserLanesEnabled`
   (`:5278`). The setter is
   `setServerPrimaryExecutionClaimRankConfig` (`v2.ts:1549`) and it has
   **no non-test caller anywhere in the repo** — notably not in
   `applyServerPrimaryExecutionEnvConfig` (`v2.ts:1770`), which applies
   only the base dial and the doc-set-watch dial. `user` is reachable
   today only from inside a fixture's own process.
2. **Cohort advertisement — MECHANISM MET, DEPLOYMENT WIRING ABSENT.**
   `serverPrimaryExecutionContextLatticeClaimsV1` is a real negotiated
   subcapability with the amendment-11 principal-wide gate
   (`server.ts:5060`, enforced at lane open `:5205` and renew `:5250`).
   Its setter (`v2.ts:1572`) likewise has no env mapping and exactly one
   non-test caller: the multi-runtime harness worker, behind a
   harness-local variable
   (`packages/patterns/integration/multi-runtime-worker.ts:226`).
3. **Runner-side candidate dial — MECHANISM MET, DEPLOYMENT WIRING
   ABSENT BY DECLARATION.** The Worker reads it at
   `packages/runner/src/executor/executor-worker.ts:1248`, the router at
   `executor/action-transaction-router.ts:366`, and toolshed passes the
   pool leg at `packages/toolshed/routes/storage/memory.ts:271`. But
   `serverPrimaryExecutionUserRankCandidates` is mapped `null` in
   `EXPERIMENTAL_ENV_VARS` (`packages/runner/src/runtime-presets.ts:200`),
   so `experimentalOptionsFromEnv` never sets it and toolshed's
   `runtime.experimental` never carries it.
4. **The CA4 ordering invariant itself — NO LONGER BINDING for user or
   session rank.** `EXPERIMENTAL_OPTIONS.md`'s `serverPrimaryExecution
   ClaimRank` entry records it as **lifted** when C2.6 landed
   (2026-07-17): session-context control events now route only to the
   named session, so the quadratic sibling-rerun hazard the invariant
   protected against is gone. The CA4/C3A17 analog for
   `cross-space-read` is still binding. **§5f's framing — that CA4
   ordering gates this decision — is out of date; what actually gates it
   is items 1-3 and 5, which are wiring, not ordering.**
5. **A browser client that can negotiate the subcapability — NOT MET,
   and this is the binding blocker for the payoff surface §5f named.**
   The client half is the same programmatic-only memory ambient flag; the
   shell bundle has no path to it. Because the cohort gate requires
   EVERY session of a principal — TTL-detached ones included — to have
   negotiated, a browser session that cannot negotiate makes
   `openUserLaneGrant` throw and the lane never opens. **The
   two-browser leg therefore cannot host this measurement at all today:
   flipping every server-side dial under it would be inert.** The F5
   env-bridge gate
   (`packages/patterns/integration/server-execution-f5-env-bridge-gate.test.ts`)
   is the precedent and the warning — the identical "dial never reached
   the advertisement in a realm-separated deployment" miswire already
   happened once and needed its own red-first gate to catch.
6. **A fixture that flips the pair together — MET.** The C1.9 gate does
   exactly that (`server-execution-user-lane-gate.test.ts:529` +
   `:599`). Re-run on this tree today: **6/6 green, including the A2
   mid-run WRITE-revocation security fixture.**

### What flipping buys — measured

`packages/runner/test/server-execution-group-chat-rank-probe.test.ts`
(new): the real `cfc-group-chat-demo/main.tsx` driven through the real
executor router with trusted-provenance events, three arms, dials the
only difference. Counts are per reason code as
`events / action instances / DERIVATIONS` (module + lift identity —
the granularity the offender inventory is actually about):

| arm | candidates | unserved |
| --- | --- | --- |
| space (today) | `space` ×17 | `non-space-read-scope` 34/33/**20** |
| user | `user` ×17, `space` ×17 | `malformed-scope-naming-link` 12/12/1; `broad-lane-value-write` 3/2/1; `non-space-read-scope` 2/2/2 |
| session | `user` ×17, `space` ×17, `session` ×1 | as above + `dynamic-non-space-write-scope` 1/1/1; `non-space-read-scope` **0** |

Cross-arm set relations (derivation-keyed): **promoted 16, still
stranded 2, newly appeared 0, REGRESSED 0.** The space arm's 20
stranded derivations corroborate §5f's live "20 offender actions" —
the same surface, counted two independent ways.

So the buy is real and the direction is unambiguous: **16 of 20
stranded derivations become claim-ready, 17 user-rank candidates
appear, and nothing that placed at space rank stops placing.**

### What it risks — measured

The dial does not simply promote. Two per-attempt rejection classes
appear that do not exist at space rank, both at the §4 widening-pair
write-shape firewall (`scheduler/servability.ts:727` — the runner-side
mirror of the engine's `assertLaneBroadScopeNamingWrite` backstop):
`malformed-scope-naming-link` (12 attempts) and `broad-lane-value-write`
(3 attempts). Two derivations are **claim-ready AND stranded** in the
same arm — placement succeeds, individual attempts are then rejected.
That is the claimed-but-unserved shape, and it is invisible to any
count that asks only "is this action claim-ready?" — including §5f's
"14/15 classify claim-ready", which is a static-classifier statement
and does not survive contact with the router's firewall. The session
arm adds a third, `dynamic-non-space-write-scope` ×1.

None of these is a correctness failure in the probe; all are refusals
to serve. The live half below prices them: the same territory shows up
against real commits as `dynamic-write-outside-static-surface` ×12 on a
single offender, at BOTH scoped ranks.

### The live half — the product SERVED, up the ladder

`packages/patterns/integration/server-execution-group-chat-user-rank-probe.test.ts`
(new): real Server, file-backed store, real `SharedExecutionPool`, a real
Deno executor Worker, two principals on the real product, three adjacent
arms with independent stores.

**Getting group-chat served was the whole difficulty, and the cause was
not the dials.** The pool deliberately does NOT wake an executor that is
already live (`shared-execution-pool.ts` `#acceptAcceptedCommit` returns
early on `slot.executor !== null` — its wake path exists to start or
unpark a Worker, never to drive one), and `set-demand` only ENQUEUES the
structural swap, with activation completion observable solely through
`settle()`. A fixture that starts a pool and then just drives clients
gets a live Worker holding its lanes and running nothing. Driving the
Worker's `settle()`/`wake()`/`settle()` fixpoint explicitly — as
`runner/test/server-execution-rollout-products.test.ts` already does for
this same product — is what turns demand into scheduler runs. With that,
`schedulerRuns` goes 0 → 142/210 and every counter below exists.

Engagement, from `server.executionStats` (the object `/api/health/stats`
serves):

| | space (today) | user | session |
| --- | --- | --- | --- |
| `claimsIssued` | 27 | 38 | 40 |
| by context key | `space` 27 | `space` 26 + `user` 6+6 | `space` 26 + `user` 6+6 + `session` 1+1 |
| `acceptedActionAttempts` | 39 | 80 | 84 |
| `claimedActionConflicts` | 8 | 22 | 21 |
| `settlementsCommitted` | 2 | 8 | 9 |
| `settlementsFailed` | **0** | **0** | **0** |
| `settlementsUnserved` | **0** | **0** | **0** |
| `actionFirewallRejects` | **0** | **0** | **0** |
| candidate claim-ready | 27 | 43 | 46 |
| candidate unserved | 38 | 18 | 16 |

The unserved inventory, `events / offenders`:

| code | space | user | session |
| --- | --- | --- | --- |
| `non-space-read-scope` | **33 / 19** | 1 / 1 | **0** |
| `dynamic-write-outside-static-surface` | 0 | **12 / 1** | **12 / 1** |
| `claim-key-mismatch` | 0 | 2 / 1 | 2 / 1 |
| `malformed-output-surface` | 0 | 1 / 1 | 0 |
| `commit-rejected:ExecutionLeaseFenceError` | 5 / 1 | 2 / 1 | 2 / 1 |

**The buy, live and confirmed:** the offender class §5f named collapses
**33 events / 19 offenders → 1 → 0**, total unserved 38 → 18 → 16,
claim-ready 27 → 43 → 46, with **zero failed settlements, zero unserved
settlements and zero firewall rejects at every rank**. Per-user value
correctness and cross-principal isolation hold in all three arms.

**The cost, live:** attempts roughly double (39 → 80/84) and
`claimedActionConflicts` roughly doubles-to-triples (8 → 22/21) for
2 → 8/9 committed settlements. Server-side arbitration work grows
faster than committed output — expected while clients still execute
everything too (§0's honest core), but it is now a measured number
rather than an expectation.

**The new class, live and priced:** `dynamic-write-outside-static-surface`
×12 on one offender, present at user AND session rank, absent at space
rank. This is the live form of what the classification probe saw as
`malformed-scope-naming-link` / `broad-lane-value-write`: the same §4
widening-pair territory, reported by the dynamic firewall against real
commits rather than by the static mirror. It does not fail a settlement
— the attempt simply is not served — but it is 12 of the arm's routed
lane attempts, and it does not clear at session rank.

**Finding NOT predicted by the plan — R7's acceptance criterion does not
hold for this product.** `claim-context-mismatch` lease fences measure
**5-6 → 2 → 2** up the ladder (the space arm's count varies by one
across runs; the scoped arms reproduced exactly). C2.10 RETIRED that cause from
`TOLERATED_LEASE_FENCE_CAUSES`
(`packages/patterns/integration/server-execution-measurement.ts`) on the
reasoning that "session-context runs now have a lane to route to, so any
mismatch is a placement defect again", making its return to hard-zero a
named C2 acceptance criterion. Measured against real group-chat with
session lanes open and session-rank claims issuing, it was **2, not 0**.
Opening the lane is not sufficient to route every session-context run to
it. **Diagnosed and FIXED the same day — see the two sections below.**
Post-fix the ladder reads **2 → 0 → 0**: hard-zero at both scoped ranks,
and the probe now PINS that. The space arm keeps a couple, which is the
one case an issuance-time check cannot see (a floor narrowed between
issuance and commit) and exactly what the engine fence remains the
backstop for.

### R7 diagnosis (2026-07-28): claim rank and effective context are two different functions, and only one sees the durable floor

Instrumented at both fence sites and at
`resolveSchedulerExecutionContext` (temporary probes, reverted). **Every
fence in every arm has one shape:**

```
fence@obs-only  actionId=cf:builtin/map:v1:<instance>
                claimContextKey="space"
                resolved="session:<did>:<sessionId>"
                staticFloor="space"  runtimeFloor="space"
```

The fencing observation's OWN surfaces are entirely space-scoped. The
`session` comes from somewhere else. Resolving the floors at the same
moment:

```
staticFloor=space  runtimeFloor=space
globalFloor=user   principalFloor=session   →  effectiveFloor=session
```

**The causal chain, captured end to end for one action instance:**

1. A **CLIENT** run of `cf:builtin/map:v1:<instance>` observes
   `staticFloor=user, runtimeFloor=session` — a genuine PerSession read
   (the product's `roomDraft` / `hostMessageDraft`). It writes
   `scheduler_context_floor(principalKey) = session`
   (`engine.ts:7213`). The observation is **unclaimed** — an ordinary
   client-primary run.
2. That floor is **durable and monotonic**: `upsertSchedulerContextFloor`
   only ever narrows, by design (evidence that an action is not shared
   cannot be un-observed).
3. Every later run of the same action — including ones whose own static
   AND runtime surfaces are purely space-scoped — resolves through
   `effectiveFloor = narrowest(staticFloor, runtimeFloor, globalFloor,
   principalFloor)` (`engine.ts:7223`) and therefore lands at
   `session:<p>:<sid>`.
4. The **executor** classifies its candidate from the CURRENT
   observation's static + runtime surfaces only. It sees `space`, and
   emits a space-rank candidate.
5. The **host** issues the claim at the executor's rank.
   `#assertExecutionClaimCapabilityEnabled` /
   `#executionClaimRankEnabled` (`server.ts:2372`/`:2394`) check the
   dial, the subcapability and the key's shape — **they never consult
   the floor.** `schedulerContextFloor` is not exported from
   `engine.ts`; neither `server.ts` nor any runner file reads it.
6. The claimed run commits, the engine resolves `session:...` ≠ `space`,
   and the only thing that catches the disagreement is the commit-time
   fence.

**So the root cause is an asymmetry, not a missing lane.** Claim rank
and effective context are computed by two different functions over two
different inputs, and the engine's input includes durable monotonic
state written by ANY observer — including a plain client run — that the
claim side structurally cannot see.

**Why C2.10's retirement reasoning does not cover this.** It reads
"session-context runs now have a lane to route to, so any mismatch is a
placement defect again". True for a run that LOOKS session-context. This
run does not: its own surfaces are space-scoped, and it is session-pinned
only in durable engine state. Opening a lane cannot fix a claim issued at
the wrong rank; the lane was open and the fence still fired. The
retirement was sound about the case it named and silent about this one.

**Severity: liveness/efficiency, not correctness.** The fence is doing
its job — nothing wrong commits, `settlementsFailed` is 0 at every rank,
and per-user values stayed correct throughout. The cost is that the
server does the work and then throws it away, the client re-runs, and
the action never converges to server-primary. It also scales the wrong
way: the floor is monotonic, so once any client run pins an action, EVERY
later space-rank claim on it fences, forever.

**Fix options, cheapest first.**

1. **Consult the floor at issuance** (`#assertExecutionClaimCapability
   Enabled`): decline a claim whose contextKey is broader than the
   action's durable floor, or issue it at the floor's rank. Turns a
   commit-time fence that wasted a run into an issuance-time decline that
   costs nothing. Needs the floor reader exported and one lookup on the
   issuance path; matches the design's existing "rank enablement gates
   ISSUANCE and RENEWAL only" shape.
2. **Feed the floor back to the executor** so its candidate rank matches
   the engine's resolution. Correct at the source, but needs a new
   channel and keeps two computations in sync.
3. **Re-issue at the resolved rank on fence** rather than dropping the
   attempt. Recovers the wasted run but leaves the disagreement.

### R7 fix (2026-07-28): the issuance-side floor consult

Option 1 landed. `schedulerClaimContextFloor` (engine) reports the
narrowest durable floor an action IDENTITY carries — the global row plus,
when the claim names a principal, that principal's row — and
`#assertExecutionClaimContextFloorAdmits` (server) declines any claim
whose contextKey is BROADER than it, before the engine is asked to do
anything. A wasted run becomes a free refusal.

Deliberately coarser than the engine's own `schedulerContextFloor`: an
`ActionClaimKey` carries no `processGeneration` and no `ownerSpace`, so
the consult matches on the fingerprinted action identity across both. It
can therefore only ever over-report narrowness, and over-reporting is
SAFE here — the response is to decline, which lands exactly the
client-primary behavior that would have happened anyway. Under-reporting
would silently reinstate the burned run. Matching fingerprints are what
make it sound rather than merely safe: same code, same scope shape.

Red-first, both directions:

- `v2-execution-claim-context-test.ts` — the MECHANISM at the engine: an
  unclaimed client run narrows the floor, and a later space-rank claim on
  an all-space run fences `claim-context-mismatch`. Plus a consult unit
  pinning that it reads the global row, and that it does NOT leak across
  action ids or fingerprints.
- `v2-execution-acting-context-test.ts` — the DECLINE at the host, with a
  control: the identical space claim issues while no floor is observed,
  then an ordinary UNBOUND client session narrows it, and the same claim
  is refused. Verified red (`Expected function to reject`) with the
  consult disabled.

Measured on the live product (three-arm probe, adjacent arms):

| | space | user | session |
| --- | --- | --- | --- |
| `claim-context-mismatch` fences | 5-6 → **2** | 2 → **0** | 2 → **0** |
| `commit-rejected:ExecutionLeaseFenceError` | 5 → **2** | 2 → **0** | 2 → **0** |
| `claim-authority-lost` (the free decline) | 0 → 2 | 0 → 2 | 0 → 2 |
| `settlementsCommitted` | 2 | 8 | 9 → **15** |

The wasted-run diagnostic converts one-for-one into the free-decline
diagnostic, which is precisely the intended trade. The session arm also
committed more settlements, which is what stopping the burn buys back.

**What this does NOT fix, on purpose.** The executor still proposes the
wrong rank — it just gets refused cheaply now instead of after a run. It
will re-propose on the next invalidation and be refused again. The
durable fix is feeding the floor back to the executor so the two
computations agree at the source (option 2), which needs a new channel
and is not on the critical path for the rollout. The engine fence stays
as the backstop for the issuance→commit race, which is what the space
arm's residual 2 are.

### Recommended sequencing

1. **Do not flip anything yet, and do not add an env bridge as the
   first step.** With no browser-side negotiation the bridge would
   enable a configuration that is inert at best; per the cohort gate it
   would also make user lanes un-openable in exactly the deployments
   worth measuring.
2. **R7 — DONE (see the fix section above). The next BUILD is the R5/R13
   effect rows** — the worklist is in §0 step 3, crossing-weighted per
   CP10. That is where the remaining value is: the computation side is
   closed at session rank, and README §1 records effect authority/quota
   as a goal of the move rather than deferred hardening.
   Beside it, one undiagnosed item at this layer:
   `dynamic-write-outside-static-surface` ×12, which survives both scoped
   ranks and is the last live unserved class the rank dials do not
   explain. **Diagnose it only after checking whether P3 deletes it** —
   it is a §4 output-widening artifact whose entire purpose is to keep a
   CLIENT reader correct, so a passive client may remove the requirement
   rather than the fix. Repairing something we are about to delete is the
   specific waste this ordering avoids.
3. **Build the client-side negotiation path** (shell/runner) with an
   F5-style red-first env-bridge gate asserting the subcapability
   negotiates END TO END from the dials alone. This is the one item
   that unblocks the two-browser payoff surface, and F5 is the
   template for how it gets pinned.
4. **Then** wire the three server-side dials behind one bridge and
   measure the two-browser legs, adjacent-pair, on an unloaded box —
   with the arbitration-cost ratio above (attempts and conflicts roughly
   double for 4× the committed settlements) as the thing to watch.
5. The effect rows (R5 brokers, R13 `wish`, sqlite per D2) are
   unaffected by any of this and remain the open build.

The live measurement gap named in the first cut of this section is
CLOSED: group-chat is served in the gate topology and the
claim/settlement/conflict counters and `candidateUnservedByCode` delta
are the tables above.

### Measurement conditions

Box load average 19.9-23.3 throughout (other tenants active), so **no
latency number was taken and none is quoted** — every figure above is a
count or a set relation, which are load-insensitive. The toolshed
two-browser arm was deliberately NOT re-run: it can only reproduce the
dials-off inventory §5f already published from the same command, and
per item 5 it cannot host the dials-on arm at all.

Counter stability across re-runs: the `space` arm reproduced exactly;
the scoped arms varied only in `acceptedActionAttempts` (78-87) and
`claimedActionConflicts` (17-22) — contention-timing sensitive, as
expected. Every inventory and claim count above reproduced identically
across three runs, including one under `--trace-leaks` (the shape CI
uses for the integration suite, and the reason the probe runs inside
`withExecutorTeardownBarrier` per FW7).

Unrelated flake found while re-running the gate suite:
`server-execution-cross-space-gate.test.ts` fails its 60s
`waitForCondition` barrier intermittently under load — measured **3/6
failures at clean HEAD** with no local changes applied, and 0/6 across
two quiet 3-run A/B halves. It is load-sensitive and pre-existing, not
caused by anything here; worth its own barrier/timeout fix.

## 5h. Wave A (R5/R13 rows) + the C1 ruling (2026-07-28)

Built by five parallel subagents against the orchestration script in
[`passivity-arc-orchestration.md`](passivity-arc-orchestration.md); every
Verify line was re-run by the orchestrator rather than accepted. Landed as
`cfa827f82`, `8cb00bbf8`, `f221411df`, `a69aec5f9`, plus `a34c15fd2` /
`57e625424` for the branch's own lint and format debt.

### What the R5/R13 rows bought

| Item | Outcome |
| --- | --- |
| A1 `llm` broker | **BUILT.** All three LLM builtins now share one route. |
| A2 `sqliteQuery` | **Gate built, broker refused.** See below. |
| A3 five descriptors | **1 of 5 added** (`inspectConfLabel`); 4 refused. |
| A4 `wish` | **Refused, with the block pinned.** |

Three of the four refused something, and the refusals carry more
information than the builds.

**A2 — the fetch broker does not fit, and that is fine.** `sqliteQuery`
is not fetch-shaped and the executor Worker already carries a
`sqlite.query` transport over its memory port; a second broker would
duplicate a working path. It is **not** blocked on D2/A5. What it was
actually missing is double-execution prevention: it enqueued its
post-commit effect directly, bypassing `externalSinkDisposition()`. The
ordering matters — the dedup marker must not be written on the suppressed
side, or the result stays permanently `pending` *and* wedges the side
that was supposed to issue. Remaining `sqliteQuery` work (lane-scoped
read seam, descriptor shape) folds **into** A5 rather than preceding it.

**A3 — a green test was asserting a false thing.** `llmDialog` and
`navigateTo` return `isEffect: true` from their factories, and
`runner.ts:5304` resolves `module.isEffect ?? builtinIsEffect`, so they
are EFFECT nodes whatever `index.ts` says. A computation descriptor can
never serve them: `serverBuiltinComputationScopeSummary` requires
`actionKind === "computation"`, so it would mint and never assemble. The
existing pin asserting "llmDialog stays a computation" only regex-parses
registrations, so it was green while the effective kind was the opposite
— and that false claim had already propagated into the arc plan's
standing knowledge. Corrected at the source; real behavior now pinned.

**→ CP6's refutation is RE-OPENED and owner-gated.** The refuted claim
was that `llmDialog` performs no direct egress. Its *kind* is now known
to be effect; whether it performs *double* egress is a separate question
nobody has re-measured.

**A4 — `wish` is not descriptor-shaped because its surface is
misleadingly NARROW.** Its sidecar paths load a pattern over HTTP, run it
on their own transaction, and subscribe fresh scheduler actions — none of
which appears in the action's own transaction. So the run with the
smallest in-transaction write surface is exactly the run that egresses. A
W2.15a descriptor would classify those runs `claim-ready` and sail them
through the dynamic write firewall, re-opening CP6 from the other side.

**→ New finding, independent of the descriptor question:** that egress is
neither brokered nor deniable. `wish` constructs `new
HttpProgramResolver(url)` with no fetch transport, so the resolver falls
back to `globalThis.fetch` and the executor Worker's `fetch:
denyExternalBuiltinFetch` option never sees the call. The executor's
egress denial has a bypass.

### C1 ruling: **SURVIVES** — and the question was mis-framed

C1 asked whether a purely speculative client deletes the §4 widening
requirement. **Ruled SURVIVES**, and the premise behind the question is
wrong at the source: the pair is not a client-authority mechanism. It is
a base-runtime scope-discovery rule from
[`scoped-cell-instances.md`](../scoped-cell-instances.md), emitted
unconditionally by every runtime. The emission predicate
(`pattern-binding.ts:274`) contains no lane, claim, executor or server
term — verified directly. The context-lattice §4 firewall is a *backstop*
on that pre-existing rule.

Passivity removes client **writes**; the pair serves client **reads**.
Every reader of the broad instance (link resolution, scope propagation
through the derivation graph, doc-set/sync discovery, other principals'
lanes, the servability classifiers, out-of-runtime readers) is a
read-path consumer, and render is client-inherent by this document's own
§1. P3 deletes exactly one thing: the `laneActingCommit === false` arm of
the runner mirror, which is dead-code cleanup.

Two consequences that reorder the plan:

1. **The `dynamic-write-outside-static-surface` ×12 is NOT a P3
   dependency.** It is unblocked as ordinary P2 serving-coverage work.
   Leading hypothesis to start from (flagged, not asserted):
   `widenLaneOutputEnvelopes` synthesizes lane twins only for
   `directOutputs` already at scope `space`, while the spec requires the
   widening rule to apply equally to auxiliary result cells — so an
   auxiliary cell absent from `directOutputs` would report this code with
   a perfectly well-formed pair. That would make it a
   certificate-completeness bug, one offender, ~1 hour to confirm.
2. **The real narrowing pressure on the firewall arrives with P5, not
   P3.** When handlers move server-side, lanes begin carrying legitimate
   narrow-to-wide *value* writes and `broad-lane-value-write` becomes a
   false positive for a sanctioned class. That needs a handler-commit
   discriminator, and it narrows the firewall, never the pair.

**Tension worth the owner's attention.** The arc's goal is stated as "the
client never commits any non-handler/non-event-driven changes", but CP1
already carves out the opposite for the dynamic fail-open class — revoked
claims, unserved candidates, firewall discards, de-claimed actions — where
the client's rerun-commit *is* the canonical value, mechanized at
`storage/v2.ts:6276`. P3 does not make the goal statement literally true;
it shrinks the exception. Worth deciding whether the arc's target is
"zero client reactive commits" (which would require eliminating fail-open)
or "no client reactive commits on the served path" (which is what CP1
describes and what is actually being built).

## 7. Owner decisions — RESOLVED 2026-07-26 (D1-D7); amended 2026-07-28 (D8-D10)

Recorded from the owner's "build all of D" directive. Where the panel
recommended, the recommendation is adopted; the genuinely open calls
below carry their rationale and remain owner-vetoable until the plan row
that consumes them starts building.

1. **D1 — speculation scope: DEFER-THEN-(b), per the panel
   recommendation.** The binding choice waits for P1's coverage data.
   The pre-committed *direction* is (b) restricted to view-feeding pure
   computations, with the CP2 warm-set budget as a hard gate: if P1/P4
   counters price the warm set above the §4 hybrid class it replaces,
   the scope drops to (a) rather than shipping a new standing cost.
2. **D2 — sqlite: BUILD the served sqlite-op commit path** (routing-layer
   lane-scope admission + row-label re-derivation), at its P2 position
   after P2.0, priority set by P1's by-caller counts. Rationale: the
   permanent-ruling alternative requires static detectability that CP21
   shows is structurally absent (dynamic sqlite ops ride arbitrary
   callers' commits) — a ruling without detectability recreates the
   claim-then-nobody-computes hazard under suppression.
3. **D3 — session-rank boot seed: PUSH-THEN-CATCH-UP** (rehydrated
   durable rows pushed immediately, settled stale-tolerantly via
   catch-up). Rationale: holding boot for lane catch-up serializes the
   session-lane cold start into first paint — exactly the CP4
   k-boot-serialization hazard — and the stale window is bounded by the
   same reconnect-barrier semantics §5.B.1 already defines. P1's boot
   decomposition measures the stale window; D7 governs if it's ugly.
4. **D4 — numeric budgets: DEFERRED BY DESIGN to P1 close** (unchanged —
   any number chosen today would be invented). The D-pass records the
   *procedure*: budgets are set from P1's published table, owner-ratified
   in the P6 row, and never relaxed silently.
5. **D5 — divergence UX: HOLD, never flicker.** All three cases: true
   divergence (hold the speculative value until canonical arrives,
   replace with a visible transition only when values differ), premature
   drop of correct speculation (hold — the canonical value returns
   identical; a flicker here is pure noise, CP8), conflict overlay drop
   (hold + the P4 catch-up-gated rerun). Rationale: "speculation never
   commits" pairs naturally with "the UI never shows the retraction of a
   value that was right."
6. **D6 — stage-A soak: SEQUENCE AFTER the watch.add
   closure-re-resolution scaler fix** (selector-coverage preservation /
   O(delta) replace — already a named P5 build item, pulled forward as
   the soak precondition), with a per-space time-box as backstop.
   Rationale: soaking with the known +2.4s amplification both costs
   users and pollutes the soak's own storm counters with pull churn —
   the soak must observe the substrate it will actually ship on.
7. **D7 — k-concurrent-boot failure: ESCALATE TO OQ5**
   (Worker-per-lane-group topology) rather than ratifying non-parity.
   Rationale: the P6 bar is non-negotiable by this plan's own language;
   a pre-ratified session-lane cold-start budget would hollow it out.
   Conditional: engages only if the P6 k∈{3,10} gate actually fails.

8. **D8 — compute centralization: ACCEPTED, deliberately.** N clients
   executing the whole graph is distributed compute that is free to us;
   server-primary execution moves it onto infrastructure we pay for and
   must scale. That bill is the price of the trust asymmetry and of
   removing races, and it is not to be re-litigated when it arrives.
   Obligation attached: any phase that raises it says so with numbers.
   Full statement and mechanisms in
   [README §1](README.md#1-summary).
9. **D9 — the trust model is a GOAL, present tense.** Moving execution
   server-side is what lets the system treat the CLIENT AS LESS TRUSTED.
   What the server computed is what downstream integrity guarantees may
   be built on; the client's copy is display state. This upgrades the
   README's earlier "eventual side benefit" framing. Corollary: holding
   authority and quota over effect builtins (`llm`, `sqliteQuery`,
   egress) server-side is a REASON to move rather than deferred
   hardening — and largely not a new cost, since those calls already
   transit our server (#2659, the §B.6 egress broker). This is what makes
   the R5/R13 rows in §0 step 3 the next build.
10. **D10 — speculation is FOR interaction latency, and nothing else.**
    The acceptance property is an immediately responsive UI — tab
    switches, opening a piece, typing — which is explicitly allowed to
    render GAPS for values the server has not delivered yet and fill them
    in on arrival. Speculation is never for correctness and never
    load-bearing for convergence; D5's hold-never-flicker rule governs
    divergence. This is what makes "client execution is purely
    speculative" an end state distinct from Approach D (the client still
    computes, it just never commits), and it sets the bar at FAST first
    paint with gaps rather than the zero-execution first paint README
    §B.9 reserves for D. Full statement in
    [README §4 Q3](README.md#4-the-four-design-questions).
