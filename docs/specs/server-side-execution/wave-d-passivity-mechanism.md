# Wave D — the P3 passivity mechanism (design)

**Live design doc.** The build spec for wave D of the passivity arc.
Siblings: [`README.md`](README.md) (the original spec),
[`implementation-plan.md`](implementation-plan.md) (phases),
[`client-passivity.md`](client-passivity.md) (plan + evidence log; §0 is
START HERE), [`context-lattice-execution.md`](context-lattice-execution.md)
(the lattice register) and
[`passivity-arc-orchestration.md`](passivity-arc-orchestration.md) (who
builds it, in what order). Archive to `docs/history/` per
[`docs/README.md`](../../README.md) when wave D completes.

**Status: DRAFTED, NOT RATIFIED.** §13's open questions are owner-gated
and unanswered as of 2026-07-29. Do not start building from this document
until Q1 is ruled — everything else is downstream of it.

**Provenance and verification.** Drafted by a subagent; the orchestrator
verified the load-bearing claims directly against the code rather than
accepting them. Verified: that claim issuance follows a run (so
`reportUnservable` takes an observation — this is what disqualifies the
wait-for-a-claim contract at boot); that observation adoption excludes
effects and is double-guarded (`actionKind !== "computation"` plus
`isKnownEffect`), which drives the Q2 recommendation; that
`CLAIMED_REMOTE_SPECULATION_GRACE_MS = 50` has exactly one use site
against a measured ~1.5 s time-to-first-claim; and that
`serverPrimaryExecutionBuiltinPassivityV1` is `getServerPrimaryExecutionConfig()`
rather than a dial of its own. The remaining citations were spot-checked,
not exhaustively re-derived — treat a surprising one as worth re-reading
before building on it.

---


Status: DRAFT for the orchestrator to rule on. No source changed, no
spec edited. Every claim about current behavior carries a file:line;
where a cited line has drifted since it was recorded in the spec, the
drift is called out rather than silently corrected.

Worktree: `/Users/berni/labs/.agents/worktrees/server-execution-w1-2-shared-pool`
at `a97aed884`.

---

## 0. Summary of what this document argues

1. **The hinge question has a boring answer, and that is the finding.**
   A passive client's contract for a never-claimed action is: *run it
   and commit it, exactly as today*. The claim is the only thing that
   ever transfers authority, so suppression keyed on anything else
   breaks the app. What P3 owes is not a new contract for that class —
   it is making the class **measurable per session** and making the
   rollout dial **gated on its size**. Recommendation in §2.
2. **Suppression today is at COMMIT time. P3 moves it to RUN time.**
   The existing seam decides where a finished transaction goes
   (`packages/runner/src/client-execution/action-transaction-router.ts:152-156`);
   it never stops the run. P3's mechanism is a run gate, and the seed
   of it already exists as a 50 ms hold
   (`packages/runner/src/scheduler/constants.ts:44`).
3. **Yes, the graph must be constructed to be dormant.** Three
   independent code paths force it — handler registration, observation
   adoption, and the CP1 rerun target — and each is cited in §7. P3
   removes boot *execution*, not boot *construction*. The design can do
   better only by a P5/E-shaped change (retained construction metadata,
   materialize-on-demand), and that should be priced there, not
   promised here.
4. **Claimed effects should keep running-and-suppressing at P3.**
   Suppressing an effect's *run* has no mechanism to keep its node
   clean, because adoption structurally excludes effects
   (`packages/runner/src/scheduler/facade.ts:1120-1122`). Its *egress*
   is already server-side under a claim. §5.4 argues this is inside the
   goal, not an exception to it, and §13 raises it as an owner
   question.

---

## 1. The frame

### 1.1 What the client does today for a claimed action

The claim-routing seam is
`packages/runner/src/client-execution/action-transaction-router.ts`.
Read it end to end — it is 157 lines and it is the whole of today's
"passivity":

- `routeClientActionTransaction` is called with an **already-produced
  transaction** (`ActionTransactionRouteInput`). Its docblock says so:
  "deliberately synchronous: the ordinary optimistic write contract
  applies pending versions before commit() returns" (:46-56).
- A claim matching the client's own lattice chain routes the commit to
  `{ disposition: "local", kind: "claimed-overlay", claim }` (:152-156).
  A never-committed overlay.
- Everything else routes `upstream` (:42-44), i.e. commits normally.

So the client **runs every standing computation and every effect**,
then decides where the resulting writes go. That is exactly what G17
describes as unbuilt (client-passivity §2) and what §5c measured:
"flag-on today ADDS server execution without REMOVING client
execution" (client-passivity.md:893-897).

The overlay is dropped and reconciled by
`dropClaimedOverlays` (`packages/runner/src/storage/v2.ts:6436-6553`).

### 1.2 The one pre-run gate that already exists

`markActionInvalid` takes a `deferClaimedRemote` option
(`packages/runner/src/scheduler/facade.ts:2651-2672`). When a *remote*
integrate dirties a **computation** that has a live claim on the
client's own chain
(`storage/v2.ts:1285-1296` — `hasLiveExecutionClaimForAction`), the
scheduler holds the local run for
`CLAIMED_REMOTE_SPECULATION_GRACE_MS = 50`
(`scheduler/constants.ts:44`, gate in `scheduler/gates.ts:170-189`).

The comment at `constants.ts:39-44` states the intent precisely: give
the claimed computation "one short leading-edge window to adopt that
observation before falling open to its ordinary local speculative run."

**This is P3's mechanism, with the wrong constant.** P3 is: replace
"50 ms" with "while the claim is live", and give the fall-open a
principled release set instead of a timer.

### 1.3 The convergence mechanism the gate depends on

Holding a run is only safe if something else marks the action clean.
That something is **incremental observation adoption**
(`docs/specs/scheduler-v2/incremental-observation-adoption.md`,
implemented): the server's committed run ships its observation with
the subscription sync, and the client installs it —
`adoptRemoteObservations`
(`packages/runner/src/scheduler/facade.ts:1101-1194`) →
`rehydrateActionFromObservation`.

Adoption's preconditions are the design constraints P3 inherits:

- **Computations only.** `observation.actionKind !== "computation"` is
  skipped (facade.ts:1120-1122), and known effects are skipped again at
  facade.ts:1130. Spec: C4 (adoption doc §2).
- **A registered local action must exist.**
  `this.actionsByObservationIdentity.get(...)` then `this.nodes.get(action)`
  (facade.ts:1123-1129). No node ⇒ no adoption.
- **`always-run` coordinators never adopt** (facade.ts:1134-1137; C7):
  `map`/`filter`/`flatMap` reconcile is what registers per-element
  children.
- **Local replica must hold confirmed records for the whole read/write
  surface at or below the observed seq** (`oracle.readsCurrentAtSeq`,
  facade.ts:1173; C2). A doc with no local record refuses adoption.
- **No pending local write may overlap** (facade.ts:1177; C3).

The last two are why P5's demand-time closure and P3's run gate are
coupled: an action whose closure the client no longer pulls cannot
adopt, so it falls open and runs. §5.2 handles this.

### 1.4 The gating metric, restated

§5h's ruling: the gate is the **never-claimed set**, not the fail-open
set, and P3 cannot fix it by suppressing (client-passivity.md:1761-1780).
The never-claimed set is instrumented server-side today as
`candidateUnservedByCode` / `candidateUnservedOffendersByCode`
(`packages/memory/v2/server.ts:2695-2716`, surfaced through
`packages/toolshed/lib/server-execution-observability.ts:34-37` and
fed by `packages/toolshed/routes/storage/memory.ts:297-315`).

