# Context-Lattice Execution: Scoped and Cross-Space Server Authority

Status: design draft for review. Nothing below Phase C0 is implemented.
C0 (dynamic-read admission) is implemented on the Phase 0–2 branch; this
document records its contract. This is the reviewed design that
[README.md](./README.md) Phase 4 names as its entry requirement, extended to
cover session context and cross-space execution (gaps G9 and G16), because
the review of Phase 2.5 concluded that a permanent client-computed carve-out
is the wrong end state.

Author: design session 2026-07-15, from the Phase 2.5 measurement evidence
(see the
[interactive-latency investigation](../../history/development/performance/server-execution-interactive-latency-2026-07-15.md)
and implementation-plan §4.5).

Related: `docs/specs/server-side-execution/README.md` (§3.2.1 context keys,
§5.B.6 scoped boundary, §6.8 cross-space, G9/G16/G17),
`docs/specs/scoped-cell-instances.md`, `docs/specs/cfc-*` (scope and label
semantics), `docs/specs/memory-v2/` (scope_key partitioning).

---

## 1. Why full context support, not a carve-out

Phase 2 claims only provably same-space, space-scoped actions. Measurement
on real patterns showed what that boundary costs:

- **Coverage collapses on real graphs.** Product derivations routinely read
  entity documents through links (lunch-poll tallies, list projections).
  Any read the transformer cannot enumerate made the action unservable
  (`dynamic-read-outside-static-surface`) and its durable rows
  session-qualified, so the flagship multi-client fixture ran an entire
  vote workload with zero server recomputes: 434 of 438 accepted-commit
  notices matched no demanded stale reader.
- **The fail-closed direction is prove-a-negative.** To classify an action
  broadly, the host must prove its whole surface never touches narrower
  scope — and incomplete, dynamic, or unknown surfaces therefore start at
  `session` and never promote (§3.2.1). Uncertainty anywhere poisons the
  claim. This is the same "follow every link to prove absence" burden the
  original design pushed off the client; it landed on the classifier.
- **Every carve-out keeps the reconciliation machinery alive.** Overlays,
  settlements, revocation handling, and unservable churn exist because the
  server cannot own everything. Each increment of coverage shrinks the
  surface where that complexity operates; a permanent PerSession or
  cross-space carve-out fixes it as a floor.
- **Trust.** The eventual goal that server-verified computation can anchor
  downstream integrity applies to session-derived state too. Since
  session-ness propagates through link chains, a permanently unverified
  region taints everything downstream of it.
- **Session context is the majority, not the edge case.** After C0 landed,
  the lunch-poll space's durable rows classify as 24 space / 13 user /
  **226 session** context — and only 7 of the 226 read exclusively
  space-scoped documents; the rest genuinely read PerSession state (drafts,
  selections, per-viewer clocks) that saturates real UI graphs, including
  the vote-tally chains. The lunch-poll placement gate therefore cannot
  pass before C2: its workload's readers live in session context, so
  space-lane wake lookups correctly match nothing. Any design that treats
  session lanes as deferred hardening defers most of a real graph.

