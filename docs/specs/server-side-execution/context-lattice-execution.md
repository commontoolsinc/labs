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
not rejected; it is served in the narrowest admissible lane. Within one
implementation fingerprint, classification only narrows — §3.2.1's
"observed absence alone can never promote" rule is unchanged; the
broadening path is a new fingerprint whose trusted summary certifies a
broader surface (Open question 2). What disappears is the prove-a-negative
*admission* burden: uncertainty selects a narrower lane instead of
unservability.

PerSession inclusion is deliberate (revisiting §5.B.6's deferral):
session-scoped derivation does not need Phase 5 events. Its inputs arrive
as ordinary accepted commits — the session's own scoped writes and any
other principal's shared-state writes alike — and execution authority
comes from the lane's own grant (§3), independent of which commit caused a
recompute. (The causal-origin pattern the builtin broker uses for
`causalActorMatchesSponsor` is *only* an egress-consent precedent; an
earlier draft generalized it into lane authority and review showed that
unserves every cross-session-caused recompute.) Events remain the Phase 5
vehicle for *handlers*; derivations ride the lattice.

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
  Phase 2; the protocol shape does not change. **The W2.1 routing contract
  does change:** exact-contextKey matching is not reproducible client-side,
  because the server's lane choice folds in durable context floors the
  client cannot see (including a global floor narrowed by *another*
  principal's runtime evidence). A client that derives `space` while the
  server claims at `user:<did>` would silently never suppress — restoring
  the write race for exactly the actions this design adds. Routing is
  therefore **chain-scoped**: match the `ActionClaimKey` minus contextKey,
  then accept iff `claim.contextKey ∈ {"space", user:<my did>,
  session:<my did>:<my sessionId>}` — the client's own lattice chain. A
  claim naming another principal or another session never matches; a claim
  broader or narrower-within-my-lattice
  than my local estimate still suppresses, which also gives continuity
  across lane moves. There is deliberately **no rank comparison against the
  client's own estimate**: the server's floor may lag the client's local
  evidence (or vice versa), and rejecting a broader-than-my-estimate claim
  would leave client and lane both executing into *different* scoped
  instances — a divergent-duplicate window. Accepting it instead parks the
  client on a lane that, when it performs the narrower read, firewall-
  rejects, narrows, and reissues under revoke-before-issue — the same
  fail-open correction path as every other misclassification.
- **Control events are context-scoped, not space-broadcast.**
  Session-context claims/revokes/settlements are delivered only to the
  session their contextKey names; user-context events only to that
  principal's sessions; space-context events to all capable sessions (as
  today). Without this, session lanes make the control feed and reconnect
  snapshots O(sessions² × actions) — every session storing and replaying
  every other session's per-invalidation settlements — and the bounded
  suffix would thrash into full snapshots. Scoping also shrinks a
  reconnect snapshot to "my lanes + the space lane," which is what keeps
  the reconnect story coherent at scale.
- **Live claims for one action must be routing-disjoint.** Claims keyed by
  full `ActionClaimKey` would otherwise permit a space-lane claim and a
  session-lane claim for the same action to be live simultaneously with
  one client matching both. The invariant, checkable at issuance: for one
  (branch, space, pieceId, actionId, fingerprints) tuple, no single client
  identity (did, sessionId) may match two live claims under the
  chain-scoped acceptance rule. That permits the legitimate fan-out —
  `session:alice:s1` and `session:bob:s2` coexisting, since no client
  matches both — and forbids space+anything and `user:p` +
  `session:p:sN`. A lane move is ordered **revoke-before-issue** on the
  control feed — the interim window is explicitly client-authoritative
  (fail-open, as everywhere else), and each issuance in a narrowing
  fan-out follows its own revoke-first ordering.
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
space sponsor. Authority is anchored on the **lane itself**, never derived
per causal wave (an earlier draft bound session lanes to the causal origin
commit's session; review showed that unserves every cross-session-caused
recompute — Bob's vote invalidating Alice's session-context tally — fails
on coalesced waves with mixed origins, and is undefined on cold lane
starts, so it was replaced):

- **Space lane:** unchanged — the user-sponsored `ExecutionLease`
  (`onBehalfOf` one WRITE-capable requester).
- **Session lane:** authority is a host-derived **lane grant** anchored on
  the lane-owning connected session, validated exactly as the sponsor
  binding is today (live session, bound principal, owning connection —
  the `bindExecutionSession` checks). The Worker never holds session
  credentials: session-context commits traverse the provider under a
  host-derived `actingContext` that the engine validates against the
  claim's contextKey and the live lane grant, exactly as
  `executionClaimAssertion` is validated today. Which commit *caused* a
  recompute is irrelevant to lane authority: any principal's accepted
  source commit may invalidate a session-lane action, and the recompute
  runs under the lane's own grant.
- **Scoped-lane builtin egress is a decision, not an inheritance.** Naively
  applying §B.5's causal-actor rule against the lane grant's session would
  re-import the rejected causal-origin shape for the builtin subset: a
  session-context `generateText` over shared poll data, invalidated by
  another principal's vote, would settle unserved on every foreign-caused
  recompute — a permanent claim-churn generator. v1 therefore **statically
  excludes builtins with cross-session-reachable inputs (any shared
  space- or user-scoped read surface) from scoped-lane claims**; they stay
  client-primary. This is a named, narrow carve-out (egress only —
  pure derivations are unaffected, so §1's no-carve-out thesis holds for
  integrity), chosen because the alternative — executing egress under
  Alice's lane grant when Bob's commit caused the recompute — weakens
  §B.5's confused-deputy protection and must not be adopted without CFC
  owners explicitly signing off. Relaxing the carve-out on the argument
  that the lane grant is the consent boundary is Open question 6.
- **Per-lane fencing.** Each lane grant carries a monotonic **lane
  generation**, host-internal — not a wire-protocol field on claims (§2's
  protocol-shape promise stands; claim incarnations already fence
  settlements). Its check locus is the host provider: **every lane
  operation, scoped point reads included, validates the live lane grant
  and its generation**. That is the generation's unique job — commits are
  already fenced atomically by the lease generation plus exact live-claim
  resolution, but a queued scoped *read* arriving after the owning session
  died has no claim to check, and user-lane re-anchoring needs an
  incarnation name. Lane drain = fence that generation immediately, revoke
  that lane's claims, leave sibling lanes untouched — §B.8's drain
  semantics at lane granularity. The host performs this drain when the
  lane-owning session disconnects, including mid-settle: the host, not the
  Worker, is the revoker of record for a dead session's claims. Exact
  accepted replays remain idempotent, as with lease fencing.
- **User lane (G16):** a user-context lane needs authority that outlives
  any one session. v1 anchors the lane grant on one live authenticated
  session of the principal; when the *anchoring* session disconnects while
  other sessions of the principal survive, the lane takes a bounded drain
  and re-anchors on a surviving session under a new lane generation — never
  a seamless mid-settle handoff (mirroring sponsor-loss semantics). The
  lane fully drains when the principal's last session disconnects (its
  state is durable; nothing is lost). A standing delegated execution key —
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
  drains the lane (bounded, per-lane fencing per §3). Durable rows are
  already session-qualified, so a reconnecting session's lane rehydrates
  from its own rows. Parked wake for session lanes is skipped: with no
  connected session there is no reader to serve and no acting context to
  bind — commits accumulate dirty markers and the lane catches up on
  reconnect. This skip is staleness-only — but the argument must be stated
  against what `docs/specs/scoped-cell-instances.md` actually permits, not
  against an invariant it does not have. That spec's contract: a
  computation's *output* takes the narrowest-of-read scope, with broader
  output locations storing **links** to the scoped instance; and,
  separately, narrow-to-wide **value** writes are explicitly sanctioned as
  the data-widening path — handlers and lifts writing into passed-in cells
  do not change the target's scope. Two consequences:

  - **Lane-admissible writes are the output-link path only.** A lane's
    writes to instances broader than the lane are admissible only as a
    scoped link (declared scope at or narrower than the lane) in a
    declared output/link slot. An action whose write surface includes
    narrow-derived *value* writes to broader instances is **excluded from
    scoped-lane claims and stays client-authoritative**: N session lanes
    performing the same broad value write would be competing authoritative
    writers — the race this design exists to end. This is a real,
    spec-sanctioned carve-out (unlike pure derivations); shrinking it
    means evolving scoped-cell semantics, which is Open question 7 for
    that spec's owners. Primary enforcement lives in the runner's
    output-scoping step (which already decides instance placement and
    link emission); the execution firewall remains the scope-resolution
    backstop and gains the link-shape check for broader-instance lane
    writes.
  - **Wake soundness, restated.** Parked-lane wake skip is sound because
    *lane-authored* writes are so constrained: a lane's commits touch its
    own scoped instances plus output links, never broad values. The
    sanctioned narrow-to-wide value writes happen client-side (handlers,
    excluded lifts), land as ordinary broad commits, and wake broader
    lanes through the normal accepted-commit index — no scoped-lane wake
    is involved, so skipping it loses nothing.
