# Server-Primary Execution — Implementation Plan

Companion to [README.md](./README.md). Read the design first; this plan turns
it into reviewable, red-green work orders.

Status: Phases 0–2 are implemented behind the default-off flag. W2.4's product
and deterministic failure gates are locally validated, including the accepted
500-event counterbalanced browser/CPU gate. A deployed flag-off/flag-on drill
remains pending. The
[2026-07-15 interactive-latency investigation](../../history/development/performance/server-execution-interactive-latency-2026-07-15.md)
found large flag-on interactive regressions that the CPU gate cannot see;
Phase 2.5 below turns its findings into work orders and blocks the deployed
drill until its gates pass. Later background, feed, scoped, and handler work
is outlined only. The design's terminal crash quarantine and hard pool
resource caps are later operational hardening (G18), not additional Phase 0–2
work orders.

Baseline assumption: scheduler-v2 from PR #4288 has landed. Build directly on
its facade, commit-gated starts, cancellation semantics, bounded settle,
persisted action state, stable action identity, and read/write indexes. Do not
add compatibility paths for the pre-v2 scheduler.

The first security model trusts protocol-compatible clients to honor server
claims. The server still authenticates every demand and write, enforces normal
ACL/CFC validation, and fences duplicate workers. A later phase makes claim
authority cryptographically enforceable.

Incremental PRs remain dark until both halves of a behavior exist. In
particular, the server must not publish authoritative claims to ordinary
sessions until W2.1 claim-aware routing is deployed, and must not claim async
builtins until W2.3 client passivity is deployed. Earlier WOs exercise those
paths with explicit test capabilities only; they do not create a rollout window
where server and clients knowingly duplicate authoritative work.

---

## 0. How to use this plan

- **One work order (WO) = one PR.** W0.1 may instead be folded into #4288
  before it lands. Split any other WO only at the test boundaries below and
  record the resulting dependency. The implementation branch intentionally
  kept the WO/TDD boundaries as small commits in one stacked PR after the user
  requested the complete authority split in one pass.
- **Red-green is required.** Write the failing behavioral test first, confirm
  that it fails for the intended reason, then implement. The PR description
  includes the headline red and green commands/results.
- **The named seams are mandatory reading.** If symbols move, follow the
  current code and describe the delta; do not create parallel scheduler,
  identity, transaction, or serialization machinery.
- **Flags default off.** Every experimental option is registered in
  docs/development/EXPERIMENTAL_OPTIONS.md in the same change. Flag-off
  behavior is proven by test.
- **Preserve transaction boundaries.** Servability is decided for a whole
  action transaction. Never commit its space-scoped subset on the server and
  send scoped or foreign-space operations back to a client.
- **No anonymous derived writes.** Every server execution lease names the
  authenticated user on whose behalf it runs. The host, not the Worker,
  controls that authority.
- **Use deterministic barriers in timing tests.** Do not use sleeps or polling
  to force worker, lease, claim, commit, or hibernation races.
- **Use Deno Workers for multiple runtimes.** Never construct two Engine or
  runtime realms in one process in a test.
- **Await runtime.settled()** when async builtin writebacks matter.
- **Use a port offset** for every test/dev server; never assume port 8000.
- **Preserve established runtime restrictions.** Raw fetch is unavailable to
  pattern code in SES. Server execution does not expose it.

### 0.1 Definition of done for every WO

1. The touched packages pass their focused tests and deno task check.
2. Every success criterion is mapped to a named test in the PR description.
3. Experimental flag-off parity is demonstrated, when applicable.
4. No new schema-less deep sink, whole-space standing subscription, timer
   polling loop, identity implementation, or direct database mutation exists.
5. New protocol fields and storage schemas have compatibility/fail-open tests.
6. Failure, handoff, and cleanup paths use explicit barriers and are tested.

### 0.2 Terms and reserved names

- **SchedulerExecutionContextKey:** server-derived key for durable scheduler
  metadata: space, user:<principal DID>, or
  session:<principal DID>:<session id>.
- **ExecutionDemand:** authenticated, connection-owned, branch-qualified
  request to keep one or more piece result roots live.
- **ExecutionLease:** host-side, expiring, fenced authority for exactly one
  worker generation in a branch/space. It records onBehalfOf.
- **ActionClaimKey:** action identity available independently to client and
  server: branch, space, piece/action identity, execution context, action kind,
  and implementation/runtime fingerprints.
- **ExecutionClaim:** positive, ephemeral statement that one action is ready
  to be server-primary. It contains an ActionClaimKey, worker lease generation,
  and a monotonic per-action claimGeneration. Every claim issuance gets the
  next value, even within one worker lease; revoke names the currently live
  value and does not mint another.
- **CandidateClaim:** host-local shadow diagnostic saying an action passed
  servability checks. It never transfers client authority.
- **ActionSettlement:** control event for every claimed action attempt,
  including committed, no-op, failed, and unserved outcomes.
- **ActionExecutionProvenance:** transaction metadata containing action
  identity, onBehalfOf, lease/claim generations, causedBy, and inputBasisSeq.
- Runtime experimental option: serverPrimaryExecution, default false.
- Existing scheduler option: persistentSchedulerState, default true; explicitly
  setting it false remains its independent scheduler-state rollback path.
- Protocol capability: server-primary-execution-v1.
- Protocol messages:
  - session.execution.demand.set
  - session.execution.claim.set
  - session.execution.claim.revoke
  - session.execution.settlement

ExecutionClaim and ActionSettlement are server control-plane messages, not
ordinary space documents. Client authority is the default whenever no matching
live claim exists in the authoritative connected claim snapshot. Connection
loss alone does not prove absence. Demand, leases, claims, settlements, and
reconnect snapshots are all branch-qualified.

---

## 1. Dependency graph

    Phase 0:
      W0.1 context keys ──▶ W0.3 writer lookup ──▶ W1.3 servability
      W0.2 output invariant ─────────────────────▶ W0.3, W1.3
      W0.4 input basis/provenance ───────────────▶ W1.3, W2.2
      W0.5 authenticated provider ───────────────▶ W1.1, W1.2
      W0.6 handshake/control protocol ───────────▶ W1.2, W2.1

    Phase 1:
      W1.1 leases/fencing ──▶ W1.2 shared pool
      W1.2 shared pool ─────▶ W1.3 servability/claim readiness
      W1.3 claim readiness ─▶ W1.4 async builtins, W1.5 wake/hibernate

    Phase 2:
      W2.1 client routing/overlay ──▶ W2.2 reconciliation
      W1.4 + W2.1 + W2.2 ──────────▶ W2.3 client builtin passivity
      W2.2 + W2.3 + W1.5 ─────────▶ W2.4 measurement/rollout

    Phase 2.5 (interactive performance hardening; entry: W2.4):
      W2.5 tolerant claim release ──▶ W2.6 demand-shrink scoping
      W2.6 demand-shrink scoping ───▶ W2.8 conflict-storm fix (re-measured)
      W2.7 unservable-diagnostic dedup (independent)
      W2.8 ─────────────────────────▶ W2.10 client-side interactive residual
      W2.5 + W2.6 + W2.7 + W2.8 ────▶ W2.9 interactive latency gates
      W2.9 + W2.10 ─────────────────▶ deployed flag drill (W2.4 remainder)

    Phase 2.6 (servable-surface completeness; R3/R4 → zero):
      W2.11 builtin identity ─────────▶ W2.15 builtin computation descriptors
      W2.12 read-only cert relaxation ▶ W2.13 direct-builder cert path
      W2.11 + W2.13 ──────────────────▶ W2.14 runtime write-empty summaries
      W2.14 + W2.15 + W2.16 ──────────▶ zero-verdict acceptance run

    Later:
      Phase 3 background demand and feed narrowing
      Phase 4 scoped execution with delegated keys
      Phase 5 server-directed handler events and enforced authority

Parallelizable start set after #4288: W0.1, W0.2, W0.4, W0.5, W0.6.

---

## 2. Phase 0 — prerequisites and protocol substrate

### W0.1 — Qualify durable scheduler state by effective execution context

**Priority:** first standalone prerequisite. It may be folded into #4288.
**Status:** implemented in the updated #4288 baseline.

**Problem:** cell facts are partitioned by effective scope key, but scheduler
snapshots, action state, and read/write index ownership are currently keyed by
action without the effective user/session context. Two principals or sessions
can replace each other's scheduler metadata even though their cell values do
not overlap.

**Depends on:** #4288.
**Unblocks:** authoritative writer lookup and every server-primary phase.

**Read first:**

- docs/specs/persistent-scheduler-state.md
- packages/memory/v2/engine.ts scheduler table DDL, observation upsert,
  dirtying, and list/read methods
- packages/runner/src/scheduler/persistent-observation.ts
- packages/runner/src/runner.ts cold-start listing and lifecycle ownership
- packages/runner/src/scheduler/facade.ts synchronous observation application
- packages/runner/src/storage/v2.ts scope resolution and scheduler state calls
- packages/memory/test/v2-scheduler-state-test.ts
- packages/runner/test/reload-rehydration.test.ts

**Steps:**

1. Add execution_context_key to scheduler observation/snapshot/action-state
   ownership and to every read/write index row's owning-action key. Update
   primary keys, conflict clauses, deletes, and indexes together.
2. Add resolved read_scope_key to read-index addresses and write_scope_key to
   write-index addresses. Dirty matching uses the changed revision's effective
   scope key, not only its declared scope class.
3. Derive the key server-side using the shareability lattice `space < user <
   session`, where moving right is narrower:
   - `space` is permitted only when a trusted, transformer/runner-produced
     `CompleteActionScopeSummary` proves the piece/result and every possible
     read, write, materializer envelope, and direct output are same-space and
     space-scoped;
   - `user:<principal>` is permitted only when that complete summary excludes
     PerSession access but includes PerUser access;
   - `session:<principal>:<sessionId>` is the initial key for PerSession,
     incomplete, unknown, or dynamic surfaces.
   Observed absence is never proof of completeness and never promotes a row.
   Within one action fingerprint, runtime evidence may only move toward a
   narrower key; a no-op cannot broaden classification. A newly proven broader
   classification requires a new implementation/runtime fingerprint. Never
   accept a client-provided principal. A protocol-compatible trusted client may
   carry the transformer-produced summary, but it must be bound to the verified
   implementation/runtime fingerprint rather than inferred from one run.
4. Return the shared space row plus only the authenticated caller's applicable
   user/session rows during rehydration. Never return another principal's row.
5. When runtime evidence violates the complete summary, reject that summary,
   fail open by running, and transactionally invalidate only rows that are
   broader than the new floor. A `space`→scoped violation removes the shared
   space row for that fingerprint. A `user`→`session` violation removes that
   principal's user row, not another principal's independent user/session row.
   Never delete an equally narrow unrelated context row.
6. Preserve one shared space row for actions proven to use only same-space
   space-scoped addresses.
7. Migrate the #4288 schema transactionally and idempotently. Preserve active
   snapshot/state/index rows only when their decoded observation is valid and
   provably space-only. Rebuild those rows with space context/effective target
   keys; discard scoped, unknown, malformed, or orphaned active rows so they
   run fresh. Append-only observation/replay history may remain, but active
   state must not point at discarded rows.
8. Update state-inspector output to show execution context and target scope
   keys so failures are diagnosable.

**Success criteria:**

- [x] Red→green headline: Alice and Bob run the same PerUser action; both
      snapshots, action-state rows, read rows, and write rows remain present
      and independently rehydrate.
- [x] Two sessions for one principal retain distinct PerSession metadata.
- [x] Alice's scoped write dirties Alice's matching reader and not Bob's.
- [x] Running or clearing Alice's dirty action does not clear Bob's state.
- [x] A proven space-only action has one shared row that either principal can
      rehydrate.
- [x] A dynamic `space`→`user` or `user`→`session` violation cannot leave a
      broadly adoptable snapshot; the incompatible broader row is removed and
      the next runtime fails open by running.
- [x] Observed space-only behavior without a complete static summary remains
      session-keyed; it cannot promote itself to a shared row.
- [x] Narrowing Alice's user row never removes Bob's independent user/session
      row.
- [x] Existing space-only persistent scheduler tests remain green.
- [x] Query plans still use indexed target lookup at 10k rows.

**Review checklist:** inspect every action-key WHERE, DELETE, UPSERT, and JOIN.
A partial migration is worse than no migration. writerSessionId remains
provenance/echo metadata and is not a substitute for execution_context_key.

---

### W0.2 — Enforce one direct root output binding for computations

**Depends on:** #4288.
**Unblocks:** deterministic action/output discovery and static servability.
**Status:** implemented.

**Decision:** important authored patterns go through the transformer. Do not
build a legacy Pattern JSON migration or retain recursive emitted-output-binding
guessing for computation nodes.

**Read first:**

- Transformer emission for computation/lift nodes
- packages/runner/src/runner.ts `directRootOutputRedirect` and
  `resolveDirectRootOutputRedirect`, which replaced the former recursive
  `firstResolvedOutputRedirect` path for raw builtins, sub-pattern resume, and
  pattern-node identity; contrast plain lift/computed `_resultFor` identity,
  which does not recurse
- Scheduler-v2 action registration and static write diagnostics
- Hand-built runner fixtures that construct serialized Pattern objects,
  including `type: "passthrough"` nodes

**Steps:**

1. Make the transformer emit exactly one direct output binding to the
   computation's root result cell.
2. Validate this invariant when registering/instantiating a computation node
   and fail with an actionable diagnostic if it is violated.
3. Use that binding as the action's primary output. Keep explicit static side
   writes/materializer envelopes as separate write surfaces; do not pick the
   first redirect found by recursively walking the emitted output binding.
4. Simplify computation-specific compatibility code made unreachable by the
   invariant. Do not remove general Cell alias/redirect support.
5. Apply the same runner-boundary invariant to hand-built
   `type: "passthrough"` nodes. They have no transformer emission path: a direct
   root primary binding is accepted; nested or multiple alias bindings are
   fixed in tests or rejected.
6. Fix only the hand-built tests that violate the transformer-produced shape.

**Success criteria:**

- [x] A transformed lift has one direct root binding and registers the expected
      stable action/output identity.
- [x] A malformed hand-built computation with nested or multiple root bindings
      fails at registration with the new diagnostic.