Two things to be precise about, because the doc's shorthand blurs them:

- `claim-authority-lost` is genuinely **pre-claim**: it fires when
  `trySetExecutionClaim` returns null
  (`packages/runner/src/executor/deno-space-executor.ts:770-784`).
- `claim-key-mismatch` is **post-claim**: a live claim exists and the
  routed commit's derived key does not match it, so the claim is
  invalidated and the executor's own commit routes local
  (`packages/runner/src/executor/action-transaction-router.ts:467-480`).

Both land in the same `candidateUnserved*` bucket. The residual "4
events" of §5h.1 is therefore 2 never-claimed + 2 claimed-then-lost.
That distinction matters for P3 because the second class is CP1 (a
rerun heals it) and the first is not.

---

## 2. THE HINGE — the never-claimed action

### 2.1 The candidate contracts

**(a) Run it anyway and commit — status quo.**
Passivity is scoped to actions with a live matching claim on the
client's own chain; absent a claim, nothing changed. This is what
`routeClientActionTransaction` already does (`upstream` at :69).

*Failure mode:* the client keeps paying full local execution for
whatever the server does not claim. The "0× client standing work"
headline becomes "0× on the claimed set", and the uncovered residual is
invisible unless it is counted. In the worst case (serving coverage
regresses on a space) the flag buys nothing and costs the arbitration
overhead §5g measured (attempts and conflicts roughly double).

**(b) Wait for a claim, with a timeout, then run.**
On first dirtying of an action the client classifies statically
(`classifyStaticActionServability` is already imported client-side —
client-execution/action-transaction-router.ts:7) and, if `claim-ready`,
holds for a bounded window hoping a claim arrives.

*Failure mode, and it is disqualifying at boot:* claims are issued by
the executor **after it has run the action itself** — the candidate
report path is inside the executor Worker's own router
(`executor/action-transaction-router.ts:275-283` `reportUnservable`,
`deno-space-executor.ts:715` `onCandidateClaim`). At t=0 no claims
exist, and §0 measures time-to-first-claim at ~1.5 s warm
(client-passivity.md:36-38). A first-run hold therefore adds a
cold-executor delay to first paint for **every** action, which is
precisely what D10 forbids ("fast first paint", README §4 Q3:448-461).
It also inverts CP4: session-rank lane state is cold at every boot by
construction (client-passivity.md:381-384).

**(c) Ask the server to claim it.**
Client emits a per-action "please claim" request; the server either
claims or declines, and the client runs only on decline.

*Failure mode:* it adds a synchronous round trip to the run path of
every action, which is the same boot cost as (b) plus protocol. It also
grants the client a say in claim issuance, which cuts against D9's
trust direction (README §1:63-72: the client is the *less* trusted
party). And it cannot work: the server cannot decide servability from
a request — servability is a property of the *observation*, i.e. of a
run that has happened
(`dynamicActionTransactionUnservableReason` takes the commit,
`scheduler/servability.ts:550`). Asking is asking the server to run
it, which is what demand already does.

**(d) Render a gap and never converge.**
Purely passive: the client executes nothing standing, and unclaimed
derivations simply never have a value.

*Failure mode:* breaks the app, as §5h states outright
(client-passivity.md:1771-1773). Concretely: event handlers are
categorically unservable
(`scheduler/servability.ts:352-354` — `actionKind === "event-handler"`
returns `unservable("event-handler")`), so every handler-fed derivation
chain has an unservable root; and `dynamic-sqlite-operation` fires
unconditionally at `servability.ts:591`. A client that refuses to run
those renders a permanently empty app.

**(e) The recommendation: (a) as the per-action contract, plus a
per-session never-claimed counter and a coverage-gated rollout dial.**

### 2.2 Recommended contract, stated precisely

> **Passivity is claim-scoped and fails open by absence.** A passive
> client suppresses the local RUN of an action if and only if it
> observes exactly one live execution claim matching that action on its
> own lattice chain and the action is a computation. Every other
> action — never-claimed, ambiguously claimed, effect, handler,
> always-run coordinator — runs and commits byte-identically to
> flag-off behavior.
>
> The never-claimed set is not addressed by suppression. It is
> addressed by **counting it on the client**, publishing it beside the
> server's `candidateUnservedByCode`, and refusing to enable the
> passivity dial for a space whose measured coverage is below a
> ratified floor.

Three properties make this the right call rather than a shrug:

1. **It is the only contract consistent with the authority model.**
   `recordExecutionCandidateClaimReady`'s docblock is explicit that a
   claim-ready candidate "never transfers or implies authority"
   (`packages/memory/v2/server.ts:2682-2684`). Absent a claim, no
   transfer occurred, so the client is still the executor by
   construction (§5h's "the client never received authority").
2. **It converts P3's risk into a measurement, not a hope.** Today
   nobody can answer "if I flip passivity on this space, what fraction
   of standing work stops?" — the server's candidate counters see the
   executor's view, not the client's. §8 proposes the client-side
   mirror that answers it, and §10 proposes a stage-A dial position
   that measures it **without suppressing anything**.
3. **It keeps P2 as the lever it actually is.** Every reduction in the
   never-claimed set is a P2 serving-coverage win (as `8e1cb7d99`
   was: 16 events → 4), and P3 turns those wins into measurable client
   savings instead of leaving them abstract.

### 2.3 Two narrow refinements worth taking with it

- **Sticky exemption on permanent unserve.** When a claimed action
  settles `unserved` the client already reruns via
  `dirtyProducer: true` (`storage/v2.ts:6280`). A passive client must
  additionally mark that action **exempt from the hold for that claim
  generation**, or it will hold → time out → run → hold again every
  turn. The executor already has the symmetric notion:
  `permanentUnservedReasonForAction`
  (`executor/executor-worker.ts:342-353`) and the `unservedRoute` at
  `executor/action-transaction-router.ts:491-508`. Counter:
  `passivityExemptedActions`.
- **Hold watchdog, not hold forever.** If a claim is live but no
  settlement or observation arrives within a budget, release and run.
  This is the safety valve that prevents contract (a) from silently
  degrading into contract (d) when an executor dies mid-claim. Counter:
  `passivityHoldTimeouts`. Without it, the P6 leg
  "interact-during-executor-death" has no defined behavior.

---

## 3. Mechanism 1 — the per-session passivity subcapability

### 3.1 What exists, and the trap in it

`MemoryProtocolFlags` already contains
`serverPrimaryExecutionBuiltinPassivityV1`
(`packages/memory/v2.ts:252-253`). **Do not reuse it.** Two reasons,
both structural:

- It is **not separately dialed**: `getMemoryProtocolFlags` sets it to
  `getServerPrimaryExecutionConfig()` — the base dial — unlike the
  three subcaps below it which fold as `base && ownDial`
  (`packages/memory/v2.ts:1848` vs `:1852-1863`).
- It **is** an admission-required capability. It appears in
  `ExecutionProtocolCapabilities` and
  `missesRequiredExecutionCapability`
  (`packages/memory/v2/server.ts:873-904`), whose failure message names
  `builtin-passivity-v1` (:901-903). CP5's refutation depends on
  admission-required base caps staying admission-required
  (client-passivity.md:395-398).

So P3's dial is a **new** subcapability, `client-passivity-v1` /
`serverPrimaryExecutionClientPassivityV1`, layered above claim routing
and **never** added to `ExecutionProtocolCapabilities`.

### 3.2 The wiring surface, item by item (C2 is the template)

C2 (`256e73799`) built exactly this for `context-lattice-claims-v1`.
The chain, with the file each hop lives in:

| Hop | Site | C2's line |
| --- | --- | --- |
| Wire flag | `packages/memory/v2.ts` `MemoryProtocolFlags` + `WireMemoryProtocolFlags` | :254-261, :313 |
| Ambient dial | `packages/memory/v2.ts` set/get/reset trio | :1569-1590 |
| Env const | `packages/memory/v2.ts` `SERVER_PRIMARY_EXECUTION_*_ENV` | :1735-1741 |
| Server apply | `applyServerPrimaryExecutionEnvConfig` | :1784-1807 |
| Advertisement fold | `getMemoryProtocolFlags` (`base && ownDial`) | :1852-1854 |
| Client option | `ExperimentalOptions` key | `runner/src/runtime.ts:310-333` |
| Env map | `EXPERIMENTAL_ENV_VARS` | `runner/src/runtime-presets.ts:214-222` |
| Ambient install | `Runtime` constructor install + `dispose` unwind (`AMBIENT_EXPERIMENTAL_DIALS`; since 2026-08-01 an omitted flag is never written and a named one unwinds to the value it displaced, not to the default) | `runner/src/runtime.ts:996-1006`, `:1354-1357` |
| Worker protocol | `runtime-client/protocol/types.ts` `InitializationData` | :173-180 |
| lib-shell flags | `packages/lib-shell/src/runtime.ts` `ExperimentalRuntimeFlags` | :35-41 |
| Shell env | `packages/shell/src/lib/env.ts` global + define | :6-11, :34-45 |
| Build define | `packages/shell/felt.config.ts` | :66-73 |
| Registry doc | `docs/development/EXPERIMENTAL_OPTIONS.md` | §`serverPrimaryExecutionContextLatticeClaimsV1` |

Thirteen hops. CP18's "this program has shipped two unreachable dials"
is why the P3 row calls the wiring surface a *named deliverable*. The
deliverable is: **all thirteen in one commit, with the registry entry,
gated by a realm-separated negotiation test** (§9 leg 1).

### 3.3 Contract

- The subcapability is negotiated per connection and layered above
  `serverPrimaryExecutionClaimRoutingV1`: a connection that cannot
  route claims can never be passive.
- The server records it per attached session, exactly as the C1.7 flag
  is recorded (`packages/memory/v2/server.ts:5124-5126`,
  `:854-858` on `AuthenticatedExecutionDemand`).
- Absent parses to false; a mixed fleet stays valid.
- **Cohort policy: per-SESSION, not principal-wide.** Recommended, with
  the counter-argument stated in §13 Q4.

Rationale for per-session: suppression is keyed on a claim matching the
client's **own** chain (`client-execution/action-transaction-router.ts:66-68`
via `ownContextKeys`), so a sibling session that has not negotiated
cannot make this session's suppression unsound — it can only cost
redundant compute and conflicts in the sibling. C1.7's principal-wide
gate exists because a *user lane* is shared state across the
principal's sessions; a passivity decision is not. Choosing
principal-wide here would re-import the exact blocker C2 just paid to
remove (`client-passivity.md:138-144`).

### 3.4 Failure modes

- **The dial is unreachable in a realm-separated deployment.** The F5
  and C1.7 defect, twice. Mitigated only by the gate in §9 leg 1,
  which must drive `StandaloneMemoryServer.start()` and worker-realm
  clients with no injected flags
  (`packages/patterns/integration/server-execution-context-lattice-env-bridge-gate.test.ts:29-49`).