- **User lanes follow principal liveness** (any connected session of the
  principal) in v1; with delegated keys they may also serve wake-on-commit
  while offline, which is precisely the async-durability win PerUser state
  wants (cross-device continuation).
- **Cost honesty:** session-context state has exactly one reader, so
  server-executing it deduplicates nothing — it is pure added compute,
  bought for uniformity and eventual verification. The bill scales with
  active sessions' derivation activity, concentrated in hot UI chains.
  Two costs the sum understates: **serialization** — the sum of what N
  browsers compute in parallel lands on one isolate per space (Worker
  threads notwithstanding, lanes in one Worker share a thread), and Phase
  2.5 measured a *single* lane lagging 8–22 s before its fixes — and
  **lane cold start** — Runtime construction, piece instantiation, and
  rehydration on every session connect, pure overhead for short-lived
  sessions. C2 therefore carries an explicit acceptance gate: settlement
  latency under at least three concurrent session lanes on one space must
  stay within the agreed budget. Mitigations, all existing mechanisms:
  authored `debounceMs`/`throttleMs` on hot computeds apply in lanes
  exactly as on clients; lanes hibernate with their sessions; the
  SQLite-primary model keeps parked lanes at zero memory; and rollout can
  gate session-lane claims independently (see §6) if the fleet bill
  surprises. Expected shape: server compute approaches the sum of client
  compute — the §2.1 N× redundancy replaced by 1× client speculation + 1×
  server verification per session, which G17 then reduces on the client
  side for remote-caused work.

