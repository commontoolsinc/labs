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
