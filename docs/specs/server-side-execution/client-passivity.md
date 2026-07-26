# Client passivity: the no-dual-execution end state

**Status: PANEL INPUT (2026-07-24). Owner theory under adversarial review;
no build authorized. The panel's charge and the plan skeleton are at the
bottom.**

## 1. The theory (owner, 2026-07-24)

1. All *reactive* operations — standing computations and effect builtins —
   are servable server-side; nothing reactive is client-only. Only event
   handlers (Phase 5) and render are client-inherent.
2. Therefore a client can stay **passive**: it receives server-pushed data
   and runs no standing reactive work. On a user action (an event), the
   client syncs **only the state change** (the handler's writes), while
   **speculatively** applying the change locally for latency; the canonical
   value always arrives from the server.
3. Therefore startup shifts computation from client to server (the client
   boots by receiving materialized state, not by computing it), and
   update "storms" collapse to at most one extra round — the case where
   another client's event ordered first and the server pushes intermediate
   state before this client's event is folded in.

Goal: **no e2e latency increase from shifting computation to the server** —
fully-engaged flag-on ≤ flag-off, within noise, on the three-way protocol
below (interaction latency AND boot latency).

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
  pre-designed for handlers.
- **R10**: "client compute for claimed actions (N× speculation) and
  graph-query subscription serving" is carried as a *standing machinery
  cost* row, resolved by "Phase 3 feed + G17 suppression."
- **F3/F6/F2**: the `docs` watch (view-subscription primitive),
  session-scoped cohort delivery, and 0-DAG member point reads are
  exactly the passive-client delivery substrate — built and measured.
- **§4 expected shape**: "server compute approaches the sum of client
  compute — the §2.1 N× redundancy replaced by 1× client speculation +
  1× server verification per session, which G17 then reduces client-side."
  The theory tightens this: for standing work, 0× client + 1× server;
  speculation only downstream of local events.

## 3. Premise inventory (what "everything runs server-side" is worth today)

**Documented worklist (register, 2026-07-18 state):**

- **R12 resolved** (C2.8): scoped-lane effect egress landed. Residual:
  *offline* egress under standing keys (zero connected sessions ⇒ no
  grant ⇒ no claim), riding OQ1. Passivity concerns connected clients, so
  this residual does not block the theory — but it bounds "the server
  keeps computing while nobody is connected" for effects.
- **R13 open**: `wish` has static identity but **no descriptor** — not
  servable; measured ×4 in the flagship fixture (W2.15b owed).
- **R5 open worklist**: effects lacking server implementations — `llm`,
  `sqliteQuery` (broker implementations); computation builtins lacking
  descriptors — `streamData`, `llmDialog`, `compileAndRun`,
  `sqliteDatabase`, `navigateTo`, `inspectConfLabel`.

So premise 1 is true of the *architecture* and false-today of the
*registry*: there is a named, finite serving-coverage worklist. The plan
must carry it (or gate passivity per-action on servability, which the
classifier already computes).

**Empirical sweep (2026-07-24, real browser, base flag-on, n=10): the
executor never ran.** `claimsIssued=0`, `workersStarted=0`,
`workerStartAborts=2`, `parkedWakeAttempts=2 / parkedWakeStarts=0`, with
1,505 demanded pieces across 15 demand snapshots. Cause (toolshed log +
`shared-execution-pool.ts:628`): the browser clears execution demand on
navigation transitions; `demands.length === 0` **aborts the in-flight
Worker start**; real navigation cadence (note↔home per note) beats Worker
cold-start every time; parked wakes skip on the same empty-demand check
and never revive. The pool converges to never-live under the real
workload. (Corollary: the one run that DID issue claims was the pre-fix
17s-per-note storm run — slow enough for the start to win its race.)

Two consequences:

1. **The unserved-actions inventory is still owed** — it needs a run with
   a live executor (blocked on the liveness fix below).
2. **Every fully-engaged e2e number measured this arc had a dead
   executor.** The measured overheads are pure client-side flag machinery
   (claim routing, execution-control feed, demand churn, doc-set
   reconciles) — the server-authoritative round-trip the theory depends
   on has never been browser-measured.

## 4. The measured baseline the plan must beat (2026-07-24, n=20 each)

| quartile avg (ms) | flag-off | base flag-on | fully engaged |
| --- | --- | --- | --- |
| notes 1-5 | 1547 | 2373 | 4342 |
| notes 16-20 | 2491 | 3778 | 7466 |
| all | **2082** | 3091 | 5447 |

With the executor dead in both flag-on legs (see §3), the decomposition
reads: **+~1s = client-side flag machinery** (not claim coordination —
there were no claims), **+~2.4s and growing = the doc-set client leg**,
dominated by revisit-pull amplification: the docs-watch replace destroys
server-side selector coverage, so navigation release+revisit becomes full
cold closure re-resolution (23× watch.add DAG at equal call counts,
~270 DAG/pull growing with space size; `coveredSelectorSkips` never
engage). F5's own steady-state counters are excellent throughout
(refresh 1,654 vs 15,450 DAG; `session.docset.read` 0-DAG).

Reading for the theory: the entire measured regression is cost the hybrid
pays to keep the CLIENT executing (closure pulls, membership upkeep,
standing machinery). A passive client issues none of it. What passivity
adds instead — served-value round-trips on the interaction path — is
exactly the unmeasured quantity.

## 5. The sharp edges (what the panel must resolve)

1. **Speculation scope.** (a) direct handler writes only; (b) writes +
   pure computations feeding the current view (owner instinct: the right
   default — the needed closure ≈ the view's inputs ≈ the doc-set already
   held); (c) never effects (double egress; non-negotiable — the
   scheduler's effect/computation classification provides the line).
   Decide, and define the closure the client must hold for (b).
2. **Convergence semantics.** Speculative overlay → canonical replacement
   exists (claimed-overlay/settlement machinery). Define divergence UX
   (server computed differently / rejected): hold vs flicker vs re-run;
   and the R11 reconciliation-window accounting for the speculative case.
3. **Executor liveness under real demand cadence** (the §3 defect):
   demand hysteresis/grace ≥ Worker cold-start, sticky per-space demand
   across same-space navigation, parked-wake revival on demand return.
   Without this there is no server to be passive against.
4. **Serving completeness**: the R5/R13 worklist, plus per-action
   passivity gating for anything unservable (client must keep running
   exactly the actions the server cannot claim — the classifier knows).
5. **Handler input closures**: handlers read state; bound "client holds
   view data" against handlers whose reads exceed the view (event-time
   fetch latency vs eventual server-side handlers per §5.B.3).
6. **Boot path**: passive boot = subscribe + receive materialized state.
   Server must be warm (executor live, demand-sponsored) or boot waits on
   server cold compute. Interaction with the §3 liveness fix; measure
   cold vs warm boot explicitly.
7. **Offline / degraded**: a passive client has no local reactive engine
   running; passivity must be a *connected mode*, with the local engine
   retained for offline (mode transition semantics: catch-up on
   reconnect, speculation replay?).
8. **Mixed fleet / migration**: dial + negotiation (per-session
   capability like the doc-set subcap), CA4-style ordering constraints,
   and what interim F7 band-aid (if any) is worth landing while this
   ships (owner default: none — the hybrid's pull cost is the thing
   passivity deletes; keep the graph-retirement dial off for
   browser-facing spaces meanwhile).
9. **Confidentiality**: server-pushed canonical values must respect the
   C1/C2 scope boundaries (per-user/per-session instances) in the
   passive delivery path exactly as the lane machinery enforces for
   execution; F6 cohort gating covers the push side — verify no gap when
   the client stops computing (e.g. values the client previously derived
   locally under its own identity now arrive from lanes).
10. **Latency accounting for parity.** Enumerate the interaction path
    round-trips under (b)-scope speculation: event → local speculative
    apply (0 RT) → handler-write commit (1 RT) → served canonical values
    ride the same accepted-commit push the client already consumes. The
    theory predicts parity because the commit RT exists flag-off too and
    speculation hides the serve latency; the panel must attack this
    accounting (wake latency, settle batching, F6 fan-out timing,
    multi-hop derivation chains that need N sequential serve rounds).

## 6. Plan skeleton (to be finalized from panel output)

- **P0 — executor liveness** (the §3 defect): demand
  hysteresis/stickiness + parked-wake revival + a red-first pool test
  binding start-under-navigation-cadence; acceptance: live Worker +
  claims issued on the real n=10 browser workload.
- **P1 — measure the true baseline**: with P0 live, re-run the three-way
  + capture served-value latency (claim→settle→push→client-apply) per
  interaction; the unserved-actions inventory sweep (premise 1's
  empirical leg).
- **P2 — serving-coverage worklist**: R5 brokers/descriptors + R13 wish
  (priority-ordered by the P1 inventory's incidence counts).
- **P3 — G17 passivity mechanism**: suppress client standing computation
  for claimed+served actions behind a negotiated per-session dial;
  per-action fallback for unservable actions; cold remote-owned actions.
- **P4 — speculation**: scope decision from panel; speculative overlay
  semantics + divergence handling; handler-write sync path (pre-G13
  envelope work only where needed).
- **P5 — passive boot + doc-set-as-view-subscription**: retire the
  execution-closure pull path client-side (the F7 cost class disappears);
  boot = subscribe + seed.
- **P6 — acceptance**: three-way n=20, fully-engaged ≤ flag-off (all
  quartiles, interaction + boot), guard clean, unserved inventory empty
  or per-action-gated.

Each P-row gets red-first gates and a rollout dial per arc discipline.