## 5. Cross-space execution (G9)

Cross-space is the one genuinely different beast, kept as its own phase,
and **scoped in v1 to co-resident spaces** — both engines inside one memory
host. Nothing below defines a cross-host mechanism; multi-host execution is
registered as its own gap (accepted-commit subscription, stale-reader
lookup, and the provider channel are all same-process primitives today).

- **Reads first.** A claimed action with certified or dynamic foreign-space
  *reads* can be served once settlements carry a **vector input basis**
  (`inputBasisSeq` per space) and the executor's provider can perform
  authenticated point reads against the foreign space under the acting
  context's authority (the same ACL path as that user's client session).
  Two consequences must be named, not discovered: servability of a
  cross-space action under the *space* lane depends on the current
  sponsor's foreign-space access, so sponsor rotation may legitimately flip
  claims for reasons invisible to the action (scoped lanes do not have
  this: their acting principal is fixed); and the home host needs a new
  **foreign-readers index** — foreign address → home-space demanded
  readers — consulted when the foreign engine accepts a commit, because
  today's stale-reader lookup only queries the committing space's own
  engine.
- **Client reconciliation changes are real work, not a footnote.** Overlay
  basis and confirmation tracking are per-space-replica structures; a
  vector basis requires correlating space-B confirmation events into an
  overlay held in space A's replica. The drop rule generalizes per
  component — an overlay drops only when every component of the
  settlement's vector covers the overlay's basis for that space — and this
  introduces a named divergence window, the vector analog of §B.4's
  non-transitive scalar window: a settlement's B-component can cover the
  overlay while the client's own B replica still lags, so the revealed
  home-space confirmed value reflects B-state newer than what the client
  displays from B. Accepted, brief, self-healing, and counted, exactly as
  §B.4 counts its window.