- [x] A compliant passthrough fixture has one direct root binding; nested or
      multiple passthrough aliases fail with the same actionable diagnostic.
- [x] Static side writes still appear as additional write-index entries.
- [x] General Cell redirect and alias tests remain green.
- [x] No corpus migration, historical JSON compatibility path, or recursive
      first-output heuristic remains for computations.

---

### W0.3 — Authoritative writer lookup from scheduler-v2 indexes

**Depends on:** W0.1, W0.2.
**Unblocks:** demand discovery and cold wake.
**Status:** implemented.

**Decision:** creation provenance is not current producer identity. Do not add
universal source stamping or walk from a target through its creator. Likewise,
`actualChangedWrites` is downstream invalidation evidence, not a producer
surface; producer lookup uses declared, current-known, and materializer rows.

**Read first:**

- scheduler_write_index DDL and population in packages/memory/v2/engine.ts
- scheduler_action_state and scheduler snapshots
- Scheduler-v2 static writes and materializer envelope indexing
- Current path-overlap logic used for reads/writes

**Steps:**

1. Add a named indexed query writersForTargets(branch, space, addresses).
   Return all candidate writers, not an arbitrary winner.
2. Match exact documents and the same path-overlap semantics used by scheduler
   invalidation. Include the effective read/write scope key and action
   execution_context_key in matches.
3. Join candidates to scheduler_action_state/snapshot so the pool receives
   piece id, stable action id, kind, implementation/runtime fingerprints,
   static/dynamic provenance, and last status.
   Load executable code only through the piece root's durable patternIdentity;
   do not synthesize a code identity from a target cell.
4. Combine durable observation-backed rows with the live scheduler's
   registration-time static surface when a Worker is already present. Do not
   manufacture a clean durable observation merely to index a never-run action.
   After instantiating a demanded piece, its live or live+durable registrations
   supersede durable-only rows for that same piece: those rows may name actions
   from a previous pattern identity. Preserve durable-only candidates owned by
   other pieces so redirected targets still resolve to their real owner.
5. Replace an action's dynamic write rows on re-observation; never accumulate
   stale targets.
6. On an index miss, fail open to piece-root instantiation and discovery. Do
   not infer producer from the target document's creator.

**Success criteria:**

- [x] A direct result target returns its producing action from the durable row
      after observation and from the live static surface before first run.
- [x] A side-write target and materializer target return the correct action.
- [x] A pattern update retains the stable piece root, rotates action identity,
      and excludes the previous pattern's durable-only action after the current
      graph is instantiated.
- [x] A pre-existing target redirected from a computation returns the current
      writer even though its creator is unrelated.
- [x] Multiple candidate writers are all returned deterministically.
- [x] PerUser/PerSession target lookups never return another context's writer.
- [x] Re-observation with a smaller write set removes obsolete lookup results.
- [x] A 10k-row query uses the intended index and meets the existing scheduler
      index performance budget.

---

### W0.4 — Exact input basis and execution provenance

**Depends on:** #4288.
**Unblocks:** claim settlement and overlay reconciliation.
**Status:** implemented. Each action attempt carries an exact transient claim
assertion, and W1.1 has replaced the generation-only session binding with the
durable fenced lease. W1.3 owns cross-space rejection and unserved-attempt
production.

**Problem:** the accepting commit/head sequence is not proof of which inputs an
action consumed. A no-op action also produces no ordinary commit to acknowledge
that it settled.

**Read first:**

- packages/runner/src/scheduler/run.ts read tracking, transaction open,
  no-op elision, and observation construction
- Scheduler-v2 commit gates and bounded settle
- Memory-v2 revision sequence assignment and feed ordering
- Event dispatch transaction provenance

**Steps:**

1. Track the revision sequence actually observed for every effective read. An
   effective read here means a same-space confirmed read precondition accepted
   by the engine, plus a pending read translated from local sequence to its
   accepted global sequence. Reads excluded from the canonical conflict set do
   not enter the basis. For
   this same-space phase, inputBasisSeq is the maximum consumed same-space
   revision sequence, or zero for no durable reads. Do not substitute current
   head or accepting commit seq.
2. Define ActionExecutionProvenance with:
   - ActionClaimKey;
   - onBehalfOf user DID;
   - execution lease generation;
   - claimGeneration when the action is claimed;
   - causedBy source commit sequence(s), as a sorted unique list when directly
     known and an empty list otherwise (never substitute head or input basis);
   - inputBasisSeq.
3. The host derives onBehalfOf from the authenticated sponsor lease and
   overwrites/rejects any worker- or client-supplied value. It means
   server-executed on behalf of this user, not semantic authorship of every
   input.
4. Capture a transient `executionClaimAssertion` when the action attempt starts:
   effective context key, leaseGeneration, and claimGeneration. The remaining
   ActionClaimKey fields come from that same observation. A host-bound executor
   must match the exact live incarnation; revoke/reclaim, expiry, connection or
   session-token replacement, and effective-context mismatch reject the whole
   attempt rather than relabeling or downgrading it. Strip the assertion from
   accepted scheduler-state persistence, but retain it in the raw request's
   replay/original-commit identity. An exact accepted replay remains idempotent
   after revoke. Once a session is bound as an executor, require exactly one
   live claimed-action incarnation for every first-application semantic
   transaction; assertion-free writes must fail atomically rather than
   downgrading to the ordinary user path. Observation-only metadata remains
   non-semantic.
5. Carry provenance through the normal validated transaction path and store it
   with scheduler observation/commit diagnostics.
6. Separate acceptedCommitSeq from inputBasisSeq in types and tests.
7. Add ActionSettlement emission for committed, no-op, failed, and unserved
   attempts. Settlement names the exact leaseGeneration + claimGeneration and
   inputBasisSeq. A committed settlement must carry acceptedCommitSeq; no-op
   has no data commit. Emit either only after the normal confirmed-read
   validation accepts the corresponding data or observation-only transaction.
8. Co-order data patches and settlements on the session feed. A client may
   apply a committed settlement only after its confirmed/feed cursor reaches
   acceptedCommitSeq. No-op settlement follows the accepted observation-only
   transaction in that ordered stream.
9. Do not add persistent scheduler observations for handler runs in this phase.
   Handlers remain client-authoritative, their read sets do not participate in
   server-primary wake indexes, and existing event/source commit provenance
   remains unchanged. Phase 5 owns any handler-observation contract; handler
   semantic authorship remains the authenticated event sender.

**Success criteria:**

- [x] An action reading an old revision while unrelated newer commits exist
      records the old consumed basis, not head.
- [x] Two consumed inputs at S1 and S2 record max(S1,S2); pending local reads
      contribute their accepted global sequence and no durable reads yield zero.
- [x] A no-op claimed action emits a settlement with its real basis despite
      producing no data commit.
- [x] A committed settlement cannot clear an overlay before the client has
      applied the acceptedCommitSeq data patch, including forced reordering.
- [x] Commit seq and input basis are independently asserted and cannot be
      accidentally interchanged by type/API.
- [x] The store/control event records the sponsor user as onBehalfOf.
- [x] A forged onBehalfOf from worker IPC or a client is rejected/overwritten.
- [x] A delayed attempt cannot be relabeled onto a replacement
      claimGeneration or downgraded after revoke; exact accepted replays remain
      idempotent and a changed assertion replay-mismatches.
- [x] A bound executor cannot submit an assertion-free semantic write; the
      lease transaction rejects it atomically while an exact accepted replay
      still succeeds after revoke.
- [x] Executor authority is bound to the exact live connection, session token,
      and principal, and an effective context narrower than the claim rolls the
      whole transaction back.
- [x] Replay fan-out reloads the canonical accepted basis/provenance rather than
      mirroring request-forged host fields.
- [x] Cross-space input attempts are rejected by W1.3 rather than collapsed
      into this scalar.
- [x] Handler execution emits no new scheduler observation in this phase and
      preserves existing authenticated event/source provenance.

---

### W0.5 — Authenticated in-process provider without an Engine bypass

**Depends on:** #4288.
**Unblocks:** leases and executor Workers.

**Status:** implemented, including W1.1's exact opaque lease binding and atomic
first-application fence.

**Decision:** low-overhead server execution may be in-process, but every read
and commit must traverse the same authenticated authorization, conflict, CFC,
provenance, hook, and notification path as a remote client.

**Read first:**

- packages/memory/v2/server.ts session authentication, ACL/CFC validation,
  commit apply, and post-commit notifications
- packages/memory/v2/client.ts loopback transport
- packages/runner/src/storage/v2.ts provider/replica interfaces
- Existing multi-runtime Worker harnesses

**Steps:**

1. Add a host-owned provider adapter against an existing Server. Reuse either
   authenticated loopback or a dedicated internal Server method that shares
   all normal validation; do not call Engine.applyCommit directly.
2. The runtime Worker receives an opaque provider/lease channel over
   MessageChannel. It receives neither a user private key nor raw Engine
   access.
3. Route reads through the authenticated Server read path and commits through
   normal transact validation. Push post-commit invalidations to the Worker;
   do not poll.
4. Bind the provider channel to an exact space, branch, opaque executor
   principal, current ExecutionLease, and fence generation, with atomic
   validation on the canonical commit path.
5. Preserve remote and in-process behavioral equivalence with a differential
   fixture, including scheduler observations and rejected commits. Compare
   exact user operations/data, then normalize legitimate session ids,
   sequences, and transport metadata before comparing scheduler semantics.
   The fixture includes lease generation and host-derived provenance
   assertions.
6. Ensure provider disposal unregisters callbacks and cannot outlive its lease.

**Success criteria:**

- [x] Differential fixture produces identical user operations/data and
      normalized-equivalent scheduler semantics through remote/loopback and
      host-provider paths; expected session/transport differences are asserted
      explicitly.
- [x] ACL denial, CFC denial, and conflict produce the same atomic rejection
      shape with no partial apply.
- [x] A revoked/fenced lease produces the same atomic rejection shape with no
      partial apply.
- [x] An ordinary client commit invalidates and re-settles the Worker without a
      watch/poll loop.
- [x] Worker-controller termination plus channel disposal releases callbacks
      and pending requests, including host-first disposal during an in-flight
      read.
- [x] A test guard proves no provider path calls Engine.applyCommit directly.

---

### W0.6 — Trusted-client handshake, demand, claim, and settlement protocol

**Depends on:** #4288.
**Unblocks:** client-driven pool and client authority split.

**Status:** implemented. The base protocol, demand feed, authoritative
computation routing, and builtin passivity are all gated together by
`serverPrimaryExecution`; when it is on, every session must advertise the main
capability and both graduated sub-capabilities.

**Read first:**

- docs/specs/memory-v2/04-protocol.md
- Memory-v2 session handshake/version negotiation
- Current piece watch/pull registration and session control ordering
- docs/development/EXPERIMENTAL_OPTIONS.md

**Steps:**

1. Add capability negotiation for server-primary-execution-v1. When a
   deployment enables server-primary semantics, reject clients that do not
   advertise the capability; do not silently mix stale authority rules.
2. Add session.execution.demand.set. A demand is bound to the authenticated
   connection, branch, space, and piece result roots. Replacement and disconnect
   remove that connection's references automatically. Host listeners receive
   `{space, branch, order, demands}` so the last empty snapshot remains
   actionable. With the global flag on, demand drives graph discovery and
   positive claims for eligible actions.
3. Add branch-qualified claim set/revoke messages containing ActionClaimKey,
   leaseGeneration, monotonic per-ActionClaimKey claimGeneration, and
   server-controlled expiry. Revoke names the live claimGeneration. A later
   claim set uses the next value even if the worker lease generation is
   unchanged. Expiry actively publishes revoke, removes snapshot authority, and
   rejects later settlement.
4. Add settlement messages keyed to the exact branch, leaseGeneration +
   claimGeneration and carrying outcome, inputBasisSeq, diagnostic code, and
   acceptedCommitSeq for `committed` outcomes. The settlement branch must equal
   its claim branch. Other outcomes omit acceptedCommitSeq.
5. Define ordering: claim set is observed before a client may suppress a
   matching action on that branch; revoke is fail-open while connected;
   settlements cannot apply to another branch or a newer claim generation.
   Carry branch-qualified claim snapshots, claim revokes, commit patches, and
   every settlement outcome on one ordered reconnectable stream with explicit
   feed-sequence barriers. For committed outcomes,
   acceptedCommitSeq is an additional data-application gate, not a replacement
   for control ordering. Bound each session's retained event suffix; reconnect
   always carries a complete claim snapshot plus one coalesced successful
   settlement frontier per exact live claim. The frontier records the maximum
   covered input basis, newest successful feed sequence, and maximum committed
   data gate newer than the acknowledged cursor. This lets cursors older than
   the suffix resynchronize authority and overlay settlement without unbounded
   server memory or duplicate retained-success delivery.
6. Authorize demand using the session's existing READ access. Sponsor
   eligibility is a separate WRITE check in W1.1.
7. Use `serverPrimaryExecution`, default off, as the only rollout authority
   switch. With it off, start no execution pool and preserve client-primary
   behavior. With it on, automatically claim every eligible action in every
   active compatible space. Do not add a per-space authority document or CLI;
   claims, actor identity, heartbeat, exception lists, and epochs remain
   server control-plane state rather than mutable user data.
8. Gate all messages behind serverPrimaryExecution. Negotiate
   absent-false `serverPrimaryExecutionClaimRoutingV1` and
   `serverPrimaryExecutionBuiltinPassivityV1` sub-capabilities. Implemented
   builds advertise both with the main flag; a server with the flag on rejects
   stale peers missing either graduated promise.

**Success criteria:**

- [x] Compatible client negotiates and round-trips demand/claim/settlement.
- [x] Incompatible/stale client is explicitly rejected when the feature is
      required and works unchanged when it is not.
- [x] Two connections demanding the same root produce two references; closing
      one leaves the other live; closing both removes demand.
- [x] The same piece/action on two branches retains independent demand, claims,
      revokes, snapshots, and settlements. W2.1 consumes this exact branch key
      for overlay routing; no cross-branch control state is exposed.
- [x] Spoofed connection id, principal, claim, or settlement is rejected.
- [x] Revoke/re-claim within one lease gets a new claimGeneration, and a
      reordered old-generation settlement cannot clear the new claim.