The design goal, then: **one execution mechanism, parameterized by context
rank, in which the conservative default flips from fail-closed-unservable
to fail-open-to-narrowest-lane.** An action whose context is uncertain is
not rejected; it is served in the narrowest lane consistent with the
evidence (the causing session's lane) and promoted when evidence proves it
broader. No component — client or server — ever needs to prove a negative.

PerSession inclusion is deliberate (revisiting §5.B.6's deferral):
session-scoped derivation does not need Phase 5 events. Its inputs arrive
as ordinary session-scoped source commits, and the acting-context can be
bound from the accepted commit's authenticated origin session — the same
causal-origin pattern the builtin broker already uses for
`causalActorMatchesSponsor`. Events remain the Phase 5 vehicle for
*handlers*; derivations ride the lattice.

## 2. The lattice, restated as an execution model

`SchedulerExecutionContextKey` already forms the lattice
`space < user:<principal> < session:<principal>:<sessionId>` for durable
metadata (§3.2.1, implemented). This design makes it the execution
primitive:

- **A lane is (branch, space, contextKey).** Phase 2's one-Worker-per-
  branch/space becomes one Worker hosting multiple context lanes. The
  `space` lane is exactly today's behavior. Lanes share the Worker's module
  cache, replica, and provider channel; they do not share scheduler state,
  claims, or acting context.
- **Claims and settlements carry the lane's contextKey.** The
  `ExecutionClaim.contextKey` field exists and is pinned to `"space"` in
  Phase 2; the protocol shape does not change. Client routing already
  matches claims by exact `ActionClaimKey` including contextKey, so a
  session-context claim from the feed only suppresses the matching session's
  local run — other sessions never see a matching key.
- **Demand stays doc/piece-shaped and connection-owned.** A session's
  demand implies demand for its own session-context lane; user-context
  lanes aggregate demand from all of a principal's sessions. No new demand
  message is required; the host derives lane demand from the session that
  published it.
- **Classification becomes lane *selection*, not admission.** The router
  and the engine derive the action's effective context from observed
  surfaces exactly as §3.2.1 does today, with one inversion: an action that
  lands narrower than its current lane is not unserved — its claim moves to
  the narrower lane (next run executes there), and only genuinely
  inadmissible surfaces (cross-space writes before C3, foreign-space
  anything, unknown action kinds) unserve.

### 2.1 C0 — dynamic-read admission (implemented)

The first inversion step, already landed, applies within the space lane:

- Reads discovered outside the static read envelopes no longer unserve a
  claimed attempt and no longer force the session context floor. Each
  dynamic read must itself be same-space and effectively space-scoped,
  enforced per address by the router
  (`dynamicActionTransactionUnservableReason`) and the engine firewall
  (`assertSpaceScopedAddress`); envelope-covered surfaces keep the certified
  static-summary judgment (so a certified cross-space PerUser summary still
  classifies at `user`).
- Writes remain strictly bounded by their declared envelopes at every
  layer (`schedulerRuntimeWritesExceedSummary`, router write coverage,
  client `observationMinimumContextRank`). Authority follows writes; reads
  determine wake correctness, which follows the per-run actual-read index:
  each accepted attempt's observation indexes the reads that run actually
  performed, and a read set can only change through a document the previous
  run already read — the same soundness argument client reactivity relies
  on.
- Safety: a dynamic read that turns out session- or user-scoped, or
  foreign-space, still rejects the whole transaction at the firewall and
  narrows the context floor — fail-open to the client (Phase 2) or to the
  narrower lane (this design), never a partial apply.
- **Companion invariant: no commit may name a host-unresolvable localSeq.**
  Executor-shadow versions and claimed-overlay versions never receive a
  server resolution; a pending read naming one fails apply forever
  ("pending dependency not resolved"). Both replicas therefore rebase such
  reads onto the confirmed base beneath the local version before send
  (`rebaseUnresolvablePendingReads`) — which is §B.3's contract stated
  operationally: conflict detection compares against committed state.
  C0 made the client half of this reachable for the first time (real list
  computeds staying claimed meant handlers read claimed overlays; without
  the rebase, their source commits could never land).

C0 alone moves most real same-space derivation into claimable territory; it
is also what makes the wake index see link-following readers, dissolving
the discovered chicken-and-egg (unservable actions were never indexed, so
their inputs' commits woke nothing).

## 3. Acting context and authority

The Worker executes a lane's actions **as** that lane's context, not as the
space sponsor:

- **Space lane:** unchanged — the user-sponsored `ExecutionLease`
  (`onBehalfOf` one WRITE-capable requester).
- **Session lane:** acting context is bound from the **causal origin
  session** — the authenticated session whose accepted source commit
  invalidated the lane's actions. The host already carries the origin
  session on every accepted commit and already compares it against the
  sponsor for builtin egress (`causalActorMatchesSponsor`); this design
  generalizes that comparison into lane selection. The Worker never holds
  session credentials: session-context commits traverse the provider under
  a host-derived `actingContext` that the engine validates against the
  claim's contextKey and the causal commit's session, exactly as
  `executionClaimAssertion` is validated today. A session-lane attempt
  whose causal origin does not match its lane settles canonically unserved,
  mirroring the builtin mismatch rule.
- **User lane (G16):** a user-context lane needs authority that outlives
  any one session. v1 of this design uses the same host-derived binding —
  any live authenticated session of that principal anchors the lane, and
  the lane drains when the principal's last session disconnects (its state
  is durable; nothing is lost). A standing delegated execution key —
  revocable, per (user, space) — is the hardening path that lets a user
  lane run with zero connected sessions (offline continuation); it slots in
  behind the same `actingContext` seam without changing lane mechanics.
  Choosing standing grants vs session-derived anchoring for v1 is Open
  question 1.
- **CFC:** commits in scoped lanes carry the acting context's principal for
  label validation, identical to the same commit arriving from that user's
  client. `onBehalfOf` records execution authority; provenance records the
  acting context; neither is semantic authorship (§B.7 unchanged).

## 4. Lane lifecycle and cost model

- **Session lanes are as ephemeral as their sessions.** Demand for a
  session lane exists only while that session is connected; disconnect
  drains the lane (bounded, like sponsor teardown today). Durable rows are
  already session-qualified, so a reconnecting session's lane rehydrates
  from its own rows. Parked wake for session lanes is skipped: with no
  connected session there is no reader to serve and no acting context to
  bind — commits accumulate dirty markers and the lane catches up on
  reconnect.
- **User lanes follow principal liveness** (any connected session of the
  principal) in v1; with delegated keys they may also serve wake-on-commit
  while offline, which is precisely the async-durability win PerUser state
  wants (cross-device continuation).
- **Cost honesty:** session-context state has exactly one reader, so
  server-executing it deduplicates nothing — it is pure added compute,
  bought for uniformity and eventual verification. The bill scales with
  active sessions' derivation activity, concentrated in hot UI chains.
  Mitigations, all existing mechanisms: authored `debounceMs`/`throttleMs`
  on hot computeds apply in lanes exactly as on clients; lanes hibernate
  with their sessions; the SQLite-primary model keeps parked lanes at zero
  memory; and rollout can gate session-lane claims independently (see §6)
  if the fleet bill surprises. Expected shape: server compute approaches
  the sum of client compute — the §2.1 N× redundancy replaced by 1×
  client speculation + 1× server verification per session, which G17 then
  reduces on the client side for remote-caused work.

## 5. Cross-space execution (G9)

Cross-space is the one genuinely different beast, kept as its own phase:

- **Reads first.** A claimed action with certified or dynamic foreign-space
  *reads* can be served once settlements carry a **vector input basis**
  (`inputBasisSeq` per space) and the executor's provider can perform
  authenticated point reads against the foreign space under the acting
  context's authority (the same ACL path as that user's client session).
  Client overlay reconciliation generalizes: an overlay drops when the
  settlement's vector covers the overlay's per-space basis — same rule,
  per component. Wake needs a cross-space subscription: the foreign
  engine's accepted-commit index notifies the home lane's pool through the
  same host-only callback seam, keyed by the demanded reader rows the home
  space persists for foreign addresses.
- **Writes later, under dual leases.** A cross-space *write* requires the
  executor to hold both spaces' execution authority for the action's
  transaction (never split; §B.2's whole-action rule is unchanged). That
  means claim issuance gated on holding an `ExecutionLease` in every
  written space, fencing in each, and a two-space settlement ordered
  against both feeds. Until then, cross-space writers stay
  client-authoritative — but by then they are the *only* residual class.
- Permission changes mid-flight (losing read access to the foreign space)
  revoke the claim exactly like a scope violation: whole-action fallback.

## 6. Rollout: one mechanism, staged enablement

Build the lattice once; enable claim issuance per context rank behind the
existing `serverPrimaryExecution` flag plus one internal, owner-invisible
dial (not a new user-facing mode): space (today) → user → session →
cross-space-read → cross-space-write. Staging is pure risk management —
fail-open claims mean the client never classifies anything at any stage;
an un-enabled rank simply behaves like Phase 2's unclaimed fallback. The
dial is registered in `EXPERIMENTAL_OPTIONS.md` with a removal path (fully
folded into `serverPrimaryExecution` once all ranks graduate).

Interactions:

- **Phase 3 feed:** claims-with-closures become the feed's coverage source.
  Lattice lanes multiply claims, which is exactly what the doc-set feed
  needs to retire per-session graph-query re-evaluation — the measured
  dominant flag-on cost (main-isolate traverse stalls). Sequence the feed
  as soon as space+user lanes give closure coverage on the dogfood spaces;
  do not wait for cross-space.
- **Phase 5 events:** handlers still move via signed envelopes later.
  Session lanes make that cheaper — the acting-context machinery and
  session lanes built here are exactly what server-side handler runs need.
- **G17 client suppression:** unchanged contract (claimed → may stay cold
  for remote-caused invalidations); the lattice only widens what is
  claimed.

## 7. What changes where (implementation sketch)

| Surface | Change |
| --- | --- |
| `packages/runner/src/scheduler/servability.ts` | context-rank classification instead of space-only rejection: `non-space-*-scope` reasons become lane-selection outcomes; cross-space stays inadmissible until C3 |
| `packages/runner/src/executor/executor-worker.ts` | one Runtime per lane (session/user lanes constructed on demand inside the same Worker), lane-keyed candidate/claim maps; acting context threaded to the provider |
| `packages/runner/src/storage/v2-host-provider.ts` | `actingContext` on commits; host validation against claim contextKey + causal origin session; scoped point queries under the acting principal |
| `packages/memory/v2/server.ts` / `engine.ts` | claims/settlements/wake queries keyed by contextKey (schema already carries it); causal-origin binding check (generalize the builtin causal-actor rule); session-lane demand derivation; vector basis (C3) |
| `packages/runner/src/storage/v2.ts` (client) | routing already matches exact contextKey; overlay basis becomes per-space vector in C3; otherwise unchanged |
| docs | EXPERIMENTAL_OPTIONS entry for the rank dial; runbook signals per lane rank |

Phasing (each phase red-green, one PR-sized WO series like Phase 0–2):

- **C0 — dynamic-read admission (implemented).**
- **C1 — user lanes:** lattice lane infrastructure, acting-context seam,
  user-rank claims, session-anchored user authority. Gate: a PerUser
  derivation is served for two principals with isolated rows and zero
  client derived wire writes; flag-off parity holds.
- **C2 — session lanes:** causal-origin binding, session lane lifecycle,
  session-rank claims. Gate: a PerSession derivation settles under its own
  session's context; a foreign session's commit can never bind it.
- **C3 — cross-space reads** (vector basis, foreign wake, ACL-checked
  foreign point reads). Gate: a two-space read chain settles with a vector
  basis and drops the overlay exactly once.
- **C4 — cross-space writes** (dual leases) — explicitly last; may be
  re-scoped after C3 experience.

## 8. Open questions

1. **User-lane authority at zero sessions:** session-anchored (v1-simple,
   no new key material, lane sleeps when the user is fully offline) vs
   standing delegated execution keys (offline continuation, revocation
   surface, consent UX). Recommendation: ship C1 session-anchored; design
   the delegated key alongside C2 with CFC owners.
2. **Promotion cadence:** narrowing is evidence-driven and immediate
   (unchanged); how eagerly to *re-promote* an action whose fingerprint
   changed (new code) — first run in the causing session's lane then
   promote on evidence, or trust the new static summary immediately?
   Recommendation: trust the summary (it is the same trust the space lane
   already places in it), keep runtime narrowing as the corrective.
3. **Session-lane admission control:** per-Worker lane count is bounded by
   connected sessions, but a space with hundreds of sessions needs a lane
   budget (G18 territory). Cheap v1: LRU-park session lanes beyond a cap;
   parked session lanes are correct by construction (client remains
   authoritative for anything unclaimed/unserved).
4. **Does C1 precede or follow the Phase 3 feed?** The feed only needs
   space-lane coverage to start paying; C1 widens it. Recommendation:
   start the feed after C0 measurement confirms coverage on dogfood
   spaces; run C1 in parallel — different subsystems, different owners.