- **Foreign permission changes are fenced by an authorization epoch, not
  just named.** "Losing access revokes the claim" has a TOCTOU hole
  without a mechanism: the foreign ACL can change after the point read and
  before the home-space result commits. Each cross-space claim (and each
  attempt) binds a **foreign authorization generation** — a per-(space,
  principal) epoch the foreign engine bumps on any ACL mutation affecting
  that principal. An ACL bump revokes claims holding the old generation,
  and the home-space accept transaction revalidates the bound generation
  before applying — a stale generation makes the whole attempt settle
  canonically unserved, like any other firewall rejection. The C3 gate
  covers both shapes: revocation while idle, and revocation between the
  foreign read and the home apply.
- **Writes later — and dual leases are necessary, not sufficient.** A
  cross-space *write* requires the executor to hold both spaces' execution
  authority for the action's transaction (never split; §B.2's whole-action
  rule is unchanged): claim issuance gated on an `ExecutionLease` in every
  written space, fencing in each. But leases solve *ownership* only. The
  current storage contract applies multi-space commits **sequentially with
  no cross-space atomicity**: commits stop at the first per-space failure,
  earlier spaces stay durable, and the cross-space state is explicitly
  indeterminate (`packages/runner/src/storage/interface.ts`, the
  multi-space opt-in contract). Clients live with that today because their
  writes are convergent; an *authoritative* executor cannot — a settlement
  must never claim whole-action success when the second space failed, and
  client overlay reconciliation and fail-open reruns are undefined against
  an indeterminate partial apply. **C4's entry prerequisite is therefore a
  coordinated commit protocol for co-resident engines** (prepare/outcome
  record with recovery replay across both databases, or an explicit
  per-space partial-outcome settlement vocabulary with defined client
  behavior for each partial state) — its own design, reviewed before C4
  starts. Until then, cross-space writers stay client-authoritative — but
  by then they are the *only* residual class.

## 6. Rollout: one mechanism, staged enablement

Build the lattice once; enable claim issuance per context rank behind the
existing `serverPrimaryExecution` flag plus one internal, owner-invisible
dial (not a new user-facing mode): space (today) → user → session →
cross-space-read → cross-space-write. Staging is pure risk management —
fail-open claims mean the client never classifies anything at any stage;
an un-enabled rank simply behaves like Phase 2's unclaimed fallback. The
dial is registered in `EXPERIMENTAL_OPTIONS.md` with a removal path (fully
folded into `serverPrimaryExecution` once all ranks graduate).

Two hard rollout rules the dial alone does not give:

- **Version skew needs a subcapability, and lane opening must be gated on
  it.** Scoped claims require the chain-scoped routing of §2; a Phase-2
  client negotiates today's capabilities, would receive session-context
  claims for its own session, match none of them (its keys say `space`),
  and never suppress — while the server also executes: duplicated compute
  plus write races on the hottest per-keystroke state, strictly worse than
  flag-off. Scoped claim delivery therefore rides a new handshake
  subcapability (`context-lattice-claims-v1`), and — the load-bearing
  half — the host must not open a session lane for a session that did not
  negotiate it. **User lanes need the stronger, principal-wide rule:** a
  user lane may open only when *every* connected session of that principal
  has negotiated the subcapability, and admitting a non-negotiating
  session of the principal **fences the lane's generation and revokes its
  claims before that session's demand/watch barrier completes** — no
  window in which the Phase-2 client and the lane are both authoritative.
  Otherwise a principal running one negotiated and one Phase-2 client
  would have the Phase-2 session committing user-scoped derived writes
  against the lane's commits — the exact write race this gate exists to
  prevent, created by its own half-measure. The C1 gates include a
  mixed-version reconnect fixture: a Phase-2 session of the same principal
  connecting mid-run drains the user lane before it can observe or race
  any lane commit.