- [x] Expiry or claim replacement publishes revoke, removes live/snapshot
      authority, and rejects stale settlement.
- [x] A committed settlement delivered before its data frame is buffered until
      the acceptedCommitSeq patch is applied.
- [x] Reconnect neither double-delivers retained control events nor replays a
      claim class excluded by the session's current sub-capabilities.
- [x] A successful settlement evicted from the bounded suffix is recovered
      exactly once from the live claim's reconnect frontier; committed
      frontiers still wait for accepted data, and ack/revoke/reclaim prune the
      old frontier.
- [x] Flag off produces no new protocol messages.

---

## 3. Phase 1 — one shadow executor per eligible active space

Phase exit:

- Exactly one fenced worker generation runs for an eligible branch/space; a
  legacy background-owned space is excluded until Phase 3.
- Multiple client demands merge into it without duplicate schedulers.
- The ordinary rollout remains observation-only: zero authoritative claims,
  derived server commits, or external builtin effects are published.
- Test-only negotiated authority proves every derived commit records on behalf
  of which user it ran.
- Only statically and dynamically proven same-space, space-scoped actions are
  reported as CandidateClaim.
- Async builtins pass broker/egress tests only under an explicit test
  capability; client passivity and production claim publication wait for
  Phase 2.

### W1.1 — User-sponsored execution leases and fencing

**Depends on:** W0.5.
**Unblocks:** W1.2.
**Status:** implemented.

**Decision:** the executor is not an anonymous service principal for
client-driven work. One authenticated requesting user sponsors a worker
generation. Background-only work gets its service identity later.

**Steps:**

1. Add a Server/control-plane ExecutionLease record per branch/space with
   monotonic generation, host id, onBehalfOf DID, expiry, and state. Use a
   database-backed compare-and-swap/transactional seam so multiple server
   processes cannot both own the space.
2. Acquire only from an active demand session with WRITE authority. Prefer the
   active principal whose source commit caused a cold wake; otherwise choose
   the oldest eligible demand deterministically.
   If no requester can sponsor, acquire no lease and publish no claim; clients
   remain authoritative.
3. Keep the sponsor sticky for the worker generation. Runtime/StorageManager
   identity is construction-wide; do not switch actor inside a settled graph.
4. The host retains the authenticated grant and exposes only an opaque lease
   channel to the Worker. Every executor commit checks current generation,
   expiry, sponsor authorization, and the global server-execution flag
   immediately before apply.
5. Renew with server time while demand/in-flight work exists. A heartbeat
   document is not a lease and must not be introduced.
6. On sponsor disconnect/revocation, enter a bounded teardown drain and reject
   every new first application immediately (exact accepted replays remain
   idempotent). Revoke the lease, and restart under another eligible requester
   if demand remains. No old/new overlap is allowed. Exact pre-drain attempt
   admission may recover an already-started-work allowance later.
7. Provenance records onBehalfOf and worker generation. Future user-delegated
   keys can replace the session-derived lease without changing that semantic.

**Success criteria:**

- [x] One requester yields one valid lease and commits marked onBehalfOf that
      user.
- [x] Two hosts racing acquire produce one winner; loser cannot commit.
- [x] A delayed commit from generation N is rejected after generation N+1
      begins.
- [x] Sponsor loses WRITE or disconnects: in-flight boundary is deterministic,
      old Worker is fenced, and remaining demand restarts under another user.
- [x] A READ-only requester can demand data but cannot sponsor writes.
- [x] With only READ-only demand, no worker claim appears and current client
      behavior continues unchanged.
- [x] No user private key enters Worker memory or IPC.

---

### W1.2 — Shared demand pool: one Worker per eligible active branch/space

**Depends on:** W0.6, W1.1, W0.1.
**Unblocks:** W1.3.
**Status:** implemented. V1 fences and revokes failed generations, then retries
with capped exponential backoff. Terminal quarantine/manual un-quarantine and
hard pool-wide resource caps are later operational hardening (G18), not W1.2
success criteria.

**Decision:** never start one runtime per client. Worker cardinality, demand,
and signing authority are separate.

**Read first:**

- packages/background-piece-service worker-controller/IPC for lifecycle
  patterns only; do not make its registry the primary discovery path
- Scheduler-v2 demand/pull and bounded settle APIs
- Cell.pull and piece result-root instantiation
- Persistent scheduler cold-start listing through packages/runner/src/runner.ts
  and observation application through packages/runner/src/scheduler/facade.ts

**Steps:**

1. Install the delta-only demand listener before the memory host accepts client
   connections, then add a host pool
   `Map<BranchSpaceKey, SpaceExecutionSlot>`. Union every connection's
   ExecutionDemand into the slot; acquire one lease and launch one Worker for
   the union.
2. Construct one runtime with persistentSchedulerState enabled and the
   authenticated host provider. Rehydrate the applicable space/user/session
   scheduler rows for its sponsor context.
   From the first pull until an exact action is claim-ready, apply computation
   results only to the Worker's private replica for graph discovery, reject
   every upstream derived commit, and deny all external builtin broker calls.
   This is a transient pre-claim state, not an operator-selected mode.
   Source/handler work is not injected into this runtime.
3. Register post-commit buffering before initial load. Worker reports live at
   seq S; release buffered notifications after S so spawn has no gap.
4. Demand exact piece result roots with pull-per-wake. Do not install a
   schema-less standing sink. Scheduler-v2 deduplicates overlapping client
   demand inside this single scheduler.
5. Demand changes update the union without restarting unless sponsor context
   must rotate. Empty demand begins bounded drain/hibernate.
6. Isolate Worker crashes, back off, and discard CandidateClaims before retry.
7. Add a mandatory legacy-background exclusion interlock without refactoring
   its registry. Before constructing a Worker, background-piece-service
   acquires a durable service-owned exclusion; the client-demand pool cannot
   acquire its lease until that Worker stops and releases the exclusion. A
   dormant registry entry does not block the pool because it has no competing
   runtime. Existing background behavior continues. Phase 3 imports that
   demand into the shared slot and removes the exclusion. Exclusion acquire and
   renew responses carry the server clock sampled with the authority
   transaction. Convert the remaining duration to a request-start-anchored
   monotonic deadline in the background manager; missing timing data from an
   older host fails closed. When the memory host owns the conflicting client
   lease, it immediately revokes that lease's claims and broker authority,
   synchronously waits for the shared pool's abrupt Worker stop and lease
   release, and only then reports the background exclusion ready. A lease owned
   by another host retains its originally advertised expiry: background stays
   blocked through that deadline because shortening it in durable storage
   cannot notify or fence the remote holder safely.

**Success criteria:**

- [x] Ten clients demanding the same piece produce one Worker, one scheduler
      action run per invalidation, and ten reference-counted demands.
- [x] Disjoint roots from two clients run in the same space Worker and only
      demanded closures stay live.
- [x] Closing one client does not remove another's demand; closing the last
      drains and terminates.
- [x] Commit during spawn buffering is observed without a second wake.
- [x] Worker crash discards CandidateClaims (and revokes any test-only claims)
      before restart and leaves other spaces unaffected.
- [x] An unrelated document write causes zero pulls/action runs.
- [x] Every ordinary shadow pull produces zero server data operations and zero
      external builtin calls while still collecting local graph observations.
- [x] Concurrent active legacy background execution plus client demand starts
      no second server Worker and publishes no server-primary claim. The
      false→true handoff regression additionally holds the first Worker stop
      open and proves background readiness remains pending, claims and broker
      egress are already fenced, and demand resumes only after exclusion
      release (`executor-legacy-background-transition.test.ts`).

---

### W1.3 — Whole-action servability, firewall, and claim readiness

**Depends on:** W0.2, W0.3, W0.4, W1.2.
**Unblocks:** Phase 2 and async serving.

**Status:** implemented. Ordinary demand-driven Workers remain shadow-only and
emit host-visible eligibility diagnostics. The explicit test capability proves
the complete path from writer discovery through exact claim installation,
sponsor-attributed execution, commit/no-op settlement, and canonical unserved
revocation. The commit-time memory firewall revalidates trusted static scope,
observed runtime scope, ACL, and CFC before applying any claimed transaction.

**Decision:** client authority is the default. The server positively claims
only an action it can serve. Clients need not predict unsupported actions.

**Steps:**

1. Discover all writer actions for demanded targets with writersForTargets.
   Instantiate the piece root on a safe index miss.
2. Static preflight rejects candidates with any known foreign-space,
   PerUser/PerSession, handler/UI-binding, unknown dynamic effect, or malformed
   output surface. Pure computations with direct root/static write surfaces may
   proceed to staged execution.
3. Stage the entire action transaction. Inspect effective reads and writes
   before apply. The Server transaction firewall accepts only:
   - owner/read/write space equals the served space;
   - every effective scope key is space;
   - every write belongs to the candidate action transaction;
   - normal ACL/CFC validation succeeds.
4. If any operation fails the firewall, discard the entire transaction,
   record an unserved CandidateClaim diagnostic, and never split it. Under the
   explicit authority test capability, emit unserved settlement and
   leave/revoke the claim.
5. For a first pure run, inspect the staged transaction and record a
   CandidateClaim. Under the explicit test-only routing capability, install a
   real claim and commit/retry that same action under the fenced lease. A
   concurrent identical client write may make it a no-op; settlement still
   acknowledges it.
6. Claims are action-granular and ActionClaimKey/leaseGeneration/
   claimGeneration-specific.
   A piece may contain both claimed and client-primary actions.
7. Re-evaluate the firewall every run. A dynamically unservable claimed action
   atomically aborts, revokes, and tells clients to mark it dirty and resume
   committing the whole action.
8. Multiple writer candidates are independently claimed. Suppression requires
   a matching claim for the action producing that transaction.
9. Until W2.1 is deployed and negotiated, run this machinery only in
   validation/shadow mode: inspect eligibility and record CandidateClaim
   diagnostics, but publish no authoritative claim and perform no
   server-primary commit. The explicit test capability is never advertised to
   ordinary sessions.

**Success criteria:**

- [x] Same-space pure computation becomes claim-ready during pre-claim discovery
      with zero server data commits.
- [x] The explicit test capability claims that computation and commits
      server-derived output under its sponsor.
- [x] Mixed space+user writes abort as one transaction; zero operations apply;
      claim is absent/revoked; client execution commits the complete result.
- [x] Cross-space read or write aborts before apply and remains client-primary.
- [x] Dynamic scope change after a claim revokes it and converges via client
      rerun without data loss.
- [x] First-run index miss safely instantiates/discovers the piece.
- [x] A pull demand's stable piece root loads its current `patternIdentity`;
      stale same-piece action metadata neither selects the root nor survives as
      an executable candidate after an action-id-changing pattern update.
- [x] Pre-existing redirected output is served through writer-index identity,
      not creation source.
- [x] No-op produces settlement and leaves no stuck overlay prerequisite.
- [x] CFC/ACL denial is not converted into servability or a trusted shortcut.

---

### W1.4 — Server async builtins and egress policy

**Depends on:** W1.3.
**Unblocks:** W2.3.

**Scope:** fetch-family and generate-family builtins. Full quotas, a durable
async ledger, rigorous idempotency, and delegated execution keys are later
hardening. This WO must not make network reach or duplicate behavior worse than
the client runtime.

**Status:** implemented for the v1 brokered egress boundary. The host derives
causal sponsor matching without sending an actor identity through broker IPC;
permanent actor/policy/servability failures settle the exact claim unserved
with revoke, while transient failures retain it. Cross-user handoff and crash
behavior are covered by deterministic Worker and W2.4 failure drills.

**Steps:**

1. Statically classify supported builtin actions and their known same-space
   output surfaces before claiming. Do not trial-run an external side effect to
   discover servability.
2. Route builtin network operations through a host broker where practical.
   A direct executor implementation is acceptable only if it enforces the same
   tested policy and exposes no raw capability to pattern code.
3. Preserve the SES invariant: raw fetch remains unavailable inside authored
   pattern code.
4. Give the broker the canonical configured serving origin. Resolve relative
   paths against that origin, preserving today's behavior. Thus a relative path
   may intentionally reach the serving host even when local development uses
   localhost/private addresses.
5. Treat absolute and authority-bearing URLs as external. Block loopback,
   link-local, private-network, metadata-service, and disallowed schemes.
   Re-resolve DNS and reapply policy on every redirect hop. A request that
   began relative remains in trusted-serving-origin mode across a same-origin
   redirect even when Location is absolute; any origin change becomes external
   and receives the full policy. For this trusted-client iteration, retain
   browser Fetch header parity across that hop: strip `Authorization`, retain
   other caller-authored headers and 307/308 bodies. An untrusted-client
   sensitive-header denylist/allowlist is later hardening.
6. Route generate-family calls through configured provider policy/credentials;
   never inherit arbitrary client secrets from the demand payload.
7. For identity-sensitive first-party requests, the host compares the
   authenticated accepted-commit origin session with the exact current lease
   sponsor. Only the resulting match boolean enters Worker claim logic; broker
   IPC carries the exact claim but no causal actor identity. A parked wake
   prefers the commit's origin session when acquiring its sponsor. A live
   mismatch or ambiguous origin reaches no broker egress and settles the exact
   claim unserved with revoke; dynamic per-action actors are later work.
8. Claim a builtin before clients become passive. Transient failure remains a
   server-owned pending/retry according to existing builtin semantics;
   permanent policy/servability failure revokes and settles explicitly.
9. Preserve existing cross-runtime mutex/result guards as defense in depth.
10. Keep async claim publication dark until W2.3 builtin passivity is deployed
   and negotiated by every participating client session.

**Success criteria:**

- [x] Relative /api/... reaches the configured serving host in local and
      deployed fixtures.
- [x] A relative request may follow an absolute same-serving-origin redirect;
      an origin-changing redirect is reclassified and blocked when private.
- [x] Cross-origin redirects strip `Authorization`; trusted-client v1 retains
      custom headers and explicitly records later secret-header hardening.
- [x] Absolute localhost/private/metadata URLs are blocked, including DNS and
      redirect rebinding cases.
