# Client passivity: the no-dual-execution end state

**Status: PANEL-AMENDED PLAN (2026-07-26). Theory ruled SOUND WITH
AMENDMENTS by the adversarial panel (21 verified findings, 2 refuted, 8
confirmations — archived verbatim at
`docs/history/development/design/client-passivity-panel-2026-07-26.md`).
The plan below (§6) is build-ready pending the §7 owner decisions. No
build authorized yet.**

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

## 6. The amended plan (panel-final; supersedes the pre-panel skeleton)

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

## 7. Owner decisions — RESOLVED 2026-07-26

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