- **C2 on multi-session spaces is gated on the Phase 3 feed** (or at
  minimum session-scoped watch filtering). Session lanes add roughly one
  server commit per session-derived change per session — multiplying
  exactly the per-session graph-query re-evaluation that the Phase 2.5
  measurements identified as the dominant flag-on cost. Enabling C2 before
  that cost is structural-fixed would multiply the known bottleneck.

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
| `packages/runner/src/scheduler/servability.ts` | context-rank classification instead of space-only rejection: `non-space-*-scope` reasons become lane-selection outcomes; narrow-derived value writes to broader instances stay client-authoritative (§4); cross-space reads stay inadmissible until C3, cross-space writes until C4 |
| `packages/runner/src/executor/executor-worker.ts` | one Runtime per lane (session/user lanes constructed on demand inside the same Worker), lane-keyed candidate/claim maps; acting context threaded to the provider. **The Worker replica must be re-keyed by effective scope key** — the client replica keys documents by declared scope because a client is single-session; a multi-lane replica holding two sessions' instances of one id collides otherwise. This re-keying (doc map, pending versions, overlays, unresolvable-read rebase, provider sync frames, lane-tagged read resolution) is the intra-Worker confidentiality boundary and is load-bearing, not a refactor detail |
| `packages/runner/src/storage/v2-host-provider.ts` | `actingContext` on commits; host validation against claim contextKey + the live lane grant (per-lane generation); scoped point queries under the acting principal |
| `packages/memory/v2/server.ts` / `engine.ts` | claims/settlements/wake queries keyed by contextKey (schema already carries it); lane grants with per-lane generations and host-side drain on session death; context-scoped control-event delivery (§2); the `context-lattice-claims-v1` subcapability gate on lane opening (§6); session-lane demand derivation; foreign-readers index and vector basis (C3) |
| `packages/runner/src/storage/v2.ts` (client) | **chain-scoped claim routing replaces exact-contextKey matching (§2 — a W2.1 contract change)**; overlay basis becomes per-space vector in C3 with the cross-replica confirmation plumbing §5 names |
| docs | EXPERIMENTAL_OPTIONS entry for the rank dial; runbook signals per lane rank |

Phasing (each phase red-green, one PR-sized WO series like Phase 0–2):

- **C0 — dynamic-read admission (implemented).**
- **C1 — user lanes:** lattice lane infrastructure, acting-context seam,
  user-rank claims, session-anchored user authority. Gate: a PerUser
  derivation is served for two principals with isolated rows and zero
  client derived wire writes; flag-off parity holds.
- **C2 — session lanes:** lane grants with per-lane fencing, session lane
  lifecycle, session-rank claims; prerequisite: the Phase 3 feed (§6).
  Gates: a PerSession derivation settles under its own session's lane grant
  regardless of which principal's commit caused the recompute; a foreign
  session's client never matches the claim and its state is never readable
  from the lane; the lunch-poll placement guard passes; settlement latency
  with ≥3 concurrent session lanes stays within the agreed budget (§4).
- **C3 — cross-space reads** (vector basis, foreign wake via the
  foreign-readers index, ACL-checked foreign point reads, foreign
  authorization generations). Gates: a two-space read chain settles with a
  vector basis and drops the overlay exactly once; a foreign ACL
  revocation while idle revokes the claim; a revocation between the
  foreign read and the home apply settles the attempt unserved.