- [x] Raw fetch remains unavailable in a pattern SES test.
- [x] Supported fetch and generate actions execute once on the claimed server
      path in a multi-client fixture.
- [x] A request caused by user B is never signed/executed as sticky sponsor A:
      a parked wake prefers B as sponsor, while a live sponsor mismatch reaches
      no broker egress and settles the exact claim unserved with revoke.
- [x] Unsupported builtin/action stays client-primary without first causing an
      external request.
- [x] Claim loss/crash behavior is no worse than today's client mutex tests.

---

### W1.5 — Indexed wake, drain, and hibernation

**Depends on:** W0.3, W1.3.
**Unblocks:** efficient rollout.

**Status:** implemented. Each mapped demand lane observes the host accepted-
commit index, coalesces relevant parked wakes above its settle watermark, and
prefers the causal session for cold sponsor acquisition. Aggregate pool and
control metrics are exposed through `SharedExecutionPool.metrics()` and
`/api/health/stats`, with bounded counters for indexed decisions, unrelated
suppression, parked wakes, hibernation, claims, conflicts, settlements, and
fences. A real-Worker drain fixture accepts a source commit after the first
settle, observes the old generation terminate before recomputing it, and proves
the persisted dirty scheduler row is recovered by the replacement generation.

**Steps:**

1. Expose an indexed staleReadersForTargets query qualified by effective target
   scope and execution context. Return distinct demanded actions/pieces.
2. While a Worker is live, push changed target batches and pull only stale
   demanded roots.
3. When the last demand disappears and no async work remains, await
   runtime.settled(), record last-settled seq, release claims, release lease,
   close provider callbacks, and terminate.
4. Keep the mapped lane's accepted-commit subscription live during drain.
   Coalesce indexed-relevant commits above its settle watermark; new demand or
   a relevant commit before final release cancels drain or starts a later
   generation after fencing.
5. Demand itself wakes a cold space. A source commit wakes it only while a
   durable/active demand reference exists; background wake arrives in Phase 3.
6. Emit bounded counters for workers/demands, indexed decisions, wakes,
   suppressed unrelated commits, hibernation, claim churn/conflicts, action
   settlement, and fences, plus worker-start, demand-update, wake, hibernate,
   settle latency, and host-local invalidation-to-settlement latency joined by
   the attempt's durable `causedBy` source sequences. Missing process-local
   start state after restart or bounded eviction omits a sample honestly.

**Success criteria:**

- [x] Relevant write wakes/re-runs only its demanded readers.
- [x] Unrelated write performs one indexed lookup and no Worker/action work.
- [x] Commit in the settle→terminate window is not lost.
- [x] Rapid commits and demands coalesce without duplicate Worker generations.
- [x] Cold resume rehydrates only context-appropriate scheduler rows.

---

## 4. Phase 2 — trusted-client authority split

Phase exit:

- Compatible clients suppress derived commits only for matching live claims.
- Local UI speculation remains immediate.
- Server settlements, including no-op, reliably clear or retain overlays.
- Missing/revoked/mismatched claims fail open to existing client commits.
- Multiple clients perform approximately one server action run per invalidation.

### W2.1 — Claim-aware whole-action routing and speculative overlay

**Depends on:** W0.6, W1.3.

**Status:** implemented with exact synchronous client routing, replica-ordered
claim snapshots, local pending-layer overlays, and bounded remote-feed
speculation coalescing. **Amended by C1.6:** client claim routing is now
chain-scoped — an action routes to the client's own context chain {space,
`user:myDid`, `session:myDid:mySessionId`}, superseding the original
exact-contextKey equality match in steps 2 and 7 (the branch-qualified
ActionClaimKey shape is unchanged; a claim outside the own chain routes
upstream, and two chain-matching claims fail open to neither).

**Steps:**

1. Subscribe to claims through the negotiated session control stream. Store
   them ephemerally by branch-qualified ActionClaimKey + leaseGeneration +
   claimGeneration; do not persist them as space state.
2. At transaction enqueue, derive the shared ActionClaimKey from the client
   action/transaction and match it to a live claim. Do not match on
   ActionExecutionProvenance: onBehalfOf and lease/claim generations are
   trusted server additions that speculative client work does not yet have.
   No exact ActionClaimKey match means commit through the existing path.
3. For a matching computation claim, apply the whole transaction to a local
   per-document overlay and do not enqueue it upstream only when every actual
   operation is same-space and space-scoped.
4. If the client itself observes a scoped/foreign/unknown operation, fail open:
   bypass suppression for the entire transaction and notify diagnostics. Never
   split.
5. Source/setup/UI-binding/handler transactions commit as today.
6. An explicit revoke/expiry/feature-disable received on the live ordered
   stream discards affected overlays, marks the exact registered action dirty
   even when it has no overlay, and gives dormant-between-pulls actions one
   fail-open rerun opportunity before resuming ordinary client commits.
7. Connection loss is not evidence that authority returned: keep claimed
   derived writes local/speculative and do not enqueue them upstream. On
   reconnect, complete capability negotiation and apply an authoritative full
   claim snapshot for the exact branch at a feed-sequence barrier before
   flushing any derived work. Source/handler/UI commits retain their existing
   offline queue behavior.
8. Keep clients trusted in v1: protocol tests pin compliance; CFC/server
   enforcement arrives later.
9. Keep local source/setup/UI invalidations immediate. A remote `integrate`
   that invalidates an exactly claimed computation may wait behind one
   non-sliding 50 ms observation-adoption grace. The scheduler marks dirt and
   CFC trigger causes immediately, `idle()` waits for the bounded fallback,
   and a stalled/missing authority always executes locally at the deadline.
   Retain a successful settlement that arrives before the overlay and apply
   the ordinary input-basis and accepted-data barriers when that overlay is
   later created. This is bounded Phase 2 coalescing, not Phase 3's complete-
   closure cold suppression.

**Success criteria:**

- [x] Claimed pure action produces local UI output but zero derived client wire
      operations.
- [x] Unclaimed action produces byte-identical commits to current behavior.
- [x] Mixed-scope claimed action commits whole from client; no partial
      suppression.
- [x] Two actions in one piece can independently be server- and client-primary.
- [x] Identical action identities on two branches route independently; a claim,
      revoke, reconnect snapshot, or settlement on branch A never affects
      branch B.
- [x] Revocation/expiry causes deterministic dirty rerun and convergence.
- [x] Disconnect while another client keeps the server claim live queues no
      derived wire commit; reconnect claim-snapshot barrier prevents a stale
      flush, replays any missed successful settlement frontier, and then
      converges.
- [x] Flag off has byte-identical commit and control traffic.
- [x] Remote claimed invalidations coalesce behind a fixed leading deadline;
      local commits remain immediate, authority stalls fall open, and an early
      no-op/committed settlement cannot strand the later overlay.

---

### W2.2 — Settlement-driven overlay reconciliation

**Depends on:** W0.4, W2.1.

**Status:** implemented for the v1 direct-read scalar basis, including the
named non-transitive chained-action divergence and convergence fixture.

**Steps:**

1. Overlay generations record the confirmation-assigned sequence of the
   client's own source commit(s) they consumed. Translate local optimistic
   sequence to assigned sequence on confirmation.
2. On matching ActionSettlement:
   - committed with inputBasisSeq at or beyond overlay basis is buffered until
     the local confirmed/feed cursor reaches acceptedCommitSeq, then drops it;
   - no-op with inputBasisSeq at or beyond overlay basis drops it after its
     ordered observation-only settlement arrives;
   - an older basis retains it;
   - failed retains pending only if the claim remains retryable;
   - unserved discards the attempt; the separately ordered claim.revoke control
     message restores client authority.
   Apply reconnect settlement frontiers only after installing their exact live
   claim snapshot. Treat the frontier's maximum committed sequence as the same
   accepted-data barrier, and never apply it to a replacement incarnation.
3. Reject settlements whose leaseGeneration or claimGeneration does not match
   the exact overlay incarnation.
4. When confirmed server value differs from overlay, server wins and increment
   divergence telemetry; do not surface a pattern exception.
5. If the client's source commit is rejected/retried, discard overlay
   generations based on the rejected version and recompute.
6. Treat inputBasisSeq as a direct-read scalar, not transitive lineage. In a
   chain, a stale intermediate plus an unrelated newer input may let a
   downstream settlement pass the source sequence and briefly reveal stale
   confirmed state after overlay drop. V1 accepts, measures, and self-heals
   that window through the intermediate/downstream re-settle; a later causal
   frontier closes it.

**Success criteria:**

- [x] Direct source read at S → local overlay → server settlement basis ≥ S →
      overlay is physically removed only after acceptedCommitSeq is locally
      confirmed; the confirmed value remains.
- [x] Settlement basis < S retains overlay.
- [x] A no-op settlement clears the overlay.
- [x] Two rapid source commits require settlement through the later basis.
- [x] Old generation cannot clear new overlay.
- [x] Delayed/reordered commit data keeps the overlay until the matching data
      frame is applied; settlement-first delivery cannot flash stale state.
- [x] A bounded-feed reconnect cannot strand an overlay after its successful
      settlement was evicted; the snapshot frontier applies exactly once and
      preserves the committed data barrier.
- [x] A chained-action fixture demonstrates the accepted non-transitive basis
      window, records divergence, and deterministically converges after the
      intermediate and downstream actions re-settle.
- [x] Rigged divergence records one event and shows server value.
- [x] Rejected source basis discards and recomputes correctly.

---

### W2.3 — Client builtin passivity per claim

**Depends on:** W1.4, W2.1, W2.2.

**Status:** implemented for the supported fetch/generate builtins with a frozen
per-action sink authority decision and pre-claim in-flight handoff.

**Steps:**

1. A client builtin action becomes passive only for an exact supported live
   claim. It renders pending/result from local overlay and confirmed feed.
2. Missing/revoked claims preserve today's client claim/mutex behavior.
3. Do not use a worker heartbeat as authority. Claim generation and lease-backed
   settlement are the signal.
4. Server transient failure keeps clients passive while the claim is valid;
   permanent failure revokes and releases them.

**Success criteria:**

- [x] Three clients plus one server claim produce one external request per
      supported builtin action.
- [x] Pending→result UI transition arrives through overlay/feed.
- [x] No claim behaves identically to current client builtin execution.
- [x] Permanent revoke releases client work without busy waiting.

---

### W2.4 — Measurement and rollout

**Depends on:** W1.5, W2.2, W2.3.

**Status:** implementation and local validation are complete. The runbook,
bounded-cardinality health/latency signals, product-derived/literal
multi-client fixtures, and deterministic authority/failure drills are present.
The parked-worker claim-readiness
failure is fixed with exact cold-wake, sponsor-preference, settle-watermark,
and replacement coverage. Process-lifetime placement counters distinguish
completed server action runs, classified shadow/authoritative action
transactions, and builtin broker requests, while separate timings identify
client demand publication, Worker start outcomes, and host stale-reader lookup.
The rollout fixture records client and server windows without conflating their
different units. A valid comparison uses two fresh deployments: explicit flag
off, which must have no server pool, and flag on, which must prove
authoritative server transactions and exact successful settlements rather
than merely observing shadow work. Parallel runs require an isolated
Toolshed. The earlier 500-event in-process counterbalanced gate remains useful
historical evidence but must be replaced by this final two-deployment
measurement before rollout.

**Deliverable:** perf fixtures, operational metrics, and a flag-off/flag-on
runbook using only serverPrimaryExecution.

**Measure:**

- active demands, workers, sponsor rotations, and fenced rejects;
- per-action claims/revocations/unserved reasons;
- client scheduler runs and suppressed/upstream derived commits, alongside
  completed server action runs and classified shadow/authoritative action
  transactions;
- derived conflicts and divergence;
- feed/settlement latency and overlays retained;
- async requests by role;
- client demand publication, Worker start outcome, hibernation/wake, and
  accepted-commit stale-reader lookup latency.

**Success criteria:**

- [x] Multi-client product-derived/literal fixtures prove the Phase 2 authority
      split (`server-execution-rollout-products.test.ts`): a directly demanded
      lunch-poll-derived PerSpace `voteCount` scalar gets one shared server
      attempt per invalidation and zero client-derived wire writes across three
      client demands; literal group-chat's nested entity-backed room-name
      projection gets an exact `unserved` settlement and revoke, then converges
      via deterministic three-client fallback with no committed/no-op server
      settlement. The positive lunch case is intentionally not described as
      full-product root behavior: the unchanged full transformed lunch-poll and
      group-chat claim/firewall surfaces are certified separately by
      `server-execution-product-fixtures.test.ts`.
- [x] Pure-computation output and derived-wire-commit counts remain identical
      under flag-off/flag-on runs for unclaimed PerSpace, PerUser, PerSession,
      and cross-space cases (`server-execution-rollout-products.test.ts`).
- [ ] Fresh flag-off and flag-on staging deployments both converge without
      data migration. The off run has no server pool and uses client upstream
      writes; the on run proves authoritative server transactions, successful
      exact-incarnation settlements, and corresponding client suppression.
- [x] Kill/restart/sponsor-loss drills demonstrate fail-open authority and no
      duplicate worker commits (`executor-drain-barrier.test.ts`).
- [ ] Browser compute and lazy-client CPU pass the final fresh-deployment
      flag-off/flag-on gate. The earlier 500-event counterbalanced result is
      retained in the
      [Phase 2 rollout report](../../history/development/performance/server-primary-rollout-2026-07-13.md),
      but its per-space authority phases are no longer the rollout model.
- [x] The browser fixture reports client scheduler runs,
      suppressed/upstream client transactions, completed server action runs,
      classified shadow/authoritative server transactions, server builtin
      requests, and settlement outcomes as separate units. Client speculation,
      unserved transaction attempts, action routing, and settlement coalescing
      are not one-to-one.

---

## 4.5 Phase 2.5 — interactive performance hardening

The
[2026-07-15 interactive-latency investigation](../../history/development/performance/server-execution-interactive-latency-2026-07-15.md)
measured flag-on regressions of +27–81% (default-app note-create,
lunch-poll multi-client) with per-interaction latency growing as the graph
grows, settlements lagging 17–27 s, 124 claimed-action conflicts per 34
accepted attempts, total claim churn (14 issued / 14 revoked per run), ~90
re-attempts of permanently unservable candidates, and one Worker teardown
crash. The shared root: `DenoSpaceExecutor.setDemand` treats every demand
shrink as a whole-lane authority reset, so ordinary navigation rebuilds the
server graph from scratch while racing the client's commits.