- **The gate passes vacuously.** C2's lesson: report `{sessions,
  passive}` as a pair, never the `every()` boolean
  (`packages/memory/v2/standalone.ts:57-84`, and the reasoning at
  :64-69). A gauge that reads "100% of 0 sessions" is a green test
  asserting nothing.
- **Someone adds it to the required set** because "every client
  supports it now". That silently converts a mixed fleet into
  rejections. Pin it: a test asserting the passivity flag's absence
  from `missesRequiredExecutionCapability`'s input type.

### 3.5 What would falsify this mechanism's design

- If suppression turns out to need principal-wide agreement — i.e. if
  some shared state converges incorrectly when one session is passive
  and another is not — the per-session choice is wrong and the cohort
  gate must move to principal-wide. The discriminating experiment: two
  browsers, same principal, one dial on and one off, on the group-chat
  leg; compare final converged values against the both-off arm.

---

## 4. Mechanism 2 — the passive-mode demand producer

### 4.1 The hole, verified

CP13 is exactly right and the code is unambiguous. `addExecutionDemand`
has **one** caller: `Runner.start`, gated on a successful start —

```
if (started && attempt.startedRoot !== undefined) {
  await this.addExecutionDemand(attempt.startedRoot);
}
```

(`packages/runner/src/runner.ts:1285-1287`.) Removal is symmetric
(`:2770` inside `stop`), and teardown clears (`:2827`). The producer
itself is `addExecutionDemand` (`:2196-2218`) → `queueExecutionDemand`
(`:2155-2194`) → `provider.setExecutionDemand("", pieces)` →
`session.execution.demand.set` on the wire
(`packages/memory/v2/client.ts:880-905`).

So demand is a **byproduct of graph construction**. If P3 ever
suppresses `start()`, the executor never starts and the whole regime
collapses — the empirical sweep in client-passivity §3 is the same
failure from the navigation side.

### 4.2 What demand actually needs

The payload is `readonly string[]` of **piece ids** — result-cell doc
ids (`link.id` at runner.ts:2207-2208; wire shape at
`packages/memory/v2.ts:844-856`). It needs no scheduler node, no
compiled pattern, no closure. The host's own validation is
authentication + READ authorization + session liveness
(`packages/memory/v2/server.ts:3944-3975`), and rows are swept on
connection close (`:3902-3942`).

**Therefore the passive-mode demand producer is genuinely
independent of the local scheduler**, and this is the one P3 mechanism
that could be built and landed on its own.

### 4.3 Contract

> A `Runner` with the passivity subcapability negotiated publishes
> execution demand for its **intended-running roots** — the set of
> result-cell ids the host application has asked to run — at the moment
> of intent, independently of whether `doStart` has completed, and
> retracts them on intent withdrawal.

Concretely:

- Split `start()` into *declare intent* and *construct*. Intent
  declaration calls `addExecutionDemand(resultLink)` before `doStart`;
  construction proceeds as today. The shrink gate
  (`ExecutionDemandShrinkGate`, runner.ts:736-750) already damps the
  churn this introduces, and P0's grace window already covers the
  navigation blip (client-passivity §5b).
- Failure of `doStart` must **retract** the demand, or a broken piece
  pins a Worker forever. Today a failed start never adds demand at all;
  under the split it must explicitly remove.
- The session-liveness bound is preserved by construction: demand rows
  are keyed `(connectionId, space, sessionId, branch)`
  (`packages/memory/v2/server.ts:906-911`) and swept with the
  connection. Nothing in the split touches that.
- **Do not** invent a second demand channel. CP14 bounds the fix to
  pool-side damping; a passive client publishing demand it cannot
  justify is a new authority surface.

### 4.4 Failure modes

- **Demand for a piece that never starts.** The executor spins up and
  runs a graph no client is rendering. Bounded by intent retraction and
  by the pool's existing hibernate/caps (README §6.5/§6.6), but it is a
  real new way to waste Worker-seconds, and P0b's keep-warm accounting
  row is where it should show up.
- **Demand published before authorization is known.** `setExecutionDemand`
  fails closed with `AuthorizationError` (server.ts:3953-3959) and the
  runner logs and swallows (`runner.ts:2164-2170` — "Demand is an
  optimization/authority offer"). Fine, but it means a passive client
  can silently have no demand and therefore no claims, which reads
  identically to "not engaged". The `passiveDemandPublishes` counter in
  §8 is what distinguishes them.
- **Ordering.** `queueExecutionDemand` deliberately invokes
  immediately so snapshots enter in caller order (runner.ts:2178-2181).
  Moving the call earlier must not break that; the barrier is a
  lifetime barrier only.

### 4.5 What would falsify it

- The zero-local-starts gate (§9 leg 3) failing to yield a live Worker
  would mean demand alone is insufficient — that the pool needs
  something else the start path was providing. Given §2.1 of the
  orchestration doc (the pool wakes on demand, and activation
  completion is observable only through `settle()`), the likeliest such
  hidden dependency is a *piece* the executor cannot resolve without a
  client having run it once. If that shows up, the passive demand
  producer needs a piece-descriptor push, and its scope grows.

---

## 5. Mechanism 3 — the run gate and the dynamic-reactivation contract

This is the mechanism the P3 row calls "suppression + reactivation". I
split it into the gate (5.1-5.4) and the reactivation contract
(5.5-5.7) because they fail differently.

### 5.1 The run gate

> **Gate.** In `markActionInvalid`
> (`packages/runner/src/scheduler/facade.ts:2651-2672`), when the node
> is a computation and `hasLiveExecutionClaimForAction(action)` is
> true, hold the run. Today the hold is
> `now + CLAIMED_REMOTE_SPECULATION_GRACE_MS` and applies only to
> remote-integrate invalidations
> (`scheduler/invalidation.ts:123` passes
> `deferClaimedRemote: notification.type === "integrate"`). Under
> passivity the hold becomes open-ended, released by an explicit
> **release set**, and applies to any invalidation of a claimed
> computation whose dirt originates remotely.

**Release set** (each is a counted cause):

| Cause | Trigger | Existing hook |
| --- | --- | --- |
| `adopted` | the server's observation arrives and adoption succeeds | `facade.ts:1185` |
| `claim-lost` | claim revoked / replaced / unserved / basis rejected | the six CP1 sites, `storage/v2.ts:4212, 6102, 6157, 6199, 6228, 6280` |
| `hold-timeout` | watchdog budget expires with no settlement | new |
| `local-write` | a local optimistic write overlaps the action's surface | `markActionInvalid`'s existing else-branch (facade.ts:2668-2672) |
| `exempt` | sticky exemption from a prior permanent unserve | new (§2.3) |

The `local-write` release is not optional. `markActionInvalid`'s
current comment is explicit: "Local optimistic writes, authority loss,
and every unclaimed/effect path retain the existing immediate
speculative behavior" (facade.ts:2669-2671). A handler write must still
produce immediate local feedback — that is D10's entire purpose.

### 5.2 Why the gate needs P5, and what happens if it ships without it

Adoption refuses when the local replica lacks confirmed records over
the observation's surface (adoption doc C2; `facade.ts:1173`). A client
that still pulls its standing closures will satisfy C2 routinely. A
client that has demoted its pulls (P5) will not, and the gate will
release `adoption-miss` constantly — passivity would read as engaged
(claims exist, holds happen) while delivering near-zero savings.

**Consequence for sequencing:** P3 must ship with the closure pulls
still standing, i.e. before P5's demotion, and the `adoption-miss`
release counter is the instrument that tells P5 what it broke. Shipping
them together would make the failure unattributable.

### 5.3 What the gate deletes

C1 ruled the only deletion is the `laneActingCommit === false` arm of
the runner mirror. Precisely: the client mirror calls
`dynamicActionTransactionUnservableReason` **without**
`laneActingCommit`
(`client-execution/action-transaction-router.ts:138-147`), which turns
off the §4 broad-scope backstop
(`scheduler/servability.ts:604-613`, documented at `:158-165`). Once
the client stops routing claimed commits at scoped rank, that branch
is unreachable.

**Citation drift, flagged rather than corrected:** client-passivity
§5h cites `servability.ts:588-594` for this arm. `8e1cb7d99` inserted
11 lines at :565, so the guard now sits at :604-607 and :588-594 is the
read loop's `dynamic-foreign-read-branch` check. The ruling is
unaffected; the line numbers are stale.

### 5.4 Effects: recommended scope

**Recommendation: P3 suppresses claimed COMPUTATIONS only.** Claimed
effects keep running-and-suppressing, as they do today.

Grounds:

- There is **no adoption path for effects.** `adoptRemoteObservations`
  skips non-computations (facade.ts:1120-1122) and known effects
  (:1130); the adoption spec's C4 makes it a correctness condition, not
  an optimization. A held effect node would stay dirty forever with
  nothing to clear it.
- The effect's **egress is already server-side** under a claim. The
  disposition is decided once per transaction in
  `extended-storage-transaction.ts:365-380`: a captured effect claim
  pins `executionEffectAuthority = "server"` and answers `"suppress"`.
  The executor Worker installs the mirror-image policy — allow iff the
  action has a live claim (`executor/executor-worker.ts:1543-1546`).
- On the suppressed side the builtin returns **before writing**:
  `sqliteQuery` at `builtins/sqlite-builtins.ts:741`, with the ordering
  rule A2 discovered spelled out at :737-740 (the dedup marker must not
  be written on the suppressed side).

So what remains client-side for a claimed effect is node re-evaluation
that egresses nothing and writes nothing. Per §1 point 1 that is
bookkeeping, not standing reactive work — **inside the goal**. But it
is not free, and §13 Q2 asks the owner to rule whether "0× standing
work" is claimed to cover it.

### 5.5 The dynamic-reactivation contract

> On claim invalidation, a passive client must, **within one scheduling
> turn**, (i) recover enough state to run the action, (ii) run it once,
> and (iii) commit normally — producing the canonical value, per CP1.

The plumbing already exists and is worth stating exactly, because the
contract is thinner than it sounds:

1. `dropClaimedOverlays(..., { dirtyProducer: true, ... })` emits an
   `execution-claim-invalidation` notification carrying the
   `sourceAction` (`storage/v2.ts:6542-6552`).
2. The scheduler receives it in `processStorageNotification`
   (`facade.ts:2183-2195`): calls `action.prepareClaimedRerun?.()` —
   implemented by the effect builtins that hold in-flight external work
   (`builtins/fetch-program.ts:357-365`, `builtins/llm.ts:925, 1279,
   2090`) — then `invalidateActionForHostWake(action)`.
3. `invalidateActionForHostWake` (`facade.ts:1609-1619`) marks invalid,
   force-adds to `pending` ("even when the local dependency graph
   happens to consider the action dormant" — :1612-1616), and queues
   execution.

**The contract P3 adds is a single conjunct:** the run gate must
release on this path *before* the invalidation is processed, and it
must be impossible for the gate to re-arm from the same claim
generation. Otherwise the rerun is held and CP1 silently stops working
— the most dangerous failure in this whole design, because the symptom
is a stale value, not an error.

Note `invalidateActionForHostWake` returns **false** when
`this.nodes.get(action) === undefined` (facade.ts:1610). That single
line is the strongest code-level statement of the dormant-graph
constraint in §7: with no resident node the mandated rerun is a silent
no-op.

### 5.6 Claim-lapse semantics (owed before P5)

A claim can stop being live without any invalidation notification —
the executor dies, the lease drains, renewal (`#scheduleClaimRenewal`,
`deno-space-executor.ts:790`) stops. From the client's side the claim
simply ages out of `executionClaimForActionKey`. Today that is fine
because the client ran the action anyway. Under P3 it is a stall.