- **C4 — cross-space writes** (dual leases + the coordinated-commit
  protocol §5 requires as its reviewed entry prerequisite) — explicitly
  last; may be re-scoped after C3 experience.

## 8. Open questions

1. **User-lane authority at zero sessions:** session-anchored (v1-simple,
   no new key material, lane sleeps when the user is fully offline) vs
   standing delegated execution keys (offline continuation, revocation
   surface, consent UX). Recommendation: ship C1 session-anchored; design
   the delegated key alongside C2 with CFC owners.
2. **Promotion cadence:** narrowing is evidence-driven and immediate
   (unchanged); a new fingerprint's trusted summary is trusted immediately.
   That trust is safe for *authority* solely because the execution firewall
   re-validates every actual address per commit and scope keys are
   host-resolved — a wrong summary wastes work, it cannot leak or
   mis-write. The residual is thrash: context floors are fingerprint-keyed,
   so every code change replays the narrowing cascade (one broad-lane run
   plus per-session firewall rejections and claim churn on a hot
   session-context action). Recommendation: record a per-(pieceId,
   actionId) narrowing *hint* consulted as a starting-lane policy — never
   as authority — to bound the replay.
3. **Session-lane admission control:** per-Worker lane count is bounded by
   connected sessions, but a space with hundreds of sessions needs a lane
   budget (G18 territory). Cheap v1: LRU-park session lanes beyond a cap;
   parked session lanes are correct by construction (client remains
   authoritative for anything unclaimed/unserved).
4. **Does C1 precede or follow the Phase 3 feed?** The feed only needs
   space-lane coverage to start paying; C1 widens it. Recommendation:
   start the feed after C0 measurement confirms coverage on dogfood
   spaces; run C1 in parallel — different subsystems, different owners.
   **C2 is different:** it multiplies per-session commit volume and is
   gated on the feed (§6), so the feed is on C2's critical path, not
   parallel to it.
5. **Lane placement: N lanes in one Worker vs Worker-per-lane-group.**
   One Worker serializes all lanes on one thread (§4) but keeps §6.1's
   one-lease-per-branch/space topology. Worker groups would parallelize
   session lanes at the cost of a per-group lease/fencing design and
   shared-cache loss. The C2 latency gate (§4) decides whether this
   question must be answered before or after first enablement.
6. **Scoped-lane builtin egress relaxation.** §3 excludes builtins with
   cross-session-reachable inputs from scoped-lane claims in v1. The
   candidate relaxation — the lane grant as the consent boundary, so a
   foreign-caused recompute may perform egress under the lane's authority —
   weakens §B.5's confused-deputy protection (another principal's commit
   triggering egress under this session's identity) and requires CFC
   owners to decide it explicitly.
7. **Narrow-to-wide value writes.** Scoped-cell semantics sanction
   narrow-derived value writes into broader cells (handlers, lifts into
   passed-in cells) as *the* data-widening path; §4 excludes such actions
   from scoped-lane claims to avoid competing authoritative broad writers.
   Shrinking that carve-out means evolving scoped-cell semantics (for
   example, mandatory link-widening for lift side writes, keeping value
   widening handler-only — handlers move server-side in Phase 5 anyway).
   That is a decision for the scoped-cell spec's owners, with pattern
   migration cost on the table; this design only requires that whatever
   rule holds is enforceable at the runner output-scoping step.

## 9. Parent-document edits owed by this design

Landing with **C1**: README §5.B.1's reconnect contract changes from "a
complete claim snapshot" to "a complete snapshot of the claims this session
routes" (§2 context-scoped delivery); implementation-plan W2.1's
implemented-status text is amended to record chain-scoped routing
superseding exact-contextKey matching. Landing with **C3**: a new gap-
register row in README §9 for multi-host cross-space execution (this design
covers co-resident spaces only). Until those land, the parent documents
describe Phase 2 behavior, which remains accurate for every deployed
configuration.