These work orders restore the Phase 2 contract — client-perceived latency
must stay at flag-off parity because speculation is untouched — before the
deployed drill. They deliberately do not change protocol shapes, claim
identity, or settlement semantics.

### W2.5 — Tolerate stale executor claim releases

**Depends on:** W2.4. **Status:** implemented.

`DenoSpaceExecutor.#handleClaimRelease` treats a release that does not match
a live claim as lane-fatal. Releases are inherently racy: the Worker posts
`unserved-claim`/`invalidated-claim` asynchronously while the host revokes
claims for its own reasons (demand change, renewal failure, stop). The
observed crash is "executor claim release does not match a live claim"
during ordinary demand removal.

**Deliverable:** a stale release (unknown claim, or mismatched lease/claim
generation) is ignored with a debug diagnostic; an exact match keeps today's
revoke path. No release may crash the lane.

**Success criteria:**

- [x] A queued Worker release arriving after the host already revoked that
      claim leaves the lane live and the pool crash counter unchanged
      (`executor-candidate-claim.test.ts` "a release for a claim the host no
      longer holds is ignored").
- [x] A stale-generation release does not revoke a newer incarnation
      (`executor-candidate-claim.test.ts` "a stale-generation release does
      not revoke a newer incarnation").
- [x] An exact-match release still revokes, unregisters renewal, and reports
      the diagnostic exactly once (same test, final step).

### W2.6 — Scope demand shrink to removed roots

**Depends on:** W2.5. **Status:** implemented.

`setDemand` currently revokes every claim and sends `resetClaims` whenever
any piece leaves the demand set; the Worker then stops every root and clears
all candidate/claim state. Make shrink surgical:

- Host: stop revoking unrelated claims and stop requesting `resetClaims` on
  ordinary shrink. The full-reset path remains for lease replacement and
  explicit reset callers.
- Worker: stopping a removed root already unsubscribes its actions through
  the scheduler facade; hook `unregisterExecutionAction` (the storage-manager
  seam the facade already calls) so an unregistered action holding an exact
  claim posts one `invalidated-claim` release (diagnostic `demand-removed`)
  and drops its candidate-index entries. Still-live pieces keep their claims.
- Claim activation for a candidate whose action died in the shrink window
  must settle as a claim-scoped release (host revokes that claim), not a
  lane-fatal Worker error.

**Success criteria:**

- [x] Shrinking demand from {A, B} to {A} revokes only B's claims; A's
      claims keep their incarnation (no revoke/reissue) across the shrink
      (`executor-claim-e2e.test.ts` "an ordinary demand shrink releases only
      the removed root's claims"; host-side
      `executor-candidate-claim.test.ts` "an ordinary demand shrink leaves
      sibling claims live").
- [x] A claim landing on an action stopped by a concurrent shrink resolves
      as one claim revoke; the lane stays live and no fatal is posted
      (`ClaimedActionGoneError` → exact release, tolerated by W2.5). The
      deterministic fixture for the exact race landed with C1.10
      (`executor-candidate-claim.test.ts` "a claimed activation raced by a
      concurrent shrink settles as one claim revoke without a fatal").
- [x] A navigation-shaped sequence (grow, shrink, regrow) issues new claims
      only for roots that actually left and returned
      (`executor-candidate-claim.test.ts` "demand shrink releases stale
      claims so re-added roots can reclaim").
- [ ] Sub-pieces kept live by another demanded root retain their claims when
      a sibling root is removed. Holds by construction (the release hook
      fires only on scheduler unregistration, which refcounted shared
      children never reach); an explicit shared-child fixture is still owed.

### W2.7 — Report repeat unservable diagnostics once

**Depends on:** none (independent). **Status:** implemented.

`createExecutorActionTransactionRouter` reports an unservable diagnostic on
every rerun of the same unclaimed action. Statically unservable verdicts
cannot change while the implementation and runtime fingerprints are
unchanged; re-reporting is pure host/feed churn (~90 per default-app run).

**Deliverable:** per-action dedup of unclaimed unservable diagnostics keyed
by diagnostic code and fingerprints, mirroring the existing `reported`
candidate dedup. A fingerprint change, claim, or invalidation clears the
entry. Claimed unserved settlements are untouched — they remain canonical
per-attempt outcomes.

**Success criteria:**

- [x] N reruns of one statically unservable action produce one diagnostic
      callback; a fingerprint change produces exactly one more
      (`executor-action-router.test.ts` "executor action router reports a
      repeated unservable verdict once").
- [x] Dynamic unservability (e.g. `dynamic-read-outside-static-surface`)
      re-reports only when the diagnostic code changes, and never suppresses
      canonical unserved settlements for claimed attempts (same test;
      claimed unserved paths are untouched and keep their existing
      `executor-action-router.test.ts` coverage).

### W2.8 — Kill the claimed-action conflict storm

**Depends on:** W2.6 (re-measure first — shrink scoping may shrink this).
**Status:** implemented, with the root cause revised by measurement. The
post-W2.6 re-measurement showed the storm unchanged (114 conflicts / 30
accepted attempts; settlements still 13–23 s late; the 14 claim revocations
were conflict-retry exhaustion, not demand churn). A wake-coalescing window
(the original hypothesis) was implemented, measured, and **rejected**: a
25/100 ms window left conflicts unchanged and made interactive latency worse
(avg 791 ms → 1416 ms), so its default is zero and the injectable mechanism
remains only for future tuning.

Per-conflict evidence capture then identified the real cause: **76 of 90
conflicts were "pending dependency not resolved"** — a claimed action
reading the shadow output of an unclaimed/unservable producer emitted a
pending read naming a shadow commit's localSeq, which never reaches the host
and can never resolve; single localSeqs were retried up to 28 times. The fix
(`rebaseShadowPendingReads`, `packages/runner/src/storage/v2.ts`) rebases
such reads onto the confirmed base beneath the shadow version before an
upstream/unserved transaction leaves the Worker replica — the same
optimistic bet an ordinary stale read carries, still checked by normal
conflict detection.

**Success criteria:**

- [x] Wake-window mechanics are deterministic and capped
      (`selective-demand-wake.test.ts`, deterministic-clock tests; default
      window zero preserves flush-per-push).
- [x] Re-measured default-app run shows claimed-action conflicts reduced to
      near the accepted-attempt count: pending-dependency conflicts 76 → 9
      (the rest name rejected attempts' localSeqs), total 108 → 43 against
      35 accepted attempts, with the remainder ordinary stale-confirmed-read
      races on hot documents; settlement latency avg 20.5 s → 8.8 s.
- [ ] A deterministic replica-level fixture for the shadow-read rebase (a
      claimed consumer of an unservable producer's output) is still owed.
- [ ] Follow-up: rebase reads naming rejected attempts' localSeqs the same
      way (the residual 9), and reduce the stale-confirmed-read retry cost.

### W2.10 — Interactive residual: host main-isolate stalls

**Depends on:** W2.8. **Status:** partially implemented; the remainder is
Phase 3's doc-set feed.

Root cause, established by measurement rather than the original client-side
suspicion: per-note CPU profiles showed the browser runtime Worker ~75%
idle in every note window — the client waits, it does not compute. A 10 Hz
toolshed-responsiveness probe then showed flag-on main-isolate stalls
(p99 1454 ms vs 149 ms flag-off; single graph traversals up to 198 ms;
traverse total 8.6 s vs 0.57 s flag-off). Every client round trip —
including the piece-creation acks behind `viewConditionMs` — queues behind
that. Two flag-on traversal sources: the executor provider's wake path
re-pulled every stale piece's whole closure per accepted-commit wave, and
per-session graph-query refresh runs over roughly doubled commit volume
(server echo commits).

Implemented: the wake path now invalidates live registered actions directly
and re-pulls a closure only for stale readers with no live registration;
rejected commits' localSeqs are treated as host-unresolvable with a pre-send
rebase. Re-probed: toolshed p99 1454 → 744 ms, traverse max 198 → 104 ms,
note-create avg 830 → 673 ms (flag-off 502 ms; the overall flag-on
regression is now ~+34%, from ~+63% before Phase 2.5), settlement latency
avg 22.3 s → 11.0 s.

Remaining: the surviving traverse load (7.2 s vs 0.57 s flag-off) is
per-session graph-query re-evaluation over the doubled commit volume — the
§2.2/§6.4 cost. Closing it belongs to Phase 3's doc-set delta feed, not to
another Phase 2.5 patch. The ~+34% interactive gap is the Phase 2
posture's *current state*, and per the owner's W2.9 budget it is **not a
shippable state** — the feed is on the shipping critical path.

### W2.9 — Interactive latency gates

**Depends on:** W2.5–W2.7 (and W2.8 if implemented). **Status:** planned.

The CPU-ratio gate cannot see interaction latency. Add flag-off/flag-on
latency evidence to the rollout bar. **The budget is ~zero** (owner
decision, 2026-07-15): flag-on must match flag-off within noise; the only
excusable deltas are those demonstrably inherent to the *test setup*
itself in ways that differ from production — and every such exclusion must
be named and justified in the recorded report, not waved through.

- default-app note-create series (fresh-deployment pair, placement guard on):
  flag-on avg/p95 at parity with flag-off per the budget above, and no
  growth trend across the series that flag-off does not show;
- lunch-poll two-browser step timings under the same pairing. Diagnosed
  2026-07-15 in two layers. First: claims stay stable (14 issued, 0
  revoked) but vote-flow commits matched no demanded stale reader (5/182
  index lookups; 434 of 438 notices suppressed), because the tally chains'
  reads were unindexed. Dynamic same-space reads were then admitted to
  servability and the context floor (the C0 step of
  [context-lattice-execution.md](./context-lattice-execution.md)), which
  removes the read-envelope blocker — and exposed the deeper one: the poll
  space's durable rows classify 24 space / 13 user / **226 session**
  context, and only 7 of the 226 read exclusively space-scoped documents.
  The tally chains read PerSession state (per-viewer clocks, UI state), so
  they are correctly session-context and a space lane can never serve them.
  This gate is therefore blocked on context-lattice C2 (session lanes),
  not on a Phase 2.5 fix; it stays as the acceptance gate for C2.
- record results in a dated `docs/history/development/performance/` report
  and update the runbook's rollout-limits section to name these gates.

**Success criteria:**

- [ ] Both fixtures pass their placement guards flag-on.
- [ ] Fresh-pair latency deltas are at parity (~0 budget; any test-setup
      exclusion named and justified) and recorded.
- [ ] The runbook names the latency gates beside the CPU gate.

---

## 4.6 Phase 2.6 — servable-surface completeness (R3/R4 → zero)

The owner ruling (2026-07-15) reclassified register entries R3
(`untrusted-implementation`) and R4 (`incomplete-static-surface`) as defect
classes with target zero. The diagnosis pass (2026-07-15; one instrumented
flag-on default-app run plus two static pipeline maps, recorded in
[the dated report](../../history/development/performance/server-execution-r3-r4-diagnosis-2026-07-15.md))
enumerated the full population: 37 verdicts from 18 distinct offenders
across 7 pieces, produced by exactly two mechanisms.

- **R3 is raw builtins, nothing else.** Every offender is a `map`, `wish`,
  or `ifElse` node. Authored pattern code is fully covered: hoisting +
  `__cfReg` + SES evaluation record provenance, and zero `cf:module/`
  implementations were rejected. Host builtins are registered by canonical
  registry ref and never SES-evaluated, so `getVerifiedProvenance` misses
  them; only `SERVER_EXECUTABLE_BUILTIN_IDS` get the static
  `impl:cf:builtin/<id>:server-v1` stamp
  (`packages/runner/src/runner.ts:5096-5104`). `ifElse` is structural: JSX
  ternaries and `&&`/`||` lower to `ifElse`/`when`/`unless`, so conditional
  rendering guarantees R3 today.
- **R4 is missing transformer certificates on trusted implementations.**
  The certificate (`completeSchedulerScopeSummary`) is emitted at exactly
  two sites, both on the `computed()` path; the gate rejects any param
  that is recursive/wildcard/passthrough/opaque — and `toCapability`
  defaults to opaque for whole-value use. Three offenders are read-only
  computeds tripping opaque/passthrough reads; two are direct module-scope
  `lift()` builders, a form that has **no certificate path at all**; of
  those, `computeIndex` additionally has a genuinely data-dependent write
  surface.

Post-C0, the firewall bounds only **writes** to the static envelope; reads
are admitted dynamically per-address. That reframes the certificate: its
load-bearing content is the write envelope. The work orders below follow
that line. The client never classifies unclaimed actions, so acceptance
runs must observe the executor-side classifier.

### W2.11 — Static identity for every canonical builtin (R3 → 0)

**Depends on:** —. **Status:** implemented (2026-07-15).

Generalize the raw-path stamp (`runner.ts:5096-5104`): a raw module
resolved through the canonical builtin registry ref but outside
`SERVER_EXECUTABLE_BUILTIN_IDS` gets
`implementationHash = cf:builtin/<id>:v1` — a shape deliberately distinct
from `:server-v1` so identity is never conflated with "the server has a
native implementation of this external effect"
(`run.ts:793` keys its effect-descriptor path on the exact `:server-v1`
fingerprint). Identity remains derived only from the canonical registry
ref, never caller-controlled metadata (same trust argument as the existing
subset). The nodes then classify `incomplete-static-surface` until W2.15
supplies descriptors — which is the honest gap (surface, not trust).

**Success criteria:**

- [x] Flag-on default-app run emits zero `untrusted-implementation`
      verdicts (executor-side classifier observed; verified across five
      flag-on runs, 2026-07-15).
- [x] Servability unit tests: `cf:builtin/<id>:v1` candidates pass the
      fingerprint gate and still require a summary; `:server-v1` effect
      semantics untouched.

### W2.12 — Certify read-only computeds despite opaque/passthrough reads (RC-1)

**Depends on:** C0 (landed). **Status:** implemented (2026-07-15); the
runtime-floor test below is the one open follow-up.

`hasCompleteSchedulerScopeSummary`
(`packages/ts-transformers/src/closures/strategies/lift-applied-strategy.ts:156-172`)
rejects opaque/passthrough/wildcard **reads**, but post-C0 only writes are
envelope-bound (`servability.ts:315-329`); reads are admitted dynamically
(`:302-314`) and still feed the runtime context floor. Relax the gate:
certify when every param's `writePaths` is empty (read-only callback),
regardless of read capability. Keep every rejection for callbacks with
writes, and keep the `recursive` rejection (a bailed analysis cannot
trustworthily claim "read-only" — those cases belong to W2.14).

Semantics: `complete: true` then certifies **write-completeness** (plus
the structural CFC sibling reads); document this where the summary is
defined. Soundness rides C0: a session-scoped dynamic read through an
opaque param must still promote the runtime floor — add a runtime test.

**Success criteria:**

- [x] note.tsx `__cfLift_5/12/13` (and the latent `__cfLift_19`) carry
      certificates in `--show-transformed` output; fixtures cover
      truthiness-on-opaque and `??`-passthrough shapes.
- [ ] Runtime floor test: opaque-param session-scoped read still yields a
      session-context rank flag-on.
- [x] Writing callbacks keep today's gate behavior (regression fixtures).

### W2.13 — Certificate path for direct lift()/derive() builders (RC-2)

**Depends on:** W2.12. **Status:** implemented (2026-07-15). Note:
`__cfLift_5` (`?? new Writable()`) turned out to be mechanically this
work order's case, not RC-1 — the no-free-captures form flows through the
direct-builder path.

The direct builder form (`visitInjectedDualSchemaBuilderCall`,
`schema-injection.ts:3466-3569`) injects only the two schemas and never
emits a certificate, regardless of body — every module-scope
`lift()`/`derive()` is R4-incomplete by construction. Run the same
capability analysis on the builder callback and emit through the same
(W2.12-relaxed) gate as `computed()`.

**Success criteria:**

- [x] Direct-lift fixtures certify when their bodies qualify under the
      W2.12 gate.
- [x] `computeIndex` explicitly does **not** certify (fixture asserts the
      absence — its wildcard write surface must keep failing closed).

### W2.14 — Runtime write-empty summaries, fail-closed (RC-3b)

**Depends on:** W2.11, W2.13. **Status:** implemented (2026-07-15),
including the integration fix that folds this run's scheduler-ignored
(framework) reads plus `["cfc"]` sibling reads into the runtime summary —
without it every claimed run rejected `unobserved-read` at the engine's
claimed-commit admission (the certified path covers those reads via its
exhaustive certificate).

For computations with `impl:` fingerprints, no transformer certificate,
and an empty registered write surface, assemble the observation's
`completeActionScopeSummary` at runtime with `writes: []` (reads from the
observed log; C0 admits them). This is fail-closed, not assumed: the
engine firewall rejects any run that ever writes
(`dynamic-write-outside-static-surface`), so a wrong "write-empty" belief
de-claims the action rather than corrupting anything. Covers
`computeMentionable` (recursive, so statically unprovable, but provably
write-free at runtime). Acceptance must show a deliberately-writing action
de-claims cleanly without a conflict storm (reuse the W2.7 dedupe).

**Success criteria:**

- [x] `computeMentionable` is claim-ready flag-on (verified: classified
      claim-ready and settling cleanly, 2026-07-15).
- [x] A test action that writes despite an empty-write summary is rejected
      fail-closed once and falls back to client-primary without repeated
      verdict spam.

### W2.15 — Per-builtin computation descriptors (the R3→R4 cohort)

**Depends on:** W2.11. **Status:** selectors implemented (2026-07-15);
the materializer cohort moved to W2.16.

Mirror the existing effect path — `ServerBuiltinActionDescriptor`
(`packages/runner/src/builtins/server-execution.ts:40-49`) assembled into
a summary at observation time (`run.ts:792-841`, today gated
`actionKind === "effect"` at `:793`) — with a per-builtin **computation**
descriptor registry accepted as an alternative certificate source in the
`run.ts:744-777` computation block. Scope after the owner direction of
2026-07-15:

1. `ifElse`/`when`/`unless` — pure single-output selectors; trivial static
   surface; the cheapest claim-coverage win (structural in every UI).
2. `map`/`filter`/`flatMap` — **moved to W2.16**: their per-element write
   surfaces are envelope-shaped, i.e. they are materializers, and are
   served by the materializer mechanism rather than bespoke static
   descriptors.
3. `wish` — resolver semantics; stays identity-only until its servability
   story is designed. Formerly the phase's one floating deferral; now
   **W2.15b** (below), with a register row (§8 R13) so the exclusion
   stays visible.

### W2.15b — Wish resolver servability (named follow-on)

**Depends on:** W2.11. **Status:** not started — slotted alongside the C2
build waves (owner, 2026-07-17; it shares no seams with the lane WOs, so
it can run in parallel). `wish` measured ×4 in the flagship fixture's
unservable verdicts, so it is a real coverage hole, not a corner.

Design question to pin first: whether the resolver's write surface is
expressible as a trivial output-only descriptor (the W2.15a shape) or
needs envelope treatment (the W2.16 shape) — the resolver contract
decides. Acceptance: flag-on default-app shows zero `wish` unservable
verdicts, or a recorded owner decision that the resolver becomes
client-permanent with its register row updated to say so and why.

**Success criteria:**

- [x] Flag-on default-app: `ifElse`/`when`/`unless` nodes are claim-ready
      (`ifElse` observed claiming and settling in-run; `when`/`unless`
      pinned at the servability level — default-app does not exercise
      them).
- [x] Remaining unservable verdicts name only the materializer cohort
      (until W2.16) and the recorded `wish` deferral (measured: `map` ×9,
      `wish` ×4, `computeIndex` ×1 — exactly the W2.16 cohort).

### W2.16 — Serve the materializer class (envelope-granular write completeness)

**Depends on:** W2.11, W2.13, W2.14. **Status:** implemented (2026-07-15,
both halves). The transformer derives computeIndex's envelopes outright —
no pattern edit: dynamic-descent writes record a bounded envelope prefix
(`writeEnvelopePaths` + a fail-closed `wildcardUnbounded` proof); the
runner gives map/filter/flatMap per-builtin materializer descriptors whose
envelope is a root prefix over the result-container document, and authored
dynamic writers a runtime envelope summary. Registering envelopes indexes
the nodes as materializers, so the executor Worker inherits dirty-at-idle
scheduling structurally.

The scheduler already has this class: **materializers**
(`packages/runner/src/scheduler/materializers.ts`) — actions with side
writes beyond their direct output — run when dirty **at idle priority**
without pull demand (`isIdleMaterializerRunnable`,
`scheduler/work-oracle.ts`), eagerly when their known output is demanded.
The certificate format and both firewall layers already accept
envelope-shaped write bounds
(`completeActionScopeSummary.materializerWriteEnvelopes`; the servability
`covers()` loop, `servability.ts:297-334`;
`schedulerRuntimeWritesExceedSummary`, `packages/memory/v2/engine.ts`).
"Complete" for a materializer therefore means: *this run's writes are
bounded by envelopes derived from this run's resolved inputs* — a
checkable, fail-closed bound that is honest for data-dependent writers.
The earlier "redesign computeIndex" framing conflated exact static
enumeration with envelope completeness; no pattern rewrite is needed.

Work items:

1. **Per-registration envelope derivation.** Envelopes are re-derived from
   resolved inputs each registration — list membership and link-reached
   documents change with data (`computeIndex` writes
   `allPieces[*].backlinks` and, through `mentioned` links,
   *other documents'* `backlinks`). Pin the refresh-before-judgment
   ordering with a test (a run's commit is checked against that run's
   summary); every target stays bounded by the per-address space/scope
   checks regardless.
2. **Certificates for authored materializers.** Certify callbacks whose
   writes are all covered by declared/derived
   `materializerWriteInputPaths` (the existing lift option); `computeIndex`
   declares its two write families if the transformer cannot derive them
   through the wildcard loop.
3. **Builtin materializer descriptors.** `map`/`filter`/`flatMap` via the
   W2.15 descriptor mechanism with the output-collection envelope as the
   write surface; per-element children are already provenance-covered
   hoisted patterns.
4. **Executor scheduling parity.** Claimed materializers must keep the
   client's policy — dirty → idle-priority, demanded output → eager.
   Verify the executor wake path does not eager-run every claimed action
   per invalidation wave; add the policy if missing (background indexing
   must not enter the interactive lane).

**Success criteria:**

- [x] `computeIndex` is claim-ready flag-on (absent from the verdict log;
      envelope enforcement observed live as fail-closed
      `dynamic-write-outside-static-surface` de-claims, ×5 in the
      acceptance run — first-reconcile child instantiation and cross-doc
      writes, both by design).
- [x] `map`/`filter`/`flatMap` nodes are claim-ready (`map` measured
      in-run; `filter`/`flatMap` descriptor-level); per-element children
      unchanged.
- [ ] Executor idle-priority test for claimed materializers (the policy
      holds structurally — materializer indexing drives the Worker's
      shared scheduler — but the explicit Worker-level test is owed with
      the other deterministic fixtures).
- [x] Flag-on default-app run emits **zero** R3/R4 verdicts except the
      recorded `wish` deferral (measured 2026-07-15: `wish` ×4 is the
      entire static-unservable log; settlement avg 528 ms / p95 677 ms).
      Watch item: `claimedActionConflicts` 20 with the enlarged claimed
      cohort (benign overlay races; settlement latency unaffected) — keep
      in view at the W2.9 parity measurement.

---

## 5. Later phases — do not pull into the first implementation

### Phase 3 — background demand and narrower feeds

Client demand is P1. Background registry cleanup is lower priority — and
per the owner (2026-07-15) the legacy background service is not in use, so
steps 1–3 below are deprioritized further: the durable exclusion interlock
stays as a defensive lock, and unification happens opportunistically, not
on the critical path. The feed (step 4) and suppression (step 5) are the
critical-path items: the W2.9 parity budget makes the feed a shipping
prerequisite.

1. Translate existing background registry entries into lower-priority
   ExecutionDemand references in the same pool. Never create a second worker
   for a space already serving clients. Remove the Phase-1 legacy exclusion
   only after a two-source demand test proves one slot/worker.
2. When only background demand remains, sponsor with the background service
   identity and record that identity as onBehalfOf. Client-triggered work must
   never silently switch to it.
3. Remove the old polling loop only after parity tests pass.
4. Narrow watch/query refresh toward declared document interest and server
   control/data events. Preserve ACL isolation and ordered catch-up.
5. Add client-compute suppression to the server-primary posture only after the
   claim snapshot and closure are complete: a client may leave a remotely
   owned action cold until local dependency or handler speculation demands it.
   Measure first-paint and interaction regressions. This later work removes N×
   client compute; the initial authority split removes duplicate writes and
   external effects, not local speculative computation.

#### Feed work-order decomposition (2026-07-16)

Steps 4–5 mapped against the code. Today's cost has **two** surviving
traversal sources: per-session `refreshTrackedGraph` re-runs full
schema/link traversal per commit wave (`server.ts` refresh loop →
`query.ts` traverser), and the executor Worker's own
`refreshAcceptedCommits` re-runs `graphQuery` per affected watch per wave
(`v2-host-provider.ts` — W2.10 only moved live-action wake to direct
invalidation). The feed replaces traversal with (branch, id, resolved
scopeKey) doc-set membership plus per-wave point reads; closure comes from
served-action observations or exact client-exported closures; **mixed mode
is designed-in** (the `wish` deferral and R1/R2/R7 classes have no server
closure source). Critical path (amended by adversarial review, 2026-07-16 — verdicts in
[the archived review](../../history/development/design/feed-adversarial-review-2026-07-16.md),
amendments FA1–FA16 binding): F1 residuals (FA12) → **C1.5b → F2**
(order flipped; F2 owns the shared revision-matching contract, FA6) →
F3 → F4 (+F4b boot-root demotion, FA3) → F5 (the W2.9 parity gate);
F6 before C2 (dependency on the C1.7 cohort predicate resolved per FA9);
F7 gains a mechanical pull-in trigger (FA11) and make-before-break (FA10).

| WO | Title | Depends on | Acceptance sketch |
| --- | --- | --- | --- |
| F1 | Feed observability (landed `c6893f0bd`; coverage report `5a386c691`). Residuals per FA12: archive a fresh flag-off/flag-on attribution baseline pair the F5 gate compares against; publish the per-source decomposition and re-scope if the two named sources do not dominate; per-space keying + wall-clock attribution (or record the owner decision against it). FA13: per-session residual-graph-watch count + fully-doc-set gauge | — | baseline pair archived; attribution per-source recorded |
| F2 | **Landed.** Executor Worker replica: revision-driven point reads replace per-wave graph-query refresh, via the new `docs.read` wire read (exact engine reads, no traversal; F1-attributed under its own operation). FA5 satisfied: interest set = the instance-keyed per-watch entity maps (C1.5b re-keying; absent-but-tracked docs are held as null-document snapshots); one point-read batch per acting lane at the wave's max dataSeq; deliveries flow through the existing WatchView/SessionSync pipeline (steady frames are exact deltas; observation-after-data same-turn ordering and appliedSeq semantics preserved). Shrink policy: any held doc's link-topology change (growth to a target the owning watch does not hold, or any target removal/deletion of a linking doc) routes that watch through the cold graph refresh, whose before/after diff carries the removes — so the interest set equals the last traversal's closure between topology changes (leave-the-closure fixture pinned; F3 adds server-side membership deltas so removes stop requiring a traversal). FA6 satisfied: resolved-scopeKey revision matching with declared-scope fallback on classification AND on read results; `actingContext` on `docs.read` from day one; scopeKey forwarded through syncUpsert, WatchView.applySync (instance-keyed), and — new — SessionSyncRemove. Residual: a schema-position move of a link already present in both versions stays steady and defers the newly-selected target to the demand read path (documented at the topology gate) | **C1.5b** (semantic dependency — landed first) | met: steady-state waves (executor-provider-point-reads suite) run zero graph queries with ≤ revisions point reads; cold pulls, closure growth, linked-doc deletion, and leave-the-closure still traverse; no unwatched point reads (reads issue only for held instances) |
| F3 | Doc-set watch kind: additive WatchSpec, absent-false subcapability, server membership fan-out, ordered delivery. Binding FA1 (the watermark invariant: toSeq advances only when the COMPLETE watch surface — members as of N, served write surfaces, residual graph closures — is proven current through N; one emission point per session per wave), FA2 (membership keyed by RESOLVED scopeKey at registration under the session/lane context; raw scopeKeys on the wire are a protocol error; pre-F6 scoped deltas are per-session point reads or stay on the graph path), FA8 (server-side refcounted shrink; never SessionSync.removes), FA14 (preserved-contract checklist: dirtyOrigins echo suppression, trackedIds union, feed-frame atomicity), FA15 (per-member seq state for resumed catch-up) | F1 | membership deltas exact; watermark invariant fixture; scoped-doc pre-F6 rule pinned by test |
| F4 | Client closure export. Binding FA4 (membership derives from the replica DOC SET — every held doc across confirmed and pending/overlay layers including speculative write targets and framework reads, never the filtered reactive log; retraction evicts from the replica in the same step; served-closure pre-push vs pull-on-demand is a CORRECTNESS choice for written-not-read docs), FA8 (client re-export removals), FA15 (reconnect: re-register after catch-up, before replay). Plus F4b per FA3: boot-root demotion — one-shot graph evaluation for cold-boot roots, make-before-break replacement, partition rule, cross-kind dedup (one delivery, one frame, one watermark) | F3 | claimed chain-intermediate fixture; disconnect/reconnect fixture; unlink retraction fixture |
| F5 | Retire per-session graph re-evaluation. Binding FA1 (watermark co-owner), FA3 (per-watch classification + measured residual-traversal budget replaces the binary 'fully doc-set'), FA7 (conflict-liveness: caughtUpLocalSeq release survives retirement, fed by the same stageConflictRefreshDirtyIds staging), FA11 (record the client-side split; if the parity residual attributes to claimed-echo work, F7 enters the critical path), FA13 (dial gates eligibility only; retirement evaluated live per surface, failing open and counted), FA16 (speculative claimed-run under pending local writes fixture) | F2, F3, F4 | **Mechanism landed** (`packages/memory/test/v2-feed-retirement-test.ts`): the refresh loop classifies each touched session and, when the per-space eligibility dial (`serverPrimaryExecutionGraphRetirement`) admits it and the surface is fully doc-set (subcapability negotiated ∧ members present ∧ zero residual graph watches), SKIPS `refreshTrackedGraph` — a note-create SERIES then does zero `session.watch.refresh` traversal (that source was ~94k/run flag-on); a mixed surface fails open and is counted under `refreshResidualGraphWatches` (FA3); one emission per session per wave holds (FA1); the conflicted-commit `caughtUpLocalSeq` release survives for member and non-member conflicts (FA7); counters wired into `/api/health/stats`. **The W2.9 gate itself stays a live measurement** (see F5 measurement protocol below): the flag-on note-create series reaching flag-off parity within noise vs the FA12 archived baseline. FA16's speculative-branch fixture is a runner-side gate item (client still speculates pre-F7) recorded in the protocol |
| F6 | Lane-correct scoped delivery: cohort filtering. Binding FA9: dependency on C1.7 resolved explicitly (either F6 depends on C1.7, or F6 builds sessionsForPrincipal + the single #sessionAcceptsClaim predicate and C1.7 consumes them — one owner, decided at dispatch); carries the declared-scope agree-set checklist (dirty producers, trackedIds builders, session-entity cache keys, echo map, adoption surface) and the per-address scopeKey derivation rule | F3, C1.7 (per FA9 resolution) | another session's session-scoped commit produces zero B-side work; user-scoped revisions reach only that principal's sessions |
| F7 | G17 claimed-cold suppression. Binding FA10 (make-before-break between closure sources: the served contribution survives until the replacement export covers the same docs, or the revoke carries a catch-up barrier seq and the rerun defers until member deltas through it apply) and FA11 (pull-in trigger: enters the critical path if F5's parity residual attributes to claimed-echo client work) | F4, F5 | revoke-concurrent-with-commit fixture: the rerun's basis covers the commit; stays-cold adoption fixture |

Open decision (deferred by measurement, per the standing
measure-before-fixing rule): closure growth under client-exported closures
(F4) — accept the +1 RTT pull-on-demand for never-seen linked docs, or
build §6.4's served-closure pre-push first. F4's fixtures decide;
escalates to the owner only if both options violate the ~zero W2.9 budget.

#### F5 measurement protocol (the W2.9 gate)

The retirement mechanism is pinned deterministically in
`packages/memory/test/v2-feed-retirement-test.ts`; the shipping-critical
acceptance is a wall-time measurement the rollout owner runs — it cannot run
inside the isolated worktree. The gate:

1. **Enable the dial per space** with `setServerPrimaryExecutionGraphRetirementConfig([space])`
   for the default-app space under test (eligibility only — retirement stays a
   live per-surface check). Confirm the client build negotiates
   `serverPrimaryExecutionDocSetWatch` so the space lane runs as a doc-set
   surface (F4b demotion complete).
2. **Run the flag-on / flag-off note-create pair** — the same default-app
   note-create series as the FA12 archived baseline
   (`docs/history/development/performance/server-execution-feed-baseline-2026-07-16.md`,
   the ONLY comparison basis; never the unarchived plan-text numbers). The pass
   bar: flag-on reaches flag-off **parity within noise** (the pre-F5 residual
   was +10.6% avg / +3.8% p50).
3. **Read the F1 counters from `/api/health/stats`** for the flag-on run and
   confirm the mechanism, not just the wall time:
   `serverExecutionFeed.traversalByOperation["session.watch.refresh"]` absent or
   its `dagTraversals` ≈ 0 (that source was ~94k/run flag-on before F5),
   `refreshResidualGraphWatches` ≈ 0 (a non-zero value names a surface that
   failed open — a boot-root that never demoted; investigate before trusting
   the wall time), `refreshFullyDocSetSessions` tracking the touched sessions,
   and `graph.query` still at its F2 floor (~1,566, not regressed by demand
   pulls).
4. **Record the client-side split (FA11)** — `viewConditionMs`,
   `viewIdleWaitMs`, claimed-echo recompute, and adoption-application time.
   Post-W2.16 settlements average ~528 ms inside the ~670 ms note window, so if
   the residual after retirement attributes to **claimed-echo client work**
   rather than server traversal, **F7 (G17 claimed-cold suppression) enters the
   critical path** before the gate is re-attempted (the FA11 pull-in trigger).
5. **FA16 speculative-branch fixture (runner-side).** Because clients still
   speculate until F7, add a claimed `ifElse` whose branch flips under a pending
   local write and assert the speculative run resolves entirely from the replica,
   OR the resulting stall is measured and accepted within the ~zero W2.9 budget.
   This exercises the client speculation path (runner `v2.ts`), which the
   memory-server refresh-loop tests here cannot see; it belongs to the live gate
   run, not the server unit suite.

### Phase 4 — scoped execution and delegated user keys

The draft design is
[context-lattice-execution.md](./context-lattice-execution.md) (2026-07-15,
under review); it extends this phase to session context and sequences
cross-space execution, and its C0 step (dynamic-read admission) is
implemented. Entry requires that design reviewed, covering:

- principal/session-qualified runtime and replica contexts;
- one shared space lane plus per-user and per-session lanes without duplicating
  unscoped computation;
- scope-monotonic read/write rules;
- bounded user-delegated execution keys that survive connection loss
  (per the lattice design's Open question 1, C1 ships session-anchored
  user-lane authority; standing delegated keys are the follow-on
  hardening, not a C1 entry gate — this bullet's requirement transfers to
  that follow-on);
- context-qualified claims, indexes, wake, and cross-space permission changes;
- vector input bases if cross-space actions are admitted.

The W0.1 context-key fix is necessary but not sufficient for this phase.

#### C1 — user lanes: work-order decomposition (2026-07-15)

**Status (2026-07-17): the design §7 C1 acceptance criterion is MET.**
C1.1–C1.9 are implemented and pushed, including three gate-driven
additions: C1.9b (the §4 output-widening pair admitted at the runner
servability seam; lane-instance hydration before claimed runs — the gate
found both) and C1.9c (per-lane serving: lane-keyed candidates and
(action, contextKey) claims, per-lane recompute). The two-principal
PerUser gate is green: user-rank claims for both principals, durably
isolated rows per scope key, zero client derived wire writes, zero
lease-fence rejects (env-gated pending a documented teardown-hygiene
flake; default runs deterministic). C1 bookkeeping is now closed: C1.10
landed the five owed deterministic fixtures (shrink-race, shared-child
byte-identity, rebase-replica, cross-lane pending-read, and the engine-level
lane-write-authority TOCTOU backstop) and C1.11 made the §10 parent-doc edits
(README §B.1 reconnect contract, W2.1 chain-scoped-routing status). Feed
progress alongside: F1 and F2 are landed — F2's measured effect on the
flag-on default-app run: graph.query 171,482 → 1,566 DAG traversals per run;
total traversal work ~270k →
~12.2k (~95% reduction).

Mapped against the code with no external blockers, no feed dependency
(the feed gates C2 only — design §6/§7/OQ4), and no open owner decisions.
Much substrate already landed with W0.1: the engine resolves user/session
execution contexts, floors store user rank, the claim wire schema admits
`user:`/`session:` keys, and the client parses context ranks (correction
from review: only a connection-liveness-blind `hasOpenSessionForPrincipal`
exists today; `sessionsForPrincipal` is built in C1.7). An adversarial
panel (four lenses + code-verifying synthesis; 25/25 findings confirmed,
none refuted) reviewed this table on 2026-07-15 — the **binding
amendments** below the table came out of it; full verdicts in
[the archived review](../../history/development/design/c1-adversarial-review-2026-07-15.md). Two engine guards must not be conflated: the W0.4
guard (`claim.contextKey !== "space"`, engine.ts ~7977 →
`claim-observation-mismatch`, NOT guard-tolerated) must widen first;
`claim-context-mismatch` (~8398) is already the correct effective-context
equality check and simply starts passing.

| WO | Title | Depends on | Acceptance sketch |
| --- | --- | --- | --- |
| C1.1 | Engine accepts user-rank claims (widen the W0.4 space guard; `session:` stays rejected until C2) | — | user claim commits at resolved user context; mismatch still fences `claim-context-mismatch`. Amendments A14, A18, A20 |
| C1.1b | Engine/claim follow-ups from review: issuance-side rank dial (EXPERIMENTAL_OPTIONS entry, default space-only, revoke-on-disable); unify the twin context-equality check (~engine.ts:7471 ProtocolError variant) with the fence cause; canonical `user:<did>` key helpers (colon-safe) used by engine/executor/server/client | C1.1 | dial off ⇒ byte-identical space-only behavior; with-operations mismatch case fences like the observation-only twin. Amendments A9, A14, A18 |
| C1.2 | Firewall: lane-scoped surface validation + broad-instance scope-naming-link check (§4) | C1.1 | user-lane writes to the lane principal's scope pass; other principals/session scopes/broad value writes reject; space lane byte-identical. Amendment A7: the link-shape backstop is specified as a spec-level JSON wire contract with shared conformance fixtures (runner emit + engine accept); capture the real emitted shape first |
| C1.3 | Lane grants keyed (space, branch, user:did), anchored on a live **connected** principal session, host-internal `laneGeneration` | C1.1 | disconnect drains/revokes only that lane; stale generation fences with a new named cause. Amendments A2 (grant + every renewal require the principal's current WRITE capability), A3 (issuance-time routing-disjointness: reject/supersede chain-compatible live claims, revoke-published-before-issue), A12 (issuance binds a live grant + generation, re-validated after every await; drain fences generation before sweeping claims), A13, A17 |
| C1.4 | Acting-context seam on commits — with the four-role split of `ApplyCommitOptions.principal`: sponsor stays bound to the lease fence, replay sessionKey, pending-read resolution, and provenance.onBehalfOf; a NEW actingContext feeds scope resolution, effective-context resolution, and CFC label validation | C1.2, C1.3 | user:alice claim commits as alice; forged assertion from an unbound context rejects with a constant-shape fence cause BEFORE any scoped-state validation (preconditions/reads) runs; one commit (incl. observation batches) asserts exactly one lane; the commit fence also resolves WRITE for the acting principal. Amendments A2, A5, A6 |
| C1.4b | Lane-scoped READ seam (blocker A1): reads/watch/snapshot/writer-lookup from a lease-bound executor session accept a per-request acting context validated against the live lane grant + generation before scope resolution; EntitySnapshot and AcceptedCommitNotice.revisions gain the resolved scopeKey; schedulerApplicableContextKeys derives from open lane grants | C1.3, C1.4 | through one sponsor-bound provider session, a read of alice's user-scoped doc under alice's live grant returns her instance; without a grant it rejects; sync frames attribute per lane |
| C1.5a | Executor candidate rank from the durable floor; **intra-Worker lane identity** (candidate/claim/wake identity maps + CandidateClaim message) gains contextKey — the pool slot key, lease topology, and one-Worker-per-(space, branch) are explicitly unchanged (A22) | C1.1, C1.4b | PerUser observation → user-rank candidate; space regression green; C1 issues user-rank claims for `computation` only (A8 — effects stay space-lane; lane-grant egress per OQ6 is owned by C2.8, a **C2 exit gate** since the 2026-07-17 owner revision, tracked as register row R12) |
| C1.5b | Per-lane acting context; shared Worker replica re-keyed by effective scope key (the §7 intra-Worker confidentiality boundary; largest WO) | C1.4, C1.4b, C1.5a | two principals' PerUser derivations isolated in one Worker; overlays/rebase correct per lane. Amendments A16 (a lane's reads see confirmed state + ONLY its own lane's pending versions; other lanes' localSeqs are unresolvable), A23 (amend both executor-IPC identity-invariant comments: lane identity crosses the channel, raw credentials still do not) |
| C1.6 | Client chain-scoped claim routing — the FULL own chain {space, user:myDid, session:myDid:mySessionId} (A10); no rank comparison; if two chain-matching claims are ever observed: route to neither, fail open, counted (A3) | C1.1, C1.5a (testable with synthetic claims) | own-chain claims → claimed overlay; other-user/session → upstream; space unchanged; the complete client seam list re-keyed by chain key (facade registerExecutionAction, #executionActionsByKey, executionClaimForActionKey, hasLiveExecutionClaimForAction, captureExecutionClaim, revoke-path invalidation) — dormant-action revoke fires exactly one wake (A15); colon-bearing did:key principals end-to-end (A18) |
| C1.7 | Context-scoped delivery + `context-lattice-claims-v1` subcapability + principal-wide cohort gate; builds `sessionsForPrincipal` (connected-session semantics, A17) with the filter inside `#sessionAcceptsClaim` — the single predicate feeding publish, reconnect snapshots, retained events, and settlement frontiers (A21) | C1.3, C1.6 | user claims delivered only to that principal's negotiating sessions; cohort fence lives inside openSession admission (new/resume/takeover) and fences+revokes the lane BEFORE the snapshot is built and the open response sent (A11 — a raw client transacting immediately after open cannot race the drain); B's reconnect snapshot contains none of A's user claims |
| C1.8 | User-lane demand aggregation + lifecycle (open/anchor/re-anchor/drain, mirroring sponsor-loss); **owns widening the accepted-commit wake lookup** — `applicableExecutionContextKeys` derives as [space] + every open lane grant's contextKey, paired per-lane with that principal's demanded pieces (A4); lane-partitioned set-demand wire shape with per-lane generations (A24); aclTouched reconciliation gains the lane step: fence + revoke user lanes whose principal lost WRITE or whose anchor session was removed (A2) | C1.3, C1.5b, C1.7 | barrier-driven lifecycle test; re-anchor bumps laneGeneration without dropped work; a space commit wakes another principal's user-context reader; parked principals accumulate dirt without wake |
| C1.9 | Two-principal PerUser measurement gate + fixture | C1.5b–C1.8 | design §7 C1 gate: isolated rows, zero client derived wire writes, flag-off parity; defines the guard contract for by-design lane-drain fence causes up front (named, counted, R7-style retirement criteria — A13); mid-run WRITE revocation fixture (A2); colon-bearing DIDs end-to-end (A18); records per-lane schedulerRuns so the §4 shadow-recompute cost is measured (A25) |
| C1.10 | Owed deterministic fixtures: shrink-race, shared-child, rebase-replica — plus the cross-lane pending-read case (lane B naming a version created by lane A on a shared broad doc, A5/A16) and the engine-level lane-write-authority TOCTOU backstop (a claimed commit racing the C1.8 ACL reconciliation — wire ordering cannot force the interleaving; the fence closure is injectable at the engine seam) | C1.3, C1.5b, C1.8 | five barrier-driven fixtures green (pre-existing debt riding along) |
| C1.11 | §10 parent-document edits (README §5.B.1 reconnect contract; W2.1 status text) | C1.6, C1.7 | docs describe chain-scoped routing and context-scoped snapshots |

Build note: C1.5a and C1.6 share `servability.ts` seams — one builder,
sequential patches. C1.2 and C1.3 share `engine.ts` — likewise.

Amendment references (A1–A25) are the adversarial-review amendments,
archived in full in
[the review record](../../history/development/design/c1-adversarial-review-2026-07-15.md);
build prompts must carry the full amendment text for their work orders.
Entry-bullet reconciliation (A25): "without duplicating unscoped
computation" means without duplicating unscoped AUTHORITY
(claims/settlements); per-lane shadow recompute is the accepted §4 cost,
bounded by the C2 latency gate and measured at C1.9.

#### C2 — session lanes: work-order decomposition (2026-07-17)

Mapped against the landed C1 substrate, which already carries most of the
hard parts: the client is fully session-ready — `ownChainContextKeys`
includes `session:myDid:mySessionId`, `laneScopeKey` handles session
scope, chain routing is live — so **amendment A10's claims-v2 question
resolves in favor of v1 (no v2 subcapability needed)**; the
routing-disjointness invariant and the delivery flag-gate are already
session-aware, and the executor lane maps are contextKey-generic. What is
new is additive: widen the rank dial and issuance ladder to `session`,
widen the servability/firewall/router lane rank, session-lane grants (the
session is its own anchor; session-end = lane-end, no re-anchor), and
narrow session-claim delivery to the named session.

**The adversarial panel (2026-07-17; verdicts archived in
[the review record](../../history/development/design/c2-adversarial-review-2026-07-17.md),
amendments CA1–CA14 binding) corrected the scout in load-bearing ways —
read them before building:**

- **CA6 (correction to this decomposition's own text):** C2.2 does **NOT**
  "meet the `ifElse` gap." The red lunch-poll/group-chat product-fixtures
  failure is a **rank-independent, space-scoped** map/ifElse write-surface
  defect — `ifElse`'s W2.15 "single-output selector" descriptor is wrong
  for that shape, and the map materializer envelope (W2.16) is the other
  half. The real owner is **re-opened W2.15/W2.16**, not session-rank
  widening. C2.9/C2.10 gain a hard dependency on that write-surface
  completeness (CA10).
- **CA4 (correction to adopted default #1):** claims-**v1 routing** is
  still sufficient, but the session-claim over-broadcast
  (`#sessionAcceptsClaim` delivers a `session:alice:A` claim to alice's
  session B) is **quadratic client compute** — sibling sessions fail-open
  and re-run — not benign "wasted delivery." **C2.6 is load-bearing for
  the project's core redundancy-elimination value, not optional.**
- **CA11 (correction to adopted default #4):** reusing W2.9's parity bar
  alone is structurally blind to the hundreds-of-lanes regime. Split
  C2.10: keep the parity/correctness bar AND add a **separate latency
  acceptance with an owner-set ms budget** — this is a genuine owner
  decision, not a default (open in the session summary).
- **Five unowned/miscited seams promoted to blockers** (the scout said the
  engine guards "auto-pass" — they do not): session issuance-binding
  (`server.ts` `#requiredLaneGrantForClaim` hard-returns null for session),
  admission, and commit-lane fence are all user-hardcoded → **CA1**;
  `scope-naming-link.ts` hardcodes `scope:"user"` and is uncited → **CA2**;
  `laneScopeKey` has no broader-in-chain collapse so a session lane reading
  a user input phantom-mis-keys it → **CA3**; push-side confidentiality of
  server-authored session writes is unowned and the plan↔scout contradict
  on the F6 dependency → **CA5**.
- Serious: session commit-fence WRITE re-check fails open (CA7); C2.4 must
  use the **grant's** session id, not `base.sessionId`, or two Alice
  sessions cross-read (CA8); C2.5 needs a real session identity source,
  never a DID fabrication (CA9); canonical session-key validation (CA12).

**Standing adopted defaults after the panel and the owner review (both
2026-07-17):** default 3 survives as adopted — no lane budget in C2
(OQ3); parked session lanes are correct by construction; the LRU-park
cap is a follow-on, revisited if C2.10's latency gate shows pressure.
Default 2 survives as **build order** — computation-first like C1 (A8):
lane grants, fencing, and drain prove out before egress rides them,
because an external call is the one side effect the per-commit firewall
cannot retro-reject — but its "session-lane builtin egress (OQ6, C2.8)
is a named follow-on, not a C2 gate" clause is **overridden by the owner
(2026-07-17, post-panel): C2.8 is a C2 exit gate, pre-ship** with the
same force as the C3 pre-ship ruling. Rationale: the end state is all
standing reactive work — computations AND effect builtins — server-side,
with only handlers (R1, Phase 5) and render (R2) client-executed; a
follow-on with no phase binding is the permanent-carve-out failure mode
design §1 argues against, and the exclusion had no residual-register row
(§8 gains R12/R13 with this revision). C2.8's scope: session lanes and
user lanes with a connected anchor session (lifting C1's A8
restriction); only *offline* egress under standing delegated keys stays
parked with OQ1, where the consent question genuinely lives. Defaults 1
and 4 are amended above (CA4, CA11).

| WO | Title | Depends on |
| --- | --- | --- |
| C2.1 | Engine + dial admit session-rank claims (ladder + **issuance-binding + admission + commit-lane**, CA1; canonical key validation, CA12) | — |
| C2.2 | Servability + firewall: session-lane surface classification and the §4 pair at session rank (**owns `scope-naming-link.ts` session parameterization, CA2**; does NOT meet the ifElse gap — CA6) | C2.1 |
| C2.3 | Session lane grants — the session is its own anchor; session-end = lane-end; **issuance-binding path, CA1** | C2.1 |
| C2.4 | Session-lane acting-context read seam — **substitutes the grant's session id, not base.sessionId (CA8)** | C2.3 |
| C2.5 | Session-rank executor candidate identity + router widening; **real session identity source, no DID fabrication (CA9); laneScopeKey broader-in-chain collapse, CA3** | C2.2, C2.4 |
| C2.6 | **Load-bearing (CA4):** narrow session-claim delivery to the named session — kills the quadratic sibling-session rerun, not just fan-out | C2.1, C2.3 |
| C2.7 | Session-lane demand aggregation, lifecycle, wake widening; **session lane-write-authority fence re-check (CA7)**; parked-skip is emergent (CA13) | C2.3, C2.5, C2.6 |
| C2.8 | Scoped-lane builtin egress under the lane grant (OQ6): session lanes + user lanes with a connected anchor (lifts A8's computation-only restriction — the engine admission gate that holds it, `isAdmissibleExecutionClaimContextKey` engine.ts:8259 per CA1's citation, plus the three sponsor-keyed gates become lane-conditional: the `deno-space-executor` pre-claim drop, the `executor-worker` egress-guard identity, and `causalActorMatchesSponsor` consultation, applied only when `claimKey.contextKey === "space"`; per-lane broker acting identity; G11 parity per lane). **C2 exit gate, pre-ship** (owner, 2026-07-17); offline egress under standing keys stays with OQ1 | C2.4, C2.5; build sequenced after C2.9–C2.10 so egress never muddies the latency measurement |
| C2.9 | PerSession measurement gate + fixture; **push-side confidentiality fixture (CA5); depends on W2.15/W2.16 write-surface completeness (CA10)** | C2.4–C2.7, W2.15/W2.16 re-work |
| C2.10 | Lunch-poll placement guard: R7 retirement + **split gate — parity bar AND an owner-set latency budget (CA11)** | C2.9 |
| C2.11 | Owed session-lane fixtures (incl. the session lane-write TOCTOU backstop, CA7) + EXPERIMENTAL_OPTIONS/docs | C2.3, C2.6, C2.9 |

Prerequisite: the feed's session-scoped delivery (F6) lands before C2.6/C2.9
(design §6). F1–F4 are landed; F5's retirement mechanism is landed behind the
per-space `serverPrimaryExecutionGraphRetirement` dial (its W2.9 wall-time gate
is a live owner measurement — see the F5 measurement protocol above); F6 in
flight.

### Phase 5 — server-directed handler events and enforced authority

Entry requires trusted-event envelope/replay semantics and CFC integration.
Move handler execution only after events can be sent to the authoritative
execution location with authenticated sender provenance. Then use CFC and
server admission to reject unauthorized client-derived writes rather than
relying on trusted claim compliance.

---

## 6. Review-agent playbook

1. **Start from #4288 surfaces.** Reject pre-v2 scheduler branches, duplicate
   queues, or compatibility facade code.
2. **Map every criterion to a named test and red run.**
3. **Trace identity end to end.** Authenticated demand → sponsor selection →
   lease → Worker provider → normal Server validation → stored onBehalfOf.
4. **Trace exclusivity end to end.** Lease CAS → monotonic worker generation →
   commit fence → distinct monotonic per-action claimGeneration → stale
   settlement rejection.
5. **Trace scope end to end.** Effective scope key in scheduler metadata,
   writer lookup, transaction firewall, client routing, and dirty matching.
6. **Demand proof, not producer guesses.** Writer index is authoritative;
   creation source is irrelevant.
7. **No transaction splitting.** Search specifically for per-operation routing
   of a claimed action and reject it.
8. **No authority docs.** The global rollout flag selects client-primary or
   automatic server-primary execution. Claims, leases, heartbeats, actors, and
   unservable lists do not belong in ordinary writable space state.
9. **No raw Engine shortcut.** In-process commits pass the same ACL, CFC,
   conflict, provenance, fence, and post-commit hooks as remote commits.
10. **No ambient network expansion.** Raw SES fetch stays blocked. Builtins
    enforce relative-serving-origin behavior and external egress restrictions.
11. **No timing sleeps.** Spawn, drain, commit-gate, cancellation, claim, and
    lease tests use barriers/signals.
12. **Fail open deliberately.** Missing index, unsupported scope, live-stream
    revoke/expiry, or incompatible fingerprint returns authority to existing
    client behavior. Disconnect instead freezes derived wire writes until the
    reconnect claim-snapshot barrier; neither path silently drops a transaction.

---

## 7. Decisions fixed by this plan

- #4288 is the scheduler baseline.
- Compatible clients are trusted in the first iteration; incompatible clients
  are rejected when server-primary execution is required.
- One shared worker serves all active client demands in an eligible space;
  legacy background-owned spaces are excluded until their demand is unified.
- A sticky authenticated requester sponsors the worker; derived commits record
  server-executed on behalf of that user.
- A fenced lease, not a heartbeat, prevents duplicate server workers.
- The global serverPrimaryExecution flag is the only rollout switch: off starts
  no pool; on automatically serves every eligible compatible piece. Positive
  per-action claims control action-level authority within the on mode.
- Every claim has a per-action claimGeneration distinct from its worker lease
  generation.
- Client authority is the default for every unclaimed action.
- Initial servability is same-space and space-scoped, enforced on the complete
  transaction with deterministic fallback.
- Scheduler write indexes identify current producers; creation provenance does
  not.
- Computation output has one transformer-produced direct root binding; only
  hand-built tests need adjustment.
- Overlay reconciliation uses the actual consumed input basis and explicit
  settlement, including no-op; committed overlays wait for acceptedCommitSeq
  data before clearing.
- Raw fetch remains blocked in SES. Supported fetch/generate builtins retain
  relative serving-host calls while external absolute URLs follow server
  egress policy.
- Background registry integration follows the client-driven path, not the
  reverse.