**Contract:** the hold watchdog (§2.3) is the backstop, and its budget
must be ≤ the claim TTL, so a lapsed claim can never hold longer than
the claim itself could have lived. Counter: `passivityHoldTimeouts`,
split by whether a claim was still nominally live at release.

### 5.7 Failure modes of the gate

- **Held forever (the (d) failure, arrived at by accident).** Guarded
  by the watchdog; the gate's acceptance test must include an
  executor-killed leg.
- **Held then released then held (thrash).** Guarded by the sticky
  exemption; symptom is `passivityHoldTimeouts` climbing with
  `standingRunsSuppressed` flat.
- **Released so often the mechanism does nothing.** The
  `adoption-miss` and `local-write` causes are the likely dominators.
  This is not a bug — it is the honest answer that a space is not
  passivity-ready — and §10's stage A exists to discover it before
  suppression is turned on.
- **A held action's downstream never learns.** Adoption clears dirt on
  the adopted action; its dependents are dirtied by the arriving writes
  through the ordinary path (adoption doc §3: "apply writes → mark
  dirty readers → adopt matching observations"). If the server's run
  produced *no* write (a no-op settlement), there are no writes to
  dirty dependents with, and the adopted observation is what marks the
  action clean — correct. The risk is the reverse: a held action whose
  server run is a no-op and whose observation is not delivered leaves
  the client dirty and held until the watchdog. Counted, not silent.

### 5.8 What would falsify it

- If the two-browser leg with the gate on shows `standingRunsSuppressed
  > 0` but **no** reduction in client CPU or in per-post latency versus
  the gate off, the gate is suppressing work that was not on the
  critical path, and the mechanism is mis-targeted. The instrument that
  decides it is the adjacent-pair protocol on `CF_CHAT_MESSAGE_SERIES`
  (client-passivity.md:881-887), which already has an engaged baseline
  to compare against.

---

## 6. Mechanism 4 — the effect-attempt journal

### 6.1 The hole (CP17), verified

Each effect builtin owns an **ad-hoc durable marker**, and each marker
is scoped to that builtin's own result state:

- `sqliteQuery`: `result.set({ pending: true, requestHash: hash })`
  written *after* the suppression check and *before* the post-commit
  effect is enqueued (`builtins/sqlite-builtins.ts:741-749`); the dedup
  read is `if (result...get()?.requestHash === hash) return` (:713).
- `fetchProgram`: a per-`inputHash` state machine in a cache cell,
  `idle → fetching{requestId,startTime} → success|error`, with a
  timeout back to `idle` (`builtins/fetch-program.ts:271-340`).

Both markers ride the **same transaction** whose commit can be fenced.
So the CP17 window is real: egress released post-commit, writeback
fenced by a lane drain or a revoke, marker gone with the rolled-back
commit, next run re-egresses. Neither builtin can see that it already
called out.

`fetchProgram` even has an explicit *re-open* path for this
(`fetch-program.ts:279-290`, `reopenClaimedWork`) — it deliberately
re-enters `idle` after a claim incarnation change, i.e. it deliberately
re-egresses. That is correct today (the prior incarnation's work was
aborted) and is exactly the double-egress hazard once two executors
exist.

### 6.2 Contract

> A durable, space-local **effect-attempt journal** keyed by
> `(chain-scoped ActionClaimKey, inputHash)` carrying two records:
> `intent` — written in the same transaction that authorizes the
> egress, before the sink is released — and `completion` — written
> after the sink returns, carrying an outcome digest.
>
> Release rule: a sink may be released only if this attempt can write
> an `intent` record that does not already exist. On encountering an
> `intent` **without** a `completion`, the runtime does **not** treat
> that as licence to re-egress. It waits for the completion up to a
> budget, then reports `effect-attempt-ambiguous` and leaves the value
> gapped (D10 permits a gap; D5 forbids showing a wrong value).

Three deliberate properties:

- **It does not promise at-most-once.** At-most-once across a fenced
  writeback needs an idempotency key at the sink — the Tier-2
  `X-Idempotency-Key` item, explicitly unbuilt
  (`docs/specs/cfc-runner-future-work.md`, Tier 2, "Idempotency ledger
  / `X-Idempotency-Key`": "Only per-tx `outboxIdempotencyKeys` dedup
  exists"). What the journal buys is converting a **silent** double
  egress into a **counted, bounded ambiguity**. Claiming more would be
  the second thing in this arc asserted from a comment.
- **It subsumes the per-builtin markers rather than replacing them.**
  The builtins' markers are also their *result* state (`pending`,
  `fetching`), which the UI reads. Deleting them is out of scope; the
  journal sits underneath, and the ordering rule A2 found stays exactly
  as written (`sqlite-builtins.ts:737-740`).
- **It is the effect re-enablement gate.** Reactivation (§5.5) reruns
  computations automatically. For effects it must consult the journal
  first: no completion and a replay-safe sink class ⇒ rerun; completion
  present ⇒ adopt the recorded outcome; ambiguous ⇒ withhold and count.
  This is the concrete form of client-passivity §5 point 7's "effects
  are excluded from blind replay".

### 6.3 Failure modes

- **The journal write is itself fenced.** Then `intent` never lands and
  the egress is refused — fail-closed, correct direction, but it means
  a drained lane cannot egress at all until the fence clears. Acceptable;
  it matches the broker's existing live-lane-grant consult.
- **Journal growth.** One row per (action, inputHash) is unbounded over
  a long-lived space. Needs a retention rule keyed on claim generation
  plus a completion age; otherwise it is a new standing storage cost of
  exactly the kind CP2 warns about.
- **inputHash collisions across principals.** `sqliteQuery` already
  folds `clearanceReader` into its hash for exactly this reason
  (`sqlite-builtins.ts:702-708`). The journal key must be
  lane-qualified, or one principal's completion suppresses another's
  egress — a confidentiality-adjacent bug, not just a correctness one.

### 6.4 What would falsify it

- The P6 double-egress fixture (drain between egress and writeback,
  plus the offline variant) showing **two** external calls with the
  journal installed falsifies the release rule. Pull that fixture
  forward into P3's own gate (§9 leg 5) rather than discovering it at
  acceptance.

---

## 7. The dormant-graph question — plainly

### 7.1 The claim

> "The client runs 0× standing work" means "0× in steady state, with
> the graph resident and dormant." A dormant graph must still be
> constructed to be dormant.

**This is correct.** Three independent code paths force construction,
and no P3-shaped change removes any of them.

**(1) Handlers are client-inherent and register in the same pass as
everything else.** `instantiatePattern` loops over `pattern.nodes` and
calls `instantiateNode` for each (`runner.ts:1406-1419`); handler nodes
land at `runner.ts:4219-4225` (`scheduler.addEventHandler`). There is
no "handlers only" registration mode. And handler delivery *forces*
the start: `ensurePieceRunning` calls `runtime.start(resultCell)` on an
inbound event (`ensure-piece-running.ts:150`), reached from
`scheduler/events.ts:227`. Its comment is explicit that starting is how
handlers get registered (:148-149).

**(2) Adoption needs a resident node as its target.**
`adoptRemoteObservations` resolves `actionsByObservationIdentity` then
requires `this.nodes.get(action)` (`facade.ts:1123-1129`). No node ⇒
no adoption ⇒ the passive client has no mechanism to become clean
without running, which is the gate's whole premise.

**(3) The CP1 rerun re-queues a live `Action` object.**
`dropClaimedOverlays` collects `overlay.sourceAction`
(`storage/v2.ts:6542-6544`) and the scheduler re-queues it; the entry
point returns false with no node (`facade.ts:1610`). A client that
discarded the node would fail the fail-open class **silently**.

### 7.2 What it costs, honestly

Per piece, per session, on boot:

- Pattern resolution + load (`patternManager.loadPatternByIdentity`,
  reached from `ensure-piece-running.ts:131` and the start path).
- One `instantiateNode` per pattern node, each allocating cells,
  registering scheduler nodes and trigger-index entries
  (`runner.ts:2853+`, `facade.ts:792` `registerExecutionAction`).
- Registration-time rehydration per action, which is where the *not*
  running happens (`facade.ts:1030-1078`) — this is already built and
  is the boot half of passivity.
- Retained memory for the resident graph for the session's lifetime.

This is R10's "client compute for claimed actions and graph-query
subscription serving … standing machinery cost" row, and CP2's warning
that the warm set must be "enumerated, maintained, and counter-bounded,
never assumed free" (client-passivity.md:347-352) applies to it
verbatim.

### 7.3 Can the design do better?

Three candidate levers, only one of which is P3-shaped:

- **Don't RUN at registration.** Already available: durable
  observations rehydrate actions clean at registration
  (`facade.ts:1030-1078`), and P3's gate keeps them clean afterwards.
  **This is the whole of P3's boot win, and it is real** — the client
  boots by receiving materialized state, exactly as §1 point 3
  describes, without any change to construction.
- **Don't PULL at registration.** P5's demand-time closure demotion.
  Removes the doc-set/closure cost, not the node cost. Sequenced after
  P3 for the reason in §5.2.
- **Don't CONSTRUCT nodes not needed for the view.** The only lever
  that touches the residual, and it is not P3. The shape that could
  work: retain per-node *registration metadata* (enough to
  materialize on demand) and materialize a node lazily on first dirty,
  first claim loss, or first handler delivery. That preserves (1) if
  handler nodes stay eager, preserves (3) if materialization is
  synchronous within the invalidation turn, and breaks (2) unless the
  adoption index is keyed on metadata rather than on live `Action`
  objects. It is a wave-E-sized change with a real correctness surface,
  and promising it in P3 would be the third confident claim this arc
  regrets.

**Recommended framing for the spec:** state the goal as *"zero client
reactive re-execution on the served path, with the graph resident"* and
carry the residency cost as a **measured line item** (§8's
`graphNodesResident` / `graphConstructionMs`) rather than as an
asterisk. D10 already concedes exactly this shape: fast first paint
with gaps, not zero-execution first paint (README §4 Q3:456-461).

---

## 8. Counters — what proves passivity is working

Arc rule: every claim needs an engagement counter or it reads "not
engaged". Client-side counters extend `ExecutionRoutingBranchTotals`
(`packages/runner/src/storage/interface.ts:160-174`), which already
carries `routeDiagnostics` as a named-fail-open map; server-side
counters extend `ServerExecutionControlMetrics`
(`packages/toolshed/lib/server-execution-observability.ts:6-38`) and
its zod mirror (`packages/toolshed/routes/health/health.routes.ts:77-106`).

**The headline pair.**

| Counter | Meaning |
| --- | --- |
| `standingRunsSuppressed` | claimed computations NOT run because the gate held them |
| `standingRunsExecuted` | claimed computations run anyway, keyed by release cause (`adopted-late`, `adoption-miss`, `local-write`, `hold-timeout`, `claim-lost`, `exempt`) |

`standingRunsSuppressed === 0` reads **not engaged**, never "passive".
This is the P3 row's own gate ("suppression counter > 0 on the real
workload").

**The never-claimed mirror — the §5h gating metric, client-side.**

| Counter | Meaning |
| --- | --- |
| `neverClaimedRuns` | runs of an action with no live matching claim |
| `neverClaimedRunsByClass` | bucketed by the client's own static classification: `claim-ready-no-claim`, `unservable:<reason>`, `event-handler`, `effect`, `always-run` |

`claim-ready-no-claim` is the interesting bucket: the client thinks the
action is servable and no claim exists. A large value there means the
executor is not keeping up (or is not running), not that coverage is
missing — a completely different remedy from `unservable:*`. Today
nothing distinguishes them, because the server's `candidateUnserved*`
counters only see actions the *executor* ran.

**Coverage, the single number for the rollout decision.**

```
passivityCoverage =
  standingRunsSuppressed
  / (standingRunsSuppressed + standingRunsExecuted + neverClaimedRuns)
```

Reported per space and per session, alongside its denominator (never
alone — the C2 lesson).

**Cost honesty.**

| Counter | Meaning |
| --- | --- |
| `graphNodesResident` | live scheduler nodes (the dormant-graph gauge, §7) |
| `graphConstructionMs` | cumulative node-instantiation time |
| `passiveDemandPublishes` / `passiveDemandPieces` | the §4 producer firing |

**Effect journal.**

`effectIntentsWritten`, `effectCompletionsWritten`,
`effectAttemptsDeduped`, `effectAttemptsAmbiguous`,
`effectReactivationsWithheld`.

**D5.**

`overlayHoldsLive`, `overlayHoldReplacements`, `overlayHoldMaxAgeMs`
(§11).

**Server-side.**

`passiveSessions` reported as `{sessions, passive}` per space and
principal — the `contextLatticeClaimsCohort` shape
(`packages/memory/v2/standalone.ts:57-84`) — plus
`claimsIssuedToPassiveSessions`. The existing
`candidateUnservedByCode` / `candidateUnservedOffendersByCode` stay as
the executor-side never-claimed inventory and are compared against the
client-side `neverClaimedRunsByClass`; a large divergence between the
two means the two sides disagree about servability, which is itself a
defect worth surfacing.

---

## 9. The red-first gate for wave D

Six legs. Legs 1-3 are the P3 row's stated gates; 4-6 are the ones the
failure analysis above adds.

1. **Realm-separated negotiation gate.**
   `packages/patterns/integration/server-execution-client-passivity-env-bridge-gate.test.ts`,
   built as the C1.7/F5 sibling: `StandaloneMemoryServer.start()` in
   the test realm, clients as full production stacks in their own Deno
   Worker realms, **no injected `protocolFlags`**
   (template: `server-execution-context-lattice-env-bridge-gate.test.ts:29-49`).
   Assert `hello.ok` advertises the subcap AND the server records the
   worker-realm session as passive, reported as `{sessions, passive}`.
   Discrimination arm: subcap dial unset, base dial on ⇒ advertisement
   false, same live session negotiates nothing.
   *Red first:* assert `true`, get `false`, with the worker banner
   showing base-only — the exact C2 sequence.
2. **Suppression engages on the real workload.** Dial on ⇒
   `standingRunsSuppressed > 0` ∧ `claimsIssued > 0` ∧
   `workersStarted > 0`. Dial off ⇒ `standingRunsSuppressed === 0` and
   every other counter byte-identical (the discrimination half; the
   arc has already been burned by a green test asserting a false
   thing, §2.7 CORRECTION).
3. **Zero-local-starts still yields a live Worker + claims.** A client
   that publishes demand and starts no piece drives the pool to
   `workersStarted > 0` and `claimsIssued > 0`. Requires the §2.1
   `settle()`/`wake()`/`settle()` discipline. *Red first:* with the
   demand producer still coupled to `start()`, this is `0/0`.
4. **Reactivation produces the canonical value.** Hold a claimed
   computation, revoke the claim, assert that within one scheduling
   turn the client runs once and commits, and that the committed value
   equals the both-arms-off value. *Red first:* with the gate installed
   and the release-on-invalidation conjunct missing (§5.5), the value
   never lands — and note this failure is otherwise **silent**, which
   is why it needs its own leg.
5. **Effect journal: exactly one external call across a mode
   transition.** The P6 double-egress fixture (drain between egress and
   writeback, plus the offline variant) pulled forward.
6. **Mixed fleet.** A non-negotiating session of the same principal
   attaches; assert admission never rejects (CP5) and the negotiating
   session's suppression counters are unchanged. This is the leg that
   discriminates the per-session cohort choice (§3.3) from the
   principal-wide one.

**Measurement legs** (not tests — the §2.5 protocol): adjacent-pair
runs of `CF_CHAT_MESSAGE_SERIES` and the persistent-page scenario with
the dial off/stage-A/stage-B, full-capture output, `/api/health/stats`
curled in the same command, load recorded, engagement counters on every
number.

---

## 10. Migration and rollout shape

C2 made the dials deployable, so the rollout is a dial sequence rather
than a build sequence.

**Stage 0 — wiring, dial off.** All thirteen hops of §3.2 plus the
registry entry, gated by §9 leg 1. Zero behavior change: the subcap is
advertised only when dialed, absent parses false, and the gate is not
armed.

**Stage A — dial on, gate disarmed (measurement only).** The subcap
negotiates, the client computes *what it would have suppressed*, and
publishes `standingRunsSuppressed` as a **counterfactual** — it runs
the action anyway. This is the honest instrument for "is this space
passivity-ready", and it is nearly free because it is the same counter
with the hold skipped.

This directly answers the §2 hinge in operational terms: a space's
`passivityCoverage` is measured *before* anything is suppressed, so
"suppression would break this app" is discovered by a number rather
than by a user.

**Stage B — gate armed.** Per space, never the same dial event as
stage A. This mirrors D6 / the P5 row's two-stage rule
(client-passivity.md:401-406, and the P5 row's "stage A soak … stage B
passivity flip — never the same dial event").

**Ordering against P5.** P3 stage B ships **before** P5's closure
demotion, per §5.2, so that `adoption-miss` is attributable.

**Rollback.** The dial is per-session and negotiated per attach, so
rollback is a reconnect. No durable state changes except the effect
journal, whose rows are additive and ignorable by a client that does
not consult it.

---

## 11. The D5 risk surface, concretely

### 11.1 Where a flicker can appear today

Exactly one code path can retract a value the user has already seen:
`dropClaimedOverlays` (`storage/v2.ts:6436-6553`).

1. It removes the overlay's pending versions from every touched doc and
   clears `record.materialized` (:6488-6498).
2. It diffs before/after and, when the value changed, emits an
   `integrate` notification to subscribers and notifies sinks
   (:6520-6538) — which is what reaches render.

When `dirtyProducer: true`, step 1 happens **before** the replacement
exists: the rerun is only queued, via the invalidation emitted at
:6542-6552. So between the drop and the rerun's commit, the UI shows
the pre-speculation value. That is the flicker, and it is precisely
CP8's "premature drop of correct speculation" plus CP7's "conflict
overlay drop".

The six `dirtyProducer: true` sites (`storage/v2.ts:4212, 6102, 6157,
6199, 6228, 6280`) are therefore the six flicker triggers. The
basis-covered path (:6335, `dirtyProducer: false`) is the benign one:
the canonical value has already been applied.

### 11.2 What P3 changes

**The surface shrinks.** A held claimed computation creates **no
overlay** — `recordClaimedOverlay` is reached only from the
`claimed-overlay` route (`storage/v2.ts:4192-4202`), which requires the
client to have run and committed. Nothing run, nothing to retract.

**It concentrates in three places:**

1. **Handler writes.** Still client-committed (§1 point 1), and per the
   amended D2 so are folded sqlite writes
   (client-passivity.md:1803-1808). These produce ordinary optimistic
   pending versions and can still be dropped on conflict — CP7's path,
   repaired by P4's catch-up-gated retry, not by P3.
2. **P4 speculative runs.** Out of P3's scope but they land on the same
   drop path.
3. **The gate's own release.** A held action that releases on
   `hold-timeout` computes a value that the server may later replace.
   This is a *new* divergence class P3 introduces.

### 11.3 What suppresses each

- For (3), the D5 rule applies directly: **hold, never flicker.**
  Display the locally computed value; when the canonical value arrives,
  replace only if the values differ, and count the replacement
  (`overlayHoldReplacements`). Identical values must produce no
  notification at all — the existing diff at :6520-6522 already
  achieves this, since `changed` is false.
- For (1) and (2), the D5-conformant repair to `dropClaimedOverlays` is
  to **not clear the pending versions at :6488-6498 when
  `dirtyProducer: true`** — instead mark them *held* and clear them
  when the rerun commits or the canonical value arrives. That converts
  the drop-then-rerun gap into a hold. Cost: a held tier that must be
  bounded (`overlayHoldsLive`, `overlayHoldMaxAgeMs`) or a stuck rerun
  pins a stale value on screen indefinitely — which is a worse failure
  than a flicker and must be counted, not hoped away.
- The gap case is explicitly fine: D10 allows rendering a gap for a
  value the server has not delivered and filling it on arrival
  (README §4 Q3:448-453). A gap is not a flicker.

### 11.4 The one place a user would actually notice

Tab switch or piece open under a cold executor, with the gate armed and
no durable observation to rehydrate from. The client holds, renders a
gap, and the gap persists for the executor's cold-start (~1.5 s warm,
worse cold). That is the interaction the P6 gate must measure by name,
and it is the strongest argument for the watchdog budget being *short*
— on the order of the measured serve latency (§0's ~0.5-0.9 s settle
plus the second refresh wave, CP3), not seconds.

---

## 12. What would falsify the design as a whole

- **`standingRunsSuppressed` is large and latency does not improve.**
  The gate suppresses work off the critical path; the mechanism is
  mis-targeted and the win is elsewhere (serving path, feed).
- **`neverClaimedRunsByClass` is dominated by `claim-ready-no-claim`.**
  Coverage is fine and the executor is the bottleneck; P3 is premature
  and the work belongs in P0/pool scaling.
- **`standingRunsExecuted{adoption-miss}` dominates before P5 even
  ships.** Adoption's C2 precondition is not satisfiable on the real
  workload, and the gate can never engage — the design's convergence
  premise is wrong.
- **Reactivation leg (§9 leg 4) cannot be made to pass without
  weakening the gate.** Then CP1 and passivity are genuinely in
  tension, and the fail-open class needs a different mechanism than
  "re-queue the resident action".
- **`graphNodesResident` × per-node cost turns out to dominate the
  measured boot delta.** Then §7's residual is the whole problem, P3's
  boot win is nominal, and wave E's lazy-materialization lever becomes
  the critical path rather than an optimization.

---

## 13. Open questions for the owner

**Q1 — Is "0× client standing work" a claim about the CLAIMED set or
about all standing work?** §2 recommends the former; §5h says the
latter is unattainable without P2 coverage first. If the owner wants
the stronger statement, P3 must wait on a never-claimed budget being
met, and the arc reorders. *(This is the hinge; everything else is
downstream of it.)*

**Q2 — Do claimed EFFECTS have to stop running client-side at P3?**
§5.4 recommends no: their egress is already server-side
(`extended-storage-transaction.ts:365-380`), and adoption structurally
excludes effects (`facade.ts:1120-1122`), so a held effect node has
nothing to clear it. But the theory's own wording is "computations AND
effect builtins run server-side". Ruling wanted on whether the residual
node re-evaluation is inside the goal.

**Q3 — Is the boot residual (a constructed dormant graph) acceptable as
the P3 end state?** §7 says it is forced by three code paths and that
removing it is wave-E-shaped. If the owner wants it removed in this
arc, the lazy-materialization design in §7.3 needs to be scoped now,
because it changes the adoption index's key from `Action` objects to
metadata — a change P3 would otherwise build on top of.

**Q4 — Per-session or principal-wide cohort gate for the passivity
subcap?** §3.3 recommends per-session, on the grounds that suppression
is keyed on the client's own chain. The counter-argument: a
non-negotiating sibling keeps executing redundantly and keeps
generating the conflicts §5g measured, so a principal-wide gate would
make the measured buy cleaner. That is an argument about *measurement
hygiene*, not correctness — but this arc has been burned by
un-measurable configurations before.

**Q5 — Should the effect-attempt journal be allowed to admit that it
cannot guarantee at-most-once?** §6.2 designs it to convert silent
double-egress into a counted ambiguity, because at-most-once needs the
Tier-2 sink-side idempotency key that is explicitly unbuilt. The
alternative is to pull that Tier-2 item forward too, which grows P3
substantially. The failure this avoids is another comment recording a
limitation as accepted design.

**Q6 — Two stale-looking assertions the code makes about itself, worth
a look before they harden:**

- `CLAIMED_REMOTE_SPECULATION_GRACE_MS = 50`
  (`scheduler/constants.ts:44`) and its "one short leading-edge window"
  comment (:39-44) read as a tuned constant, but 50 ms is far below
  the measured serve chain (~0.5-0.9 s settle plus a second refresh
  wave, CP3). If it was never measured against that chain, the existing
  defer path is almost certainly a no-op in practice — which would mean
  P3's mechanism has never actually run, not even in miniature. Worth
  one counter before building on it.
- `serverPrimaryExecutionBuiltinPassivityV1` is advertised as
  `getServerPrimaryExecutionConfig()` (`packages/memory/v2.ts:1848`) —
  i.e. it is not a separate dial at all — while being an
  admission-**required** capability (`v2/server.ts:880-904`) whose name
  claims exactly the thing P3 is building. If that name is meant to
  become P3's dial, the required-capability coupling has to be
  understood first; if it is not, the naming collision will mislead
  every future reader. Recommendation: keep them separate and say so in
  the registry entry.

---

## Appendix — citation index for the load-bearing claims

| Claim | Citation |
| --- | --- |
| Suppression is commit-time, not run-time | `runner/src/client-execution/action-transaction-router.ts:46-56, 152-156` |
| Effect suppression already gated on `builtinPassivity` | same file, :83-85 |
| Client mirror omits `laneActingCommit` (C1's deletion) | same file, :138-147; guard at `scheduler/servability.ts:604-613`; doc at :158-165 |
| A 50 ms claimed-run hold already exists | `scheduler/constants.ts:39-44`; `scheduler/facade.ts:2651-2672`; `scheduler/gates.ts:170-189` |
| Live-claim query used by that hold | `storage/v2.ts:1285-1296` |
| Adoption is computations-only and needs a resident node | `scheduler/facade.ts:1101-1194`, esp. :1120-1130 |
| Adoption preconditions (C1-C7) | `docs/specs/scheduler-v2/incremental-observation-adoption.md` §2 |
| Registration-time rehydration (the boot half) | `scheduler/facade.ts:1030-1078` |
| Demand has exactly one producer: `start()` | `runner/src/runner.ts:1285-1287`; producer at :2196-2218; wire at `memory/v2/client.ts:880-905` |
| Demand payload is piece ids only | `runner.ts:2207-2208`; `memory/v2.ts:844-856` |
| Demand auth + session-liveness bound | `memory/v2/server.ts:3944-3975`, sweep :3902-3942 |
| Handlers register in the same pass as computations | `runner.ts:1406-1419`, :4219-4225 |
| An event forces a piece start | `ensure-piece-running.ts:148-150`; caller `scheduler/events.ts:227` |
| CP1's six rerun triggers | `storage/v2.ts:4212, 6102, 6157, 6199, 6228, 6280` |
| The rerun path | `storage/v2.ts:6542-6552` → `scheduler/facade.ts:2183-2195` → `:1609-1619` |
| Rerun is a no-op with no resident node | `scheduler/facade.ts:1610` |
| Overlay drop = the flicker | `storage/v2.ts:6488-6498` (clear), :6520-6538 (notify) |
| Effect disposition decided once per tx | `storage/extended-storage-transaction.ts:365-380` |
| Executor's mirror-image sink policy | `executor/executor-worker.ts:1543-1546` |
| Per-builtin durable markers (the journal's precursors) | `builtins/sqlite-builtins.ts:710-749`; `builtins/fetch-program.ts:271-340, 357-365` |
| Idempotency ledger unbuilt | `docs/specs/cfc-runner-future-work.md`, Tier 2 |
| Claim-ready never transfers authority | `memory/v2/server.ts:2682-2684` |
| Never-claimed inventory counters | `memory/v2/server.ts:2695-2716`; `toolshed/lib/server-execution-observability.ts:34-37`; `toolshed/routes/storage/memory.ts:297-315` |
| `claim-authority-lost` is pre-claim | `executor/deno-space-executor.ts:770-784` |
| `claim-key-mismatch` is post-claim | `executor/action-transaction-router.ts:467-480` |
| Handlers categorically unservable | `scheduler/servability.ts:352-354` |
| sqlite ops categorically unservable | `scheduler/servability.ts:591` |
| Permanent-unserve machinery exists | `executor/executor-worker.ts:342-353`; `executor/action-transaction-router.ts:491-508` |
| `builtin-passivity-v1` is required + not separately dialed | `memory/v2/server.ts:873-904`; `memory/v2.ts:1848` |
| Subcap fold pattern (`base && ownDial`) | `memory/v2.ts:1852-1863` |
| Server env apply | `memory/v2.ts:1784-1807` |
| Cohort gauge reports a pair, not a boolean | `memory/v2/standalone.ts:57-84` |
| C2's env-bridge gate shape | `packages/patterns/integration/server-execution-context-lattice-env-bridge-gate.test.ts:1-49` |
| Client routing counters to extend | `runner/src/storage/interface.ts:160-174` |
| Server control counters to extend | `toolshed/lib/server-execution-observability.ts:6-38`; `toolshed/routes/health/health.routes.ts:77-106` |
