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
  claim posts one `invalidated-claim` release (diagnostic `action-unregistered`; the plan previously said `demand-removed`, a code production never emitted — corrected with FW7)
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
      (`ClaimedActionGoneError` → exact release, tolerated by W2.5).
      **Re-opened and re-closed 2026-07-17 (FB4 → FW7):** the fixture now
      drives the REAL executor-worker seam with the real diagnostic
      (`action-unregistered`) and reds under the guarded bug.
      Historical note: the C1.10 fixture
      (`executor-candidate-claim.test.ts` "a claimed activation raced by a
      concurrent shrink…") drives a FakeWorker and pins a diagnostic code
      (`demand-removed`) production never emits — the Worker's actual
      `ClaimedActionGoneError` → claim-scoped-release path is executed by
      no test in the repo, so the guarded regression (lane-fatal instead
      of release) would ship green. A fixture through the real Worker
      seam is owed to the repair wave.
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
runtime-floor test landed with FW8 (2026-07-17 — a read-only
certificate cannot defeat session-rank floor narrowing, driven through
the real engine; FB30 closed).

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

**Depends on:** W2.12. **Status:** implemented (2026-07-15).
**Defect closed (FB2 → FW8, 2026-07-17):** the gate now checks
capture-freeness (`functionWritesCapturedCells`, fail-closed on unknown
methods over captured cell-like receivers) on the direct-builder path
AND the previously-unconditional no-input lift arm; both review
examples emit no certificate, a read-only-capture control still
certifies, and one previously-unsound fixture expectation was
corrected. Residual (recorded): writes hidden inside imported/cross-file
helper bodies stay outside the checker's open-world boundary — the
run-time write firewall remains the backstop for that class. Note: `__cfLift_5` (`?? new Writable()`) turned out to be
mechanically this work order's case, not RC-1 — the no-free-captures form
flows through the direct-builder path.

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

**Depends on:** W2.11, W2.13. **Status:** implemented (2026-07-15).
**Test-integrity note closed (FB16/FB17 → FW8, 2026-07-17):** the
observation-side arm now constructs its override through
`transactionLog.writes` with an explicit `actualChangedWrites` guard,
and the de-claim test holds a real ExecutionClaim through the claimed
arm; both discriminate (reverting the guarded seams reds them).
Implementation includes the integration fix that folds this run's
scheduler-ignored (framework) reads plus `["cfc"]` sibling reads into
the runtime summary —
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
the materializer cohort moved to W2.16. **Re-opened 2026-07-17 (C2
panel CA6/CA10; root-caused same day by Fable review FB3):** the
"single-output selector" premise is false for ALL THREE selectors, not
just a fixture shape — every `ifElse`/`when`/`unless` run mints and
writes a SECOND document, the `{ ifElse|when|unless: cause }` result
cell (`if-else.ts:57-79`, `when.ts:46`, `unless.ts:46`), whose entity id
differs from the output spot (the spot stores only a link to it), and
the descriptor's envelope never covers it. So every output-producing
selector run — first run and every condition flip — fails the dynamic
firewall `dynamic-write-outside-static-surface` and de-claims (verified
6/6 at tip through the executor-router harness; the checked "observed
claiming and settling in-run" below can only have been no-op re-runs).
The selector cohort's claim-coverage win is currently nominal. Fix
shape: the minted cause is registration-time derivable, so fold it into
the descriptor writes the way W2.16 derives the materializer container
envelope (`listBuiltinResultContainerCause` precedent). The W2.15a tests
assert the too-narrow envelope AS the contract and never exercise the
dynamic firewall (FB18) — repair those with the fix. C2.9/C2.10 gate on
this closure (CA10).

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
- [x] Product fixtures (lunch-poll, group-chat) show zero selector-cohort
      `dynamic-write-outside-static-surface` verdicts, AND a
      firewall-exercising fixture proves a selector's output-producing
      run (cold + condition flip) settles under a claim (**closed by FW8
      2026-07-17**: descriptors cover the minted result document via the
      shared `selectorBuiltinResultCause` helper).

### W2.16 — Serve the materializer class (envelope-granular write completeness)

**Depends on:** W2.11, W2.13, W2.14. **Status:** implemented (2026-07-15,
both halves). **Re-opened 2026-07-17 (C2 panel, CA6/CA10):** the map
materializer envelope does not cover the lunch-poll/group-chat write
shape — `server-execution-product-fixtures.test.ts` is red with
space-rank `dynamic-write-outside-static-surface` on `cf:builtin/map:v1`
actions with empty `uncoveredReads` (re-verified by direct run
2026-07-17); the default-app zero-verdict measurement below was accurate
but too narrow a population. The transformer derives computeIndex's envelopes outright —
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
- [x] Product fixtures (lunch-poll, group-chat) pass the dynamic claim
      firewall with zero map/ifElse
      `dynamic-write-outside-static-surface` verdicts (**closed by FW8
      2026-07-17** — the offender was the container's document-level
      meta write vs the value-root envelope; envelopes lift to
      document-root at derivation. C2.9/C2.10 unblocked).
- [x] Fable-review riders (**closed by FW8 2026-07-17**): the product
      fixtures pin the zero-verdict acceptance deterministically (only
      the recorded `wish` deferral remains in the static-unservable log,
      FB29); the `arr[i]` laundering corner fails closed at
      `wildcardUnbounded` (FB21); the envelope comments state the
      value-relative reality and the document-root lift (FB19).

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
| F2 | **Landed.** Executor Worker replica: revision-driven point reads replace per-wave graph-query refresh, via the new `docs.read` wire read (exact engine reads, no traversal; F1-attributed under its own operation). FA5 satisfied (completed by FW6, 2026-07-17 — the two deliverables the FB12 correction named as missing landed: (1) the wave-vs-demand `graph.query` split via an additive optional `trigger` wire field ("wave" = wave-forced refresh: shrink, root re-establishment, resolution moves; "demand" = first-demand cold pull / new-doc closure growth), server-bucketed into `graph.query.wave` / `graph.query.demand` sub-buckets beside the unchanged aggregate, bounded one query per affected watch per cold event and fixture-pinned per class; (2) the claimed-action closure-growth→revision→rerun fixture in the executor-provider-point-reads suite, with a withheld-delivery control proving the stale basis conflicts — the W2.8 class the fixture guards): interest set = the instance-keyed per-watch entity maps (C1.5b re-keying; absent-but-tracked docs are held as null-document snapshots); one point-read batch per acting lane at the wave's max dataSeq; deliveries flow through the existing WatchView/SessionSync pipeline (steady frames are exact deltas; observation-after-data same-turn ordering and appliedSeq semantics preserved). Shrink policy: any held doc's link-topology change (growth to a target the owning watch does not hold, or any target removal/deletion of a linking doc) routes that watch through the cold graph refresh, whose before/after diff carries the removes — so the interest set equals the last traversal's closure between topology changes (leave-the-closure fixture pinned; F3 adds server-side membership deltas so removes stop requiring a traversal). FA6 satisfied: resolved-scopeKey revision matching with declared-scope fallback on classification AND on read results; `actingContext` on `docs.read` from day one; scopeKey forwarded through syncUpsert, WatchView.applySync (instance-keyed), and — new — SessionSyncRemove. Residual: a schema-position move of a link already present in both versions stays steady and defers the newly-selected target to the demand read path (documented at the topology gate). **FB13 fixed (FW6):** per-context point-read groups (and per-watch cold refreshes) are failure-isolated — surviving groups deliver, a failed group's notices defer to a bounded retry queue (re-attempted on the next wave or lane prune, never lost) — and the lane-drain reconcile now prunes the drained lane's watches through `pruneLaneWatches`: broad-rooted watches re-key onto the context-free/sponsor read path (the shared read keeps flowing), scoped-rooted watches retire with their per-lane selector coverage so reconnect re-hydration re-pulls cleanly | **C1.5b** (semantic dependency — landed first) | met: steady-state waves (executor-provider-point-reads suite) run zero graph queries with ≤ revisions point reads; cold pulls, closure growth, linked-doc deletion, and leave-the-closure still traverse; no unwatched point reads (reads issue only for held instances) |
| F3 | Doc-set watch kind: additive WatchSpec, absent-false subcapability, server membership fan-out, ordered delivery. Binding FA1 (the watermark invariant: toSeq advances only when the COMPLETE watch surface — members as of N, served write surfaces, residual graph closures — is proven current through N; one emission point per session per wave), FA2 (membership keyed by RESOLVED scopeKey at registration under the session/lane context; raw scopeKeys on the wire are a protocol error; pre-F6 scoped deltas are per-session point reads or stay on the graph path), FA8 (server-side refcounted shrink; never SessionSync.removes), FA14 (preserved-contract checklist: dirtyOrigins echo suppression, trackedIds union, feed-frame atomicity), FA15 (per-member seq state for resumed catch-up) | F1 | membership deltas exact; watermark invariant fixture; scoped-doc pre-F6 rule pinned by test. **Corrections (2026-07-17, Fable review):** FA8 shrink is broken for same-id `watch.set` replacement — droppedSources is computed per watch id only and `#registerDocSetMembers` only ever adds, so a narrowed docs watch keeps delivering un-watched members forever (FB6, reproduced live; no shrink fixture exists); the FA1 watermark advances past member deltas silently skipped on the stale-binding fail-open with no next-wave retry (FB15); `docSetMembersTracked` is schema'd into `/api/health/stats` but never assigned (FB23); watchAdd installs the watch before member registration, so an error+retry yields a docs watch that delivers nothing (FB24); FA2(c)'s lane-context fixture is absent (FB25). All owed to the repair wave |
| F4 | Client closure export. Binding FA4 (membership derives from the replica DOC SET — every held doc across confirmed and pending/overlay layers including speculative write targets and framework reads, never the filtered reactive log; retraction evicts from the replica in the same step; served-closure pre-push vs pull-on-demand is a CORRECTNESS choice for written-not-read docs), FA8 (client re-export removals), FA15 (reconnect: re-register after catch-up, before replay). Plus F4b per FA3: boot-root demotion — one-shot graph evaluation for cold-boot roots, make-before-break replacement, partition rule, cross-kind dedup (one delivery, one frame, one watermark) | F3 | claimed chain-intermediate fixture; disconnect/reconnect fixture; unlink retraction fixture. **BLOCKER correction (2026-07-17, Fable review FB1 — flag-on F4b is nonfunctional against the real server):** the demoting `watch.set` response is a full-sync diff in which a docs-only watch set contributes zero entities, so the frame carries removes for the whole held closure; the client's same-frame remove-wins rule suppresses the seeded member upserts, the runner evicts every held doc, membership shrinks on the next reconcile, and the surface enters a permanent pull → demote → evict livelock (reproduced live ×3; violates FA3/F4b's one-delivery/one-frame/one-watermark text; makes the F5 W2.9 gate structurally unpassable). The suite stayed green because the scripted test transport omits the removes the real server emits — all five "red-first guards" certify a contract the real integration breaks (FB8); FA4's delivery-side acceptance is asserted nowhere and the chain-intermediate fixture binds membership export only (FB26). Also: eviction clears replica coverage but not the runtime/manager pull-dedup latches, so an evicted doc's re-pull is deduped away and the reader goes silently stale — FA4's forbidden stale-hit loop (FB7); nothing ever removes an unmounted doc from the client export, so an aged session's member set grows without bound (FB27). **FB1 and FB8 are FIXED (FW1/FW2, landed 2026-07-17, red-first with a real-server fixture and a discrimination-checked conformant transport); FB7/FB26/FB27 remain open (FW2 residual, FW4)** |
| F5 | Retire per-session graph re-evaluation. Binding FA1 (watermark co-owner), FA3 (per-watch classification + measured residual-traversal budget replaces the binary 'fully doc-set'), FA7 (conflict-liveness: caughtUpLocalSeq release survives retirement, fed by the same stageConflictRefreshDirtyIds staging), FA11 (record the client-side split; if the parity residual attributes to claimed-echo work, F7 enters the critical path), FA13 (dial gates eligibility only; retirement evaluated live per surface, failing open and counted), FA16 (speculative claimed-run under pending local writes fixture) | F2, F3, F4 | **Corrected status (2026-07-17, Fable review FB9/FB10/FB11 — supersedes the earlier "Mechanism landed"):** the landed switch is behaviorally inert — `retired` requires `session.graphs.size === 0` while the guarded loop iterates `session.graphs`, so the skip can only ever skip a zero-iteration loop; the zero-traversal property is delivered *structurally* by F3 (docs kind excluded from graph grouping) + F4b (client demotion), and the per-space dial governs **counters only** — it cannot hold a space on graph behavior, so the OQ4 per-space rollout story in EXPERIMENTAL_OPTIONS has no behavioral authority (FB9). The W2.9 gate is not executable at tip: `setServerPrimaryExecutionGraphRetirementConfig` has zero non-test call sites, no env, and no toolshed hook, and the harness never sets the client doc-set flag — the one live run (archived 2026-07-17) confirms the path never engaged (FB10). FB1's demotion blocker must land first regardless: engaging the flags currently destroys the replica. FA3's binding gate items were dropped, not narrowed: no cold-deep-navigation measurement exists anywhere, no mixed-mode residual-traversal budget is defined, and the binary "fully doc-set" decision FA3 ordered replaced is exactly what shipped (FB11). FA7's conflict-liveness coverage and the counters themselves stand (though `refreshResidualGraphWatches` counts branch-grouped graph states, not watches — FB28). Real retirement per FA3 (per-watch classification + budget), dial wiring, and the executable gate are repair-wave items; FA16's speculative-branch fixture remains a runner-side gate item recorded in the protocol. **FW5 landed (2026-07-17):** the dial design chosen is per-space **doc-set admission** (design (a)) — the dial rejects `docs` watches for unadmitted spaces with the non-negotiating ProtocolError shape, restoring the OQ4 hold; per-watch residual classification, the FB28 held/traversed counter split, the FB11 per-space budget, env wiring (`EXPERIMENTAL_SERVER_PRIMARY_EXECUTION_GRAPH_RETIREMENT_SPACES`), and the rewritten executable protocol (budget math + cold-deep-navigation steps) are in — see the FW5 row; FB9/FB11(gate math)/FB28 closed, FB10's server side closed (the wall-time gate itself remains the live measurement) |
| F6 | Lane-correct scoped delivery: cohort filtering. Binding FA9: dependency on C1.7 resolved explicitly (either F6 depends on C1.7, or F6 builds sessionsForPrincipal + the single #sessionAcceptsClaim predicate and C1.7 consumes them — one owner, decided at dispatch); carries the declared-scope agree-set checklist (dirty producers, trackedIds builders, session-entity cache keys, echo map, adoption surface) and the per-address scopeKey derivation rule. **Landed 2026-07-17.** FA9 resolved as C1.7-owns/F6-consumes (C1.7 landed first). Design: cohort metadata rides BESIDE the dirty set — `markSpaceDirty` accumulates per-key sets of the applied revisions' RESOLVED scope keys (from `AppliedCommit.revisions[].scopeKey`, the per-address rule — never re-derived from the session), with union-widening semantics under wave coalescing and a broadcast (`space`) sentinel for unattributed producers, so every pre-F6 caller fails open to today's fan-out. Routing filters per session before ANY work is attributed: a dirty key whose every producing revision is scoped stays visible only if a doc-set member's registration-resolved `scopeKey` (lane acting contexts included — the FB25 family) or a tracked graph's own read context (`TrackedGraphState.manager`) owns an instance the cohort names; a session left with no visible intersection is never touched (no engine open, no traversal, no point read — counted in the new `feedStats.refreshCohortSuppressedSessions`). Agree-set reconciliation: trackedIds/cache keys stay declared-scope (filtering is at routing, the union surface is untouched); the echo map needs no change (per-instance seqs already discriminate, and out-of-cohort sessions no longer read at all); adoption rows were already context-filtered by `#schedulerApplicableContextKeysForSession`; conflict staging (`stageConflictRefreshDirtyIds`) deliberately stays broadcast — a rejected commit has no revisions to derive from and FA7's release must never depend on cohort membership. Fixtures in `v2-feed-cohort-test.ts` (red-first: 5/6 failed pre-mechanism) | F3, C1.7 (per FA9 resolution) | met: another session's session-scoped commit produces zero B-side work (asserted via `refreshSessionsTouched`/`docSetMemberDeliveries`/`refreshCohortSuppressedSessions` through the REAL transact→flush pipeline); user-scoped revisions reach only that principal's sessions, including a lane-held docs watch under the lane's acting context; graph-path scoped roots cohort-filtered too; space broadcast byte-identical (positive control + no-metadata fail-open fixture) |
| F7 | G17 claimed-cold suppression. Binding FA10 (make-before-break between closure sources: the served contribution survives until the replacement export covers the same docs, or the revoke carries a catch-up barrier seq and the rerun defers until member deltas through it apply) and FA11 (pull-in trigger: enters the critical path if F5's parity residual attributes to claimed-echo client work) | F4, F5 | revoke-concurrent-with-commit fixture: the rerun's basis covers the commit; stays-cold adoption fixture |

Open decision (deferred by measurement, per the standing
measure-before-fixing rule): closure growth under client-exported closures
(F4) — accept the +1 RTT pull-on-demand for never-seen linked docs, or
build §6.4's served-closure pre-push first. F4's fixtures decide;
escalates to the owner only if both options violate the ~zero W2.9 budget.

#### F5 measurement protocol (the W2.9 gate)

Rewritten by FW5 (2026-07-17) so every step is executable against the code at
tip (FB10) and the FA3 gate items — mixed-mode budget math and the
cold-deep-navigation measurement — are named steps (FB11). The retirement
mechanism, the dial's admission authority, and every counter this protocol
consults are pinned deterministically in
`packages/memory/test/v2-feed-retirement-test.ts`; the shipping-critical
acceptance is a wall-time measurement the rollout owner runs — it cannot run
inside the isolated worktree. The gate:

1. **Configure the deployment (both env legs).** On the toolshed host set
   `EXPERIMENTAL_SERVER_PRIMARY_EXECUTION=true`,
   `EXPERIMENTAL_SERVER_PRIMARY_EXECUTION_DOC_SET_WATCH=true` (one env, two
   effects: the server advertises the `docs` subcapability and the host's own
   runner clients negotiate it; the browser client's flag arrives via the
   shell host's `InitializationData`), and
   `EXPERIMENTAL_SERVER_PRIMARY_EXECUTION_GRAPH_RETIREMENT_SPACES=<space DID>`
   (or `*`) to admit the default-app space under test — the dial's admission
   authority is what lets F4b demotion proceed on that space; a withheld
   space's `docs` watches are rejected and it stays on graph behavior (the
   OQ4 hold). The flag-off leg unsets
   `EXPERIMENTAL_SERVER_PRIMARY_EXECUTION_DOC_SET_WATCH` (leaving the dial
   set is then inert — nothing sends `docs` watches). Confirm engagement
   before measuring: after driving the app once,
   `serverExecutionFeed.docSetMembersTracked > 0` and
   `refreshRetirementEligibleSessions` advancing on
   `/api/health/stats` mean the surface demoted; both flat at 0 mean the
   client flag or the dial leg is miswired (the 2026-07-17 run's failure
   mode).
2. **Run the flag-on / flag-off note-create pair** — the same default-app
   note-create series as the FA12 archived baseline
   (`docs/history/development/performance/server-execution-feed-baseline-2026-07-16.md`,
   the ONLY comparison basis; never the unarchived plan-text numbers). The pass
   bar: flag-on reaches flag-off **parity within noise** (the pre-F5 residual
   was +10.6% avg / +3.8% p50).
3. **Read the F1 counters from `/api/health/stats`** for the flag-on run and
   confirm the mechanism, not just the wall time:
   `serverExecutionFeed.traversalByOperation["session.watch.refresh"]` absent
   or its `dagTraversals` ≈ 0 (that source was ~94k/run flag-on before F5);
   `refreshFullyDocSetSessions` tracking the touched sessions
   (≈ `refreshSessionsTouched` for the app session's waves);
   `refreshResidualGraphWatches` naming surfaces that failed open (held
   composition — e.g. a boot root that never demoted) with
   `refreshResidualGraphWatchesTraversed` distinguishing whether they
   actually forced traversal this run (an idle residual watch accrues held
   counts only — FB28; chase the *traversed* counter, corroborated by
   `traversalByOperation["session.watch.refresh"]`, not the held gauge);
   `docSetMemberDeliveries > 0` with
   `traversalByOperation["session.docset.read"].dagTraversals = 0` (members
   flow as zero-traversal point reads); and the F2 floor read from the FW6
   wave-vs-demand split (FB12 resolved): `graph.query.wave` (wave-forced
   refreshes — shrink, root re-establishment, resolution moves) must stay
   ≈ 0 across the steady-state series — that bucket, not the aggregate, is
   the F2 regression signal — while first-demand pulls and closure growth
   land in `graph.query.demand` and may grow with usage. The aggregate
   `graph.query` bucket is unchanged for continuity with the historical
   ~1,566 floor; untriggered (non-executor) callers land only there.
4. **Evaluate the mixed-mode residual-traversal budget (FA3/FB11 gate
   math).** Let `W` = note-create waves driven against admitted space `S`
   and `T` = the run's delta of
   `serverExecutionFeed.refreshResidualDagTraversalsBySpace[S]` (residual
   graph-refresh DAG traversals only — member point reads and demand pulls
   never land in this bucket). The gate: **`T / W ≤ B`**, where `B` is the
   per-wave residual recorded from this baseline run (for the fully-demoted
   default app, record `B = 0`). **Fully-doc-set sessions must read 0** by
   construction: if every touched wave retired
   (`refreshFullyDocSetSessions` delta = `refreshRetirementEligibleSessions`
   delta), then `T` must be exactly 0 — any non-zero `T` names a mixed
   surface, quantified per watch by the held/traversed pair from step 3. A
   later run over the same workload fails the gate when its `T / W` exceeds
   the recorded `B`: that is the defined mixed-mode regression, replacing
   the unfalsifiable "≈ 0, investigate" prompt.
5. **Cold-deep-navigation measurement (FA3).** From the demoted steady state
   (after step 2's series, same session), drive the two flows FA3 names as
   F5's regression class, and measure each against the flag-off leg of the
   identical navigation: **(a) unvisited-subtree open** — navigate to a
   piece/document never rendered this session (e.g. open a note from a list
   link that was never opened since boot, one whose closure is outside the
   held doc set); **(b) handler read of a never-rendered doc** — trigger an
   action whose handler reads a doc outside the held closure. Pass bar:
   open/action latency parity within noise vs flag-off. Mechanism
   confirmation distinguishing demand pulls from graph refresh: the closure
   arrives via the cold/demand path — deltas in
   `traversalByOperation["graph.query"]` (and `"session.watch.set"` /
   `"session.watch.add"` for the transient cold-discovery watch and its
   demotion re-registration) — while
   `traversalByOperation["session.watch.refresh"]` and
   `refreshResidualDagTraversalsBySpace[S]` stay flat (no graph-refresh
   traversal woke up), and `docSetMembersTracked` grows as the new closure
   demotes into membership on the next reconcile.
6. **Record the client-side split (FA11)** — `viewConditionMs`,
   `viewIdleWaitMs`, claimed-echo recompute, and adoption-application time.
   Post-W2.16 settlements average ~528 ms inside the ~670 ms note window, so if
   the residual after retirement attributes to **claimed-echo client work**
   rather than server traversal, **F7 (G17 claimed-cold suppression) enters the
   critical path** before the gate is re-attempted (the FA11 pull-in trigger).
7. **FA16 speculative-branch fixture (runner-side).** Because clients still
   speculate until F7, add a claimed `ifElse` whose branch flips under a pending
   local write and assert the speculative run resolves entirely from the replica,
   OR the resulting stall is measured and accepted within the ~zero W2.9 budget.
   This exercises the client speculation path (runner `v2.ts`), which the
   memory-server refresh-loop tests here cannot see; it belongs to the live gate
   run, not the server unit suite.

#### Feed repair wave (2026-07-17, from the Fable commit review FB1–FB31)

Owns every defect the
[Fable commit review](../../history/development/design/fable-commit-review-2026-07-17.md)
confirmed in the landed feed/C1/W2.x commits. FW1–FW2 are the blocker
chain and go first: they are what stands between the branch and an
engageable F5 gate, and per the corrected C2 prerequisite they precede
F6 on C2's critical path. FW8's selector fix independently unblocks
C2.9/C2.10 (CA10). Red-first throughout: each WO's fixture must fail
against tip before its fix lands.

Known pre-existing red, NOT owned by this wave (triaged 2026-07-17):
`packages/runner/test/reload-rehydration-map-children.test.ts` fails
identically at the pre-wave tip (96bc48b81) and does not exist on main
— it arrived with the scheduler-v2 refactor era ("resumed map rows run
fresh across sessions and stay live", assertion expects fresh rows,
gets 3). Owed a triage of its own; it is excluded from wave
acceptance sweeps.

| WO | Title | Depends on |
| --- | --- | --- |
| FW1 | F4b demotion make-before-break (FB1): the demoting `watch.set` response stops removing docs that are members of the incoming watch set — suppress the full-sync diff removes for current members server-side, keeping genuine closure-shrink removes intact (FA3's "delivered once, in one frame, under one watermark"). **Landed 2026-07-17:** `suppressDocSetMemberRemoves` applied at both remove-producing emission sites (the watchSet handler, post-registration/post-drop, and the resume catch-up) — every other sync site constructs `removes: []`. Red-first fixture against the REAL server ("F4b demotion: graph-tracked docs that become members survive…", `v2-docset-watch-test.ts`): member survives its own demotion with value intact, the departing doc still removes (the honesty control), and a post-demotion commit reaches the member through membership fan-out. Adversarially re-reviewed post-fix (scopeKey fallback, same-frame drop ordering, resume/emptyCatchUp semantics — no defect) | — |
| FW2 | F4 suite conformance (FB8, FB26): the scripted `DocSetWatchTransport` emits the real server's demotion diff shape (removes included); the five behavioral guards re-run against the conforming peer; FA4's delivery-side acceptance gets asserted (a written-not-read member is delivered before/with the sync whose toSeq covers its settlement). **Landed 2026-07-17 except the FA4 delivery-side assertion (still owed):** the transport tracks the graph-delivered surface + members and computes the fixed server's diff removes; the demotion guard now binds replica survival and steady-state (no re-pull/re-demotion churn), discrimination-checked — modeling the unfixed server turns the suite red | FW1 |
| FW3 | FA8 membership shrink (FB6): same-id `watch.set` replacement evicts dropped members (per-member source refcounting, not per-watch-id droppedSources); shrink fixture pins "an aged session's member set equals a fresh session's for the same UI"; non-atomic watchAdd registration fixed (FB24); `docSetMembersTracked` gauge assigned (FB23); FA1 stale-binding skip gets its next-wave retry (FB15); FA2(c) lane-context fixture (FB25). **Landed 2026-07-17** (red-first + discrimination throughout; memory 607/607 at landing). Rider found in passing, still open: the resume path calls `#scopeContextForSession` unguarded, so an in-band re-open of a lease-bound session with watches fails its resume catch-up with a ProtocolError — needs its own small fix + fixture | — |
| FW4 | FA4 read-path re-pull (FB7, FB27): eviction clears the runtime `missingDocLoadKicks` and manager `#docPullKicks` latches for evicted docs so the next read actually re-pulls; client-export shrink removes released docs so the export cannot serve husks forever. **Landed 2026-07-17** (both latches independently proven necessary; FA4 speculative-write-target guard held). Open residual: disuse/LRU shrink of genuinely-held-but-unshown docs is a policy FA4 does not define | FW1 |
| FW5 | F5 real retirement + executable gate (FB9, FB10, FB11, FB28): per-watch classification with a defined mixed-mode residual-traversal budget replaces the binary `graphs.size === 0` predicate (FA3 as written); the dial gains behavioral authority and a wiring path (env or toolshed hook) so the W2.9 protocol is executable end-to-end; cold-deep-navigation measurement added to the protocol; `refreshResidualGraphWatches` counts what its name says. **Landed 2026-07-17:** the dial's authority moved to **doc-set admission** (design (a)) — a space absent from `EXPERIMENTAL_SERVER_PRIMARY_EXECUTION_GRAPH_RETIREMENT_SPACES` (comma-separated DIDs or `*`; applied at construction by toolshed `routes/storage/memory.ts` and the standalone server) has its `docs` watches rejected with the non-negotiating ProtocolError shape, and the runner reconcile's existing catch keeps its graph watches (`packages/runner/src/storage/v2.ts` `reconcileSpaceDocSetWatch` — verified read-only: registered-keys commit only on success, so it retries and never errors), so withholding a space is a real OQ4 hold; red-first dial-authority fixture (withheld space rejects demotion + keeps traversing; dial flip admits it and the next wave is zero-traversal) in `v2-feed-retirement-test.ts`. The provably-dead `retired` skip branch was deleted (zero traversal is structural: F3 grouping exclusion + F4b demotion; a mixed surface MUST traverse — FA13 fail-open forbids any server-side skip with authority, which is why admission is the only real per-space lever). Refresh-loop classification is per watch (FA3): `refreshResidualGraphWatches` = held residual watches (two watches on one branch count 2), new `refreshResidualGraphWatchesTraversed` = watches whose branch group actually re-traversed (FB28 red-first fixture: member-only wave counts held 2 / traversed 0), new `refreshResidualDagTraversalsBySpace` = the FB11 budget numerator (schema-compatible additions; consumers updated: toolshed observability type, health stats schema + fixture). The protocol above is rewritten executable end-to-end with the budget gate math (step 4) and the named cold-deep-navigation step (step 5). Eligibility gauges no longer re-consult the dial, so shrinking it cannot hide a live surface (FB9(c)); dial shrink takes effect for new registrations only. The W2.9 wall-time gate itself remains a live measurement | FW1, FW2 |
| FW6 | F2 FA5 completion + wave-drop fix (FB12, FB13): wave-vs-demand `graph.query` split with per-cold-event bounds; the claimed-action closure-growth → revision → rerun fixture; lane drain retires (or re-keys) the drained lane's watches and a rejected point-read group no longer discards the whole spliced-out batch — re-queue or context-free fallback, fixture-pinned. **Landed 2026-07-17:** optional `trigger` wire field on `graph.query` ("wave"/"demand", closed enum at the parser) recorded into additive `graph.query.wave`/`graph.query.demand` sub-buckets beside the untouched aggregate (health-stats consumers need no schema change — `traversalByOperation` is an open record), threaded from the host provider's registration ("demand") and cause-classified cold paths (shrink/re-establish/re-key = "wave", growth/first-pull-retry = "demand", wave wins ties), fixture-pinned per class with the one-query-per-cold-event bound; the FA5 rerun fixture plus its withheld-delivery conflict control landed in the executor-provider-point-reads suite; FB13 fixed as (a) per-group and per-cold-watch failure isolation with a deferred-notice retry queue (retried on the next wave or prune — the (a)-only residual "re-queues forever under a still-keyed dead lane" is fixture-pinned) and (b) `pruneLaneWatches` from the lane-drain reconcile: broad-rooted watches RE-KEY context-free (chosen over retirement because surviving lanes dedupe their hydration onto the first holder's watch and shared coverage — retiring would starve them), scoped-rooted watches RETIRE together with their per-lane selector coverage and any queued dead-lane registration batch, so reconnect re-hydration re-pulls; three staged fixtures pin drop-isolation, cold-path isolation, and scoped retirement/coverage | — |
| FW7 | C1 acceptance re-binding (FB14, FB4, FB5): the two-principal gate runs in an automatically-executed lane (wire `CF_RUN_USER_LANE_GATE` into CI or drop the env gate; de-flake the documented teardown flake); the A2 WRITE-revocation fixture asserts on default runs; the shrink-race fixture goes through the real Worker `ClaimedActionGoneError` seam; the cross-lane pending-read fixture routes lane A upstream so the A16 lane machinery is discriminating. **Landed 2026-07-17**: the flake was a Deno Worker.terminate()-vs-loop-resolution runtime race, neutralized by a teardown barrier (10/10 pristine); the env gate is DELETED — 6/6 gate tests including A2 assert on every default run; both fixtures carry their FB4/FB5 discrimination contrasts (guarded-bug reintroduction reds the new fixture while the old stayed green) | — |
| FW8 | W2.x certificate repairs (FB3, FB18, FB2, FB16, FB17, FB30, FB21, FB19, FB29 + CA6's map half): selector descriptors cover the minted result document (the `listBuiltinResultContainerCause` precedent) with a firewall-exercising cold+flip fixture; map's product-fixture write-surface completeness (the CA6/CA10 re-open); W2.13 gains the capture-freeness check its gate doc promises; W2.14's two vacuous tests bind their arms; W2.12's runtime-floor test; the `arr[i]` laundering corner; the runner.ts:5174 comment; a deterministic zero-verdict pin. **Landed 2026-07-17**: server-execution-product-fixtures GREEN (3/0) — the map failures were NOT the designed child de-claim but the container's document-level ["result"] meta write vs a value-root envelope (FB19's mechanism); envelopes now lift to document-root at derivation; ts-transformers 1111/1111 | — |

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

**Status (2026-07-17, corrected by the
[Fable commit review](../../history/development/design/fable-commit-review-2026-07-17.md)
and re-bound the same day by the repair wave): the design §7 C1
acceptance criterion is MET and BINDING — FW7 deleted the
`CF_RUN_USER_LANE_GATE` env gate after root-causing its flake (a Deno
Worker-termination runtime race, not a fixture leak), so the
two-principal gate and the A2 security fixture assert on every default
integration run (FB14 closed).**
C1.1–C1.9 are implemented and pushed, including three gate-driven
additions: C1.9b (the §4 output-widening pair admitted at the runner
servability seam; lane-instance hydration before claimed runs — the gate
found both) and C1.9c (per-lane serving: lane-keyed candidates and
(action, contextKey) claims, per-lane recompute). C1.10's five owed fixtures now all bind
their named races: FW7 rebuilt the shrink-race fixture through the real
Worker `ClaimedActionGoneError` seam and made the cross-lane
pending-read fixture discriminating (upstream-routed foreign version
under a held confirmation), each proven by guarded-bug reintroduction
(FB4/FB5 closed). C1.11's §10 parent-doc edits stand. Feed progress alongside: F1 and F2 are landed —
but treat F2's previously-recorded traverse-collapse numbers
(graph.query 171,482 → 1,566; ~95% total reduction) as **unmeasured
pending re-run**: they exist only as unarchived plan text and are
contradicted ~37× by the branch's sole archived post-F2 measurement
(FB31).

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
| C1.5a | Executor candidate rank from the durable floor; **intra-Worker lane identity** (candidate/claim/wake identity maps + CandidateClaim message) gains contextKey — the pool slot key, lease topology, and one-Worker-per-(space, branch) are explicitly unchanged (A22) | C1.1, C1.4b | PerUser observation → user-rank candidate; space regression green; C1 issues user-rank claims for `computation` only (A8 — effects stay space-lane; lane-grant egress per OQ6 is owned by C2.8, a **C2 exit gate** since the 2026-07-17 owner revision, tracked as register row R12 — **lifted by C2.8, 2026-07-18**: scoped lanes carry effect claims too, R12 resolved) |
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

**C2 status (2026-07-18): COMPLETE.** Every row is landed: C2.1–C2.3
(wave A, 2026-07-17), C2.4–C2.5 (wave B, 2026-07-17), C2.6
(2026-07-17), C2.7 (2026-07-17), C2.9 (2026-07-17), C2.10 (built
2026-07-18; its two found defects fixed at the root the same day),
C2.8 (2026-07-18 — the C2 exit gate is met, register row R12
resolved), and C2.11 (2026-07-18 — the owed-fixture audit found every
promised fixture already landed incrementally; the row records the
audit). The design §7 C2 gate list is met, each item bound by a
default-run fixture:

- *a PerSession derivation settles under its own session's lane grant
  regardless of which principal's commit caused the recompute* — the
  C2.9 gate (`server-execution-session-lane-gate.test.ts`, 3/3
  consecutive);
- *a foreign session's client never matches the claim and its state is
  never readable from the lane* — the same gate's wire tap +
  stored-claim sweep + closed-store SQLite isolation, with the CA5
  push-side half in `v2-feed-cohort-test.ts` ("F6 CA5") and the C2.6
  delivery fixtures (`v2-execution-session-context-delivery-test.ts`);
- *the lunch-poll placement guard passes* —
  `server-execution-lunch-poll-placement-gate.test.ts` (3/3; the
  strict placement criterion MET per the C2.10 row);
- *settlement latency with ≥3 concurrent session lanes stays within
  the agreed budget* — `server-execution-session-lane-latency-gate.test.ts`
  (3/3; loopback 3-lane p95 36.2 ms under the structural ceiling).
  The browser-scale ms budget is deliberately evaluated at the live
  W2.9-style measurement; the owner budget is PROVISIONAL,
  ratification pending — the one open owner decision C2 carries
  forward;
- *`claim-context-mismatch` returns to the placement guard's
  hard-zero set* — the R7 tolerance retired (C2.10; guard-contract
  test in the placement gate; lattice §8 R7 updated).

Two named non-blocking residuals carry forward, both recorded and
fail-closed: (1) the **scoped-lane minted-result instance-coverage
gap** — non-direct-output minted docs at a scoped lane's instance
still route unserved (a §4 coverage gap, recorded with the C2.10 fix
wave); (2) **offline scoped-lane egress under standing keys** — zero
connected sessions ⇒ no grant ⇒ no claim, pinned negative at three
layers by C2.8's fixtures; the consent design rides lattice OQ1. C3
entry: the amended C3 table below is the next frontier — the C2 exit
gate (C2.8, per the owner's 2026-07-17 ruling) is met, so C3 build
may start.

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
  completeness (CA10). (Closed by FW8, 2026-07-17: the product fixtures
  went green before C2.9/C2.10 built on them — see the W2.15/W2.16
  status lines.)
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
  decision, not a default (open in the session summary). (Delivered
  2026-07-18: C2.10 landed the split gate; the ms budget is recorded
  PROVISIONAL at the live measurement, owner ratification pending.)
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
cap is a follow-on, revisited if C2.10's latency gate shows pressure
(the gate landed 2026-07-18 and its loopback legs showed none — 3-lane
p95 36.2 ms, ≈2.4× the single lane; the revisit input is now the live
measurement's 3/10/30-lane scaling series).
Default 2 survives as **build order** — computation-first like C1 (A8,
lifted by C2.8, 2026-07-18): lane grants, fencing, and drain proved out
before egress rode them,
because an external call is the one side effect the per-commit firewall
cannot retro-reject — but its "session-lane builtin egress (OQ6, C2.8)
is a named follow-on, not a C2 gate" clause is **overridden by the owner
(2026-07-17, post-panel): C2.8 is a C2 exit gate, pre-ship** (met
2026-07-18) with the same force as the C3 pre-ship ruling. Rationale: the end state is all
standing reactive work — computations AND effect builtins — server-side,
with only handlers (R1, Phase 5) and render (R2) client-executed; a
follow-on with no phase binding is the permanent-carve-out failure mode
design §1 argues against, and the exclusion had no residual-register row
(§8 gains R12/R13 with this revision). C2.8's scope: session lanes and
user lanes with a connected anchor session (lifting C1's A8
restriction — delivered 2026-07-18, R12 resolved); only *offline*
egress under standing delegated keys stays
parked with OQ1, where the consent question genuinely lives. Defaults 1
and 4 are amended above (CA4, CA11).

| WO | Title | Depends on |
| --- | --- | --- |
| C2.1 | Engine + dial admit session-rank claims (ladder + **issuance-binding + admission + commit-lane**, CA1; canonical key validation, CA12) | — |
| C2.2 | Servability + firewall: session-lane surface classification and the §4 pair at session rank (**owns `scope-naming-link.ts` session parameterization, CA2**; does NOT meet the ifElse gap — CA6) | C2.1 |
| C2.3 | Session lane grants — the session is its own anchor; session-end = lane-end; **issuance-binding path, CA1** | C2.1 |
| C2.4 | Session-lane acting-context read seam — **substitutes the grant's session id, not base.sessionId (CA8)** | C2.3 |
| C2.5 | Session-rank executor candidate identity + router widening; **real session identity source, no DID fabrication (CA9); laneScopeKey broader-in-chain collapse, CA3** | C2.2, C2.4 |
| C2.6 | **Load-bearing (CA4):** narrow session-claim delivery to the named session — kills the quadratic sibling-session rerun, not just fan-out. **Landed 2026-07-17:** the narrowing is one branch in the single C1.7 delivery predicate (`#sessionAcceptsClaim`, server.ts) — a session-context claim/revoke/settlement is accepted only by the exact session its contextKey names (canonical CA12 parse; per-session claims-v1 negotiation on the current attach) — so publish, reconnect snapshots, retained events, and settlement-frontier accounting all narrowed together with no per-consumer edits. Red-first fixtures (`v2-execution-session-context-delivery-test.ts`, 2/3 red pre-change with sibling B receiving the `session:alice:A` claim.set and carrying it in its reconnect snapshot): sibling and foreign sessions observe ZERO delivery and ZERO feed bookkeeping (retained events + frontiers, asserted against the injected SessionRegistry); a reconnect snapshot is exactly "space lane + own user lane + OWN session lane" (§2); a takeover downgrade leaks no session-context event, and the fixture records why per-session negotiation suffices without a principal-wide cohort fence (a session claim only suppresses its named session under own-chain acceptance, and a non-negotiating attach of the same session id is fenced in openSession admission before its response releases). The C2.3 drain-isolation fixture flipped from pinning the over-broadcast to asserting zero sibling delivery. The CA4 ordering invariant on the rank dial / session-rank candidates is lifted (EXPERIMENTAL_OPTIONS updated). Wake/demand paths are untouched — C2.7's wake widening must apply its own session-lane scoping | C2.1, C2.3 |
| C2.7 | Session-lane demand aggregation, lifecycle, wake widening; **session lane-write-authority fence re-check (CA7)**; parked-skip is emergent (CA13). **Landed 2026-07-17:** demand derives host-side from the owning session's published demand (no new wire message, §2); the A4 wake pairs gain open session grants scoped to the owning session only; the pool reconciles per-session lanes (ladder-gated, per-session negotiation, reopen-after-drain under a bumped generation with one-shot resetClaims); CA13 asserted as EMERGENT (no parking state — grant absence is the skip; disconnect→dirt→resume→catch-up fixtured); the CA7 session TOCTOU backstop pinned with the C1.10 injection technique (mutation run reds it); one latent Worker cross-rank template bug found and fixed (unpinned — C2.9/C2.11 owe the real-Worker session e2e). Memory 668/668; pool/candidate/e2e suites green | C2.3, C2.5, C2.6 |
| C2.8 | Scoped-lane builtin egress under the lane grant (OQ6): session lanes + user lanes with a connected anchor (lifts A8's computation-only restriction — the engine admission gate that holds it, `isAdmissibleExecutionClaimContextKey` engine.ts:8259 per CA1's citation, plus the three sponsor-keyed gates become lane-conditional: the `deno-space-executor` pre-claim drop, the `executor-worker` egress-guard identity, and `causalActorMatchesSponsor` consultation, applied only when `claimKey.contextKey === "space"`; per-lane broker acting identity; G11 parity per lane). **C2 exit gate, pre-ship** (owner, 2026-07-17); offline egress under standing keys stays with OQ1. **Landed 2026-07-18 — the C2 exit gate is met.** The A8 conjunct lifted red-first at every layer that held it: the servability effect arm (`broker-required` now carries `contextRank`; session/user rank rules identical to computations, chain-read rule included), the engine admission guard, the host issuance rank dial (`#executionClaimRankEnabled`; effects stay gated by the passivity flag at every rank), and the executor candidate wire shape. The three sponsor-keyed gates are lane-conditional exactly as specified; for scoped claims the Worker egress guard validates the LANE identity instead (the run must be pinned to the claim's own lane — the acting context IS the consent). The broker acting identity is host-DERIVED from the validated claim contextKey (`ServerBuiltinActingIdentity`: sponsor for space, principal for user lanes, principal+session for session lanes) under W1.4's A23 discipline. Brokered egress is authorized by the LIVE lane grant: `Server.hasLiveExecutionClaim` — the broker gate — consults `#liveLaneGrantForKey` at the bound generation for scoped claims (the commit fence's own consult), so a drained lane's in-flight builtin cannot egress. G11 verified identity-independent and pinned per lane (serving-origin + blocked-destination parity legs, `server-builtin-channel.test.ts`). Fixtures: THE OQ6 e2e (`executor-scoped-egress-e2e.test.ts`, real Worker, session AND user legs — foreign-caused recompute egresses under the lane grant with zero causal-origin consultation; in-flight lane drain → no post-fence egress, claim revoked, no re-claim), host halves in `memory/test/v2-execution-scoped-egress-test.ts` (issuance lift, dial-off regression, drain gate, and the fixture-(e) offline pin: zero connected sessions ⇒ no grant ⇒ no claim — OQ1 stays unbuilt), router/classifier legs (`executor-action-router.test.ts`, `scheduler-servability.test.ts`: per-lane builtin candidates, CA9 rank filter for effects, dial-off byte-identical), lane-conditional host drop (`executor-candidate-claim.test.ts`, space drop byte-identical beside the scoped no-drop). Discrimination by mutation: re-enabling the sponsor gate for scoped lanes reds the e2e; dropping the lane-grant validation at the broker gate reds the drain fixtures. Space-lane egress byte-identical (the causal-mismatch permanent-failure e2e leg green unchanged); llm/sqliteQuery pinned outside the registry (R5) | C2.4, C2.5; build sequenced after C2.9–C2.10 so egress never muddies the latency measurement |
| C2.9 | PerSession measurement gate + fixture; **push-side confidentiality fixture (CA5); depends on W2.15/W2.16 write-surface completeness (CA10)**. **Landed 2026-07-17** (`server-execution-session-lane-gate.test.ts`, default-run, 3/3 consecutive): the §7 gates bind — foreign-caused recomputes settle under their OWN session lane; foreign clients never match/read (wire tap + stored-claim sweep + closed-store SQLite isolation); per-lane schedulerRuns recorded rank-generically (A25). CA5 bound at both planes (red-verified). Closed C2.7's owed real-Worker session e2e; template-rank guard mutation-verified. **Found and fixed a session-lane liveness wedge in the landed mechanism** (conflicted claimed lane commit finalized by a lane-blind revert; onAttemptSettled now schedules a lane-pinned rerun on ConflictError for non-space lanes — user lanes had the same latent hole). R7 observed hard-zero in-fixture; c210Inputs logged for the C2.10 builder | C2.4–C2.7, W2.15/W2.16 re-work |
| C2.10 | Lunch-poll placement guard: R7 retirement + **split gate — parity bar AND an owner-set latency budget (CA11)**. **Built 2026-07-18; all four legs GREEN (fix wave landed same day): the placement acceptance harness found two real defects, both fixed at the root — the C2 §7 gate-list item "the lunch-poll placement guard passes" is SATISFIED (placement criterion MET; harness default-run, 3/3 consecutive).** (1) **R7 retired to hard-zero** (the named C2 acceptance criterion): the `claim-context-mismatch` entry deleted from `TOLERATED_LEASE_FENCE_CAUSES` per the registry's own retirement contract, pinned red-first by the guard-contract test in `server-execution-lunch-poll-placement-gate.test.ts` (tolerated set now exactly the two drain causes); hard-zero observed in every C2.10 harness run and re-asserted inside the latency window. (2) **CA11 latency gate** (`server-execution-session-lane-latency-gate.test.ts`, default-run, 3/3 consecutive): 3 session lanes + space on one Worker, foreign-caused settlement rounds via a never-started driver client; **measured (loopback, 12 rounds/leg): single-lane full-settlement p50 15.1 ms / p95 29.8 ms; 3-lane full p50 23.7 ms / p95 36.2 ms; space-lane p95 36.2 ms** (the CA11 space-lane starvation leg is asserted specifically). In-process the gate asserts a GENEROUS structural ceiling only — 3-lane p95 ≤ max(10× own single-lane p50, 1500 ms) — because a loopback harness cannot honestly measure the browser-workload budget. **The ms budget is evaluated at the live W2.9-style measurement (the F5 protocol's machinery), owner budget PROVISIONAL, ratification pending (proposed by the C2.10 build session): settlement p50 ≤ 878 ms (flag-on baseline avg 764 ms + 15%) and p95 ≤ 2170 ms (2× flag-off baseline p95 1085 ms), against the 2026-07-16 feed-baseline note-create pair; the CA11 3/10/30-lane scaling series lives there too.** These measured numbers are the OQ5 topology-decision input. (3) **Placement, classification half** (runner `server-execution-product-fixtures.test.ts`): the real lunch-poll vote workload classifies claim-ready at session rank keyed by the OPEN session lane only (CA9), with a dial-off self-control pinning zero scoped candidates — the §1 collapse's classification reversal. (4) **Placement acceptance harness** (worker-realm multi-runtime clients over a gate-hosted WS server + real pool/Worker; harness-local `MULTI_RUNTIME_CONTEXT_LATTICE_CLAIMS` seam added to `multi-runtime-worker.ts` since the client lattice-claims dial is programmatic-only): built BLOCKED-RED as the red-first fixture for two found defects; **both fixed 2026-07-18, env gate removed — default-run, 3/3 consecutive green.** (a) **Second-voter merge staleness** (was: the second concurrent voter's replica permanently kept the pre-merge `voteCount`): root cause is the own-commit confirmation path — the engine merge-rebases the concurrent voter's mergeable patch onto a head the origin replica never saw, the client's `confirmPending` promoted its pre-merge LOCAL replay at the accepted seq, and the divergence is permanent because FA14 echo suppression correctly withholds a session's own committed seq while the other writer's older upsert is refused by the monotonic-confirmed guard. Fixed at the root: the engine marks merge-rebased patch revisions with the authoritative post-apply `document` (engine.ts `writeOperation` patch case, pre-apply-head author check; replays fail toward authority) and `confirmPending` adopts it in place of the local replay with an integrate-shaped notification (storage/v2.ts). Deterministic mechanism fixtures: `v2-engine-revision-test.ts` (merge-rebased revisions carry the document; same-session heads stay slim) and `array-push-mergeable.test.ts` ("the second concurrent appender's own replica adopts the merged list"). (b) **Session-rank read-fold churn** (claimed `ifElse`/`when`/lift runs over entity-link reads rejecting `unobserved-read`): the commit carries a whole-`["value"]` confirmed read of the link doc at the acting lane's SCOPED instance while the summaries folded framework reads at space scope only (W2.14's fold), and the transformer-certificate path folded none. Fixed by applying the fold uniformly at every summary source — certificate (`transformerCertificateScopeSummaryInput`), selector descriptor, materializer descriptor, runtime materializer, write-empty — via `sameSpaceLaneInstanceReads` (any lane-instance scope, same-space, READS only; malformed scopes stay excluded fail-closed); unit-pinned per source in the scheduler summary/descriptor test files. Discrimination: reverting either fix reds the harness with its original signature (fold revert → nonzero `actionFirewallRejects`; adoption revert → `aliceVoteCount: 1` divergence timeout). Green strict-run measurement: session lanes claimed 11+11, 33 session-rank candidates, accepted-commit index **138 matches / 325 lookups** (the §1 evidence measured 434 of 438 notices matching nothing), server-lane-authored session-scoped rows nonzero, committed settlements nonzero, zero claim-context-mismatch, zero firewall rejects; full memory suite (670) and runner scheduler-*/executor suites green | C2.9 |
| C2.11 | Owed session-lane fixtures (incl. the session lane-write TOCTOU backstop, CA7) + EXPERIMENTAL_OPTIONS/docs. **Landed 2026-07-18 as the closure audit + docs sweep — the CA-by-CA audit found zero genuinely-missing fixtures; every promised fixture landed incrementally with its mechanism WO.** The headline CA7 TOCTOU backstop landed with C2.7 (`memory/test/v2-execution-session-claim-context-test.ts`: the WRITE-loss fence leg and "a session commit racing the ACL-drain reconciliation fences lane-write-authority while the lane is still live", C1.10 injection technique, mutation-verified). The Finding-8 owed set landed with waves A/B + C2.7: drain-on-disconnect and routing-disjointness in `v2-execution-session-lane-grant-test.ts`, cross-session pending isolation in `runner/test/storage-v2-replica-lanes.test.ts` (CA3/A16) plus the CA8 discriminating pair in `v2-execution-session-lane-read-test.ts`, and the CA13 drain/no-wake/catch-up fixture in `v2-execution-session-lane-lifecycle-test.ts`. CA12's wire shapes are complete (five malformed forms incl. `session:a:b:c` and `session::` at the single wire validator, `v2-execution-session-lane-grant-test.ts`, plus the engine fence leg and colon-safe round-trip in the claim-context file). CA2's conformance is bound on both sides (runner emit pin in `pattern-binding.test.ts`, engine accept in `v2-execution-lane-firewall-test.ts`, the shared `v2-scope-naming-link-test.ts` suite). The C2.7-flagged unpinned Worker template-rank guard was closed by the C2.9 gate (late-lane template synthesis legs, mutation-verified), and CA5 is bound at both planes (C2.9). CA4's client-notification half is bound by composition: the delivery fixtures assert zero sibling wire delivery red-first at the single predicate where the fix lives, with the client invalidation chain documented by code refs in both docblocks — a separate client-side zero-invalidation fixture would re-assert the same delivery seam through a heavier stack. The balance of the WO is the docs closure: the status paragraph above, this section's stale-by-events sweep, EXPERIMENTAL_OPTIONS session-dial coherence, and lattice §6/§8 dated notes | C2.3, C2.6, C2.9 |

Prerequisite: the feed's session-scoped delivery (F6) lands before C2.6/C2.9
(design §6). Feed status, corrected 2026-07-17 (Fable review): F1–F4 are
landed; the FB1 demotion blocker and its FB8 test-vacuity mask are **fixed
(FW1/FW2, same day)**; the repair wave FW1–FW8 is landed. **F6 is landed
(2026-07-17 — cohort filtering at the dirty-routing layer, see the F6 row;
the C2 prerequisite is met).** CA5 note for C2.9: F6's fixtures prove the
cohort against client-authored scoped commits and lane-held watch surfaces;
the commit-side derivation reads `AppliedCommit.revisions[].scopeKey`, which
the engine stamps for claimed lane commits too, so a server-session-lane
write source inherits the same filter — but C2.9 still owed the explicit
push-side fixture driving a REAL server-session-lane-authored session-scoped
write against a foreign session's watch (CA5's named plane). **Delivered
with C2.9 (2026-07-17):** the "F6 CA5" fixture in `v2-feed-cohort-test.ts`
drives exactly that write source through transact — delivered to the owning
session only, siblings and foreign watchers at zero work — red-verified by
dropping the cohort metadata.

#### C3 — cross-space reads: work-order decomposition (2026-07-17)

**Status — C3 cross-space READS: the CONTROL plane is complete and
verified; the DATA plane has a fundamental hole — the served computation
never receives the foreign VALUE (defect (iii), 2026-07-24).** The C3
control plane works end-to-end and is verified: issuance, cohort-narrowed
delivery, foreign-reader subscription + wake, epoch binding + idle
revocation, the home-apply TOCTOU fence, the vector input basis, and —
new — the client overlay lifecycle (recompute → hold → drop-exactly-once)
bound directly through a real Worker in the composed gate. **But the
composed gate uncovered defect (iii): the served cross-space read is
computed from a MISSING foreign input.** The authenticated foreign point
read (C3.4) lands the document in the executor's `#foreignMounts`, but the
mount is consumed ONLY as provenance (`foreignReadStampsForAction` emits
`{space,id,seq}` for the vector basis, never the value); the Worker's
derivation reads its foreign source through the executor provider, which
is hard-bound to the home space, so the read resolves the home replica
(no foreign value) and folds `Default<0>`. Nothing in the run path
consults the mount / `readForeignDoc` during a run — so a served
cross-space read commits a settlement whose VALUE is wrong (0/default),
and would clobber the client's own correct client-primary value. Every
C3.4/C3.5/C3.6 memory fixture passed because they hand-attach the stamps
and assert on basis/settlement — never on the computed value; the
composed gate is the first to check it. **This is a data-path mechanism
gap (call it C3.13 — served foreign-read value carriage): thread the
served mount VALUE into the Worker's pre-run cross-space read resolution,
respecting the "foreign stamps never merge into home watermarks"
seq-domain invariant.** It was missed by the scout, the C3 adversarial
panel, and every builder — the same hand-attached-fixture blind spot as
defects (i)/(ii), now at the value layer. Scope: core read-path
mechanism, every served cross-space read depends on it, no existing
red-first harness at that layer — owner-scope work, not a targeted fix.
The `cross-space-read` claim-rank stage is flag-OFF by default, so this
is "the feature computes wrong values when enabled," NOT a production
regression; the stage must stay fixture-only until C3.13 lands. The
composed gate binds the control plane + overlay lifecycle directly and
honestly leaves the served-value clause and the co-hosted leg owed.

**(Superseded framing, 2026-07-23) — server-side serve composes
end-to-end; the client reactive half is a DESIGN GAP.** The
mechanism landed C3.1 through C3.10b, C3.11's parent-document closeout
landed, and the composed default-run two-space gate landed
(`server-execution-cross-space-gate.test.ts`). That gate — the first place
a REAL authored pattern executes server-side across the space boundary —
did what the C2.9/C2.10 precedent predicted: it surfaced integration
defects the clause-by-clause fixtures structurally could not, because those
fixtures **hand-attach `foreignReadStamps` on every run** and so never
exercised the real Worker's serve path. Two were found. **Defect (i)
FIXED** (229f7300c): an unadmitted cross-space-read observation (client
read, pre-claim discovery, or unserved rerun) poisoned the durable
`scheduler_context_floor` with a `crossesSpace→session` demotion, which
then fenced the SERVED space-rank claim as `claim-context-mismatch`; the
engine floor writes now exempt the observation's own space-scoped foreign
reads, so the **server serve composes end-to-end** — the gate binds the
committed {home, foreign} vector settlement directly through a real Worker
(`settlementsCommitted≥1`, `claim-context-mismatch==0`). **Defect (ii) —
a DESIGN GAP, not fixed, owned as a follow-on (see below):** the reading
client's foreign-space replica does not resync a read-space change, so the
client never recomputes the derivation, never holds/drops the overlay, and
never suppresses its own run — a cross-space **client-reactivity** gap that
C3.9's synthetic (`PushView`) settlements masked, orthogonal to the C3
execution mechanism. Consequence: the *server* now authoritatively serves
a cross-space read and commits its vector settlement, but the *end-to-end
user-visible* cross-space read (client reacts to a foreign change and
defers to the server) does not yet work; the gate binds the server half
directly and honestly delegates the blocked client tail. Landed WOs:
C3.1/C3.1b protocol substrate + mirror/dirt carriage (f3c4e1e97 /
6d88916ca); C3.2 foreign authorization epochs (d6d58fa5e); C3.3a/C3.3b
foreign wake pipeline + executor-authored mirroring (731e62374 /
e580a4dbb); C3.4 foreign point reads (ccf407a7a); C3.5 vector input
basis + engine relax (73a85df60); C3.6/C3.6b servability stage +
`cross-space-claims-v1` cohort gate (3b9671c9d); C3.7 idle-revocation epoch
binding (4afacbf6d); C3.8 home-apply fence (183c07d1a); C3.9 client
vector-overlay drop (3542cb150); C3.10a/C3.10b co-hosted link + transport
parity + reconnect (e580a4dbb / 4b3f58c7b). Each §7 gate clause is bound
green at the memory + runner integration levels, over BOTH the in-process
and co-hosted transports: the overlay drops exactly once
(`client-execution-overlay-vector.test.ts`, 10/10 — C3A14/C3A15/C3A19);
foreign point reads serve and fail-closed
(`executor-provider-foreign-point-reads.test.ts`, 5/5); idle ACL
revocation revokes (`v2-execution-cross-space-idle-revocation-test.ts` —
C3.7); a read-vs-apply bump settles the whole attempt unserved
(`v2-execution-cross-space-apply-fence-test.ts`, 7/7 — C3.8); and the
wake/point-read/fence/reconnect + cross-space-read claim run identically
over the co-hosted link (`v2-execution-cross-space-cohosted-c3-10b-test.ts`,
6/6 — C3.10b). C3.11's parent-document closeout landed with this status
(README §6.8 → the cross-engine protocol contract; README §9 gap-register
rows G19 geo-distributed transport / G20 per-stamp signatures; the §5 seam
wording host↔host/engines-passive; the §7 sketch-table + §8 R6 register
rows; the C3A19 settlement-metadata owner decision;
EXPERIMENTAL_OPTIONS.md follow-through; `deno task check-docs` green).
**Residuals:** cross-space WRITES are C4 (dual leases + coordinated
commit); the geo-distributed transport (G19) and per-stamp signatures
(G20, the C3A13 deferral) remain undesigned; the C3A19 declare-and-count
vs strip metadata ruling stands as the one open owner decision (§5,
declare-and-count implemented); the C2.10 settlement-latency budget stays
provisional. **C3.12 — cross-space client reactivity (the owned follow-on
for defect (ii), NOT in the original C3 decomposition — surfaced by the
C3.11 composed gate 2026-07-23).** The C3 execution mechanism serves a
cross-space read authoritatively server-side, but a reading client's
foreign-space replica has no live foreign-read subscription driving a
read-space change into the client's reactive graph, so the client does not
speculatively recompute, hold/drop the vector overlay, or suppress its own
run. Isolated at the runner level (two runtimes, a foreign cell, a sink):
the reader's sink fires once at instantiation with the initial value and
never on a later foreign change; an explicit re-sync does not re-fetch.
C3.9's client vector-overlay + suppression were built and unit-verified
against *synthetic* settlements (`PushView`), which never exercised the real
two-space client's foreign-replica reactivity — the same hand-attached-
fixture blind spot as defect (i). This is a **CT-1667-class** client-core
reactivity gap: it is its own work order (client-side live foreign-read
subscription → reactive recompute → overlay/suppression), touches the client
reactive hot path (a "don't break it" surface), and was reviewed by neither
the scout nor the C3 adversarial panel — it should get its own scoping and
review before build. Until it lands, the cross-space-read stage stays
fixture-only (already the C3.6 EXPERIMENTAL_OPTIONS posture); the server
serve is real, the user-visible loop is not. The composed gate binds the
server half directly and delegates the blocked client tail with the reason
recorded in its header. The co-hosted gate leg is likewise owed (blocked by
(ii) on both transports; the transport crossing itself is bound green by the
`v2-execution-cross-space-cohosted*` suites). CI-budget clause (C3A23): the
gate carries a named 90 s ceiling in its file header (actual ~1–2 s).

##### C3.12 — client cross-space reactivity: work-order decomposition (2026-07-24)

**SUPERSEDED 2026-07-24 by the WO-0 diagnostic verdict + gate
reconciliation — the 8-WO subsystem below is STRUCK; kept as the
reviewed record.** The panel made WO-0 a real three-way diagnostic gate
before committing to a mechanism, and it earned its keep: the C3.12.0
diagnostic (`cross-space-reactive-read.test.ts`, 4848705ff) proved
cross-space reactive DELIVERY already works — the origin pushes
third-party space-B commits to the reader's standing B-watch, the
foreign sink refires, the B replica advances, and the derivation
recomputes on a correctly B-keyed invalidation. The scout's "the
foreign replica never resyncs" (defect (ii)) was an untested
architectural inference that conflated the reader's home-A session
(cannot carry B) with its separate B session opened by the crossSpace
kick (does). A follow-up reconciliation against the composed gate's own
pool-served habitat confirmed it end-to-end: with a real Worker, the
reader delivers, recomputes, holds a claimed overlay, and drops it
exactly once — the gate's `claimedOverlayRoutes=0` was caused by the
gate's OWN non-negotiating-attach probe (clause (e)) firing
`#fenceCrossSpaceReadClaimsForNonNegotiatingAttach`, whose space-lane
cohort test over-revokes the reader's own claim host-wide before the B
commit; disabling that one probe block flips the client tail green in
the same gate. **Real remaining scope (targeted, NOT a subsystem):**
(1) isolate the gate's clause-(e) non-negotiating probe from the
clause-(a) assertion (separate reader/space or ordering) so clause (a)
binds directly — demonstrated green; (2) an owner decision on the
space-lane cohort fence's over-revoke posture — in a real mixed fleet
any routing-but-non-cross-space session in the space revokes the
cross-space claim for everyone (this is C3.6b cohort integrity working
as specified — the same stay-off-until-the-cohort-is-uniform staging as
every other rank — but its fragility for cross-space should be recorded
or the fence narrowed/re-issued; server-side, small); (3) confirm
whether a secondary settlement→client-visible-value seam observed with
the claim live (the committed `doubled` stayed 0, co-occurring with a
pre-existing in-process foreign-mount-refresh fail-closed line) is a
real product defect or in-process-harness fragility. C3.12.1s
(server-push) and the whole keep-alive/standing-subscription build
(C3.12.1/.2/.3/.4) are struck as building machinery that already exists.

The reviewed decomposition, for the record:

Scouted (`.agents/c3-12-scout-report-2026-07-24.md`) and adversarially
panel-reviewed
([the review record](../../history/development/design/c3-12-adversarial-review-2026-07-24.md),
CR1–CR10 binding). **Panel rulings (read before building):** the root
diagnosis is CONFIRMED — a real space-B replica *is* opened, its foreign
cell's sink fires exactly once and never on a later B change, and an
explicit re-sync no-ops because the pull dedup treats coverage as
liveness (`storage/v2.ts:3291`); this is a genuine DESIGN gap (the client
analog of C3.3a's server wake subscription, on the client→foreign-host
axis), NOT plumbing, and CT-1667's "materialize-once, accept-staleness"
posture is the mechanism to extend, not reuse-as-is. **The load-bearing
correction (CR2/CR3):** the scout's "B1" silently spans a client layer
(watch torn-down / authority-swallowed / dedup-blocked re-pull) AND a
server-push layer (space B's origin may push no third-party commits to
the reader's foreign session at all — `link-resolution.ts:321` says as
much), and every client-internal probe sits downstream of that boundary
— so **WO-0 must return a three-way verdict {B2 / B1-client / B1-server}
and a B1-server outcome gets an owned server-side row (C3.12.1s), not a
silent gap.** Two owner defaults were corrected: standing-push's rationale
was backwards (wake-and-repull does NOT reintroduce CT-1667 staleness —
it retracts the pull-kick latch exactly as FB7 eviction-rekick already
does), so the push-vs-repull choice is deferred into WO-0's evidence; and
the client-side keep-alive/subscription behavior is gated behind a NEW
client EXPERIMENTAL_OPTIONS flag (CR10) held OFF through 12.0–12.4 —
**the flag is the correctness/containment mechanism that makes the 0→5
order safe, not doc polish.**

Same-space byte-identical is the #1 constraint (CR1): a `space !==
homeSpace` guard is *uncomputable* at the named seams (StorageManager has
no `#homeSpace`; a SpaceReplica knows only its own `#space`), so the
foreign path is threaded from the one seam that has the discriminator —
`crossSpace` at `link-resolution.ts:311/333` — via a manager-owned
keep-alive reservation, and same-space is preserved by simply NOT
emitting foreign dependency edges for same-space reads (no guard needed
at the delivery/scheduler seams). `#docPullKicks` is NOT a target — it is
same-space-only (its sole caller is under `!crossSpace`); `#watchSelectorTracker`
is the foreign re-fetch dedup to back with a standing subscription.

| WO | Title / mechanism | Depends on | Acceptance sketch |
| --- | --- | --- | --- |
| C3.12.0 | **Three-way diagnostic repro** (CR2/CR7): a committed RED test in the two-runtime separate-replica shape (reader holds B READ), asserting the foreign sink fires once today, and a transport-boundary probe returning **{B2** = delivered, no reactive dirty / **B1-client** = deliverable to the session but replica torn-down/authority-swallowed/dedup-blocked / **B1-server** = origin emits no third-party push to the reader's B session**}**. Acceptance stated in OBSERVABLE terms (sink refire count; `doubled` recompute; `pendingCrossSpacePromiseCount()`/`crossSpaceSettled()`, `v2.ts:1743/1747`) — never against private `#` fields; a test-only SpaceReplica accessor is an explicit deliverable if needed. Also answers the read-log keying question (are foreign reads recorded under their own `(space,id,scope)` or normalized onto home — the input to CR5). | — | RED test committed; the three-way verdict + the keying answer decide the rows below |
| C3.12.1 | **Foreign-read replica keep-alive + refcount + the client flag** (CR1/CR10): a manager-owned keep-alive reservation keyed off the `crossSpace` kick (`link-resolution.ts:333`) holds the foreign SpaceReplica + its `#updatePromises`/`consumeUpdates` lifecycle alive while any reactive dependency reads it; refcounted, released on last drop, eviction teardown keyed off the reservation table (NOT the same-space `handleDocEviction`→`retractDocPullKick` path). Introduces the client EXPERIMENTAL_OPTIONS gate, held OFF. | C3.12.0 (client-side verdict) | foreign replica stays open with a live watch + non-empty update-promises after a cross-space reactive read; last-drop releases it; same-space eviction/rekick byte-identical (`fresh-replica-read-asymmetry`, `client-doc-set-watch` unchanged); flag-off ⇒ byte-identical to today |
| C3.12.1s | **(contingent on WO-0 = B1-server)** server-side third-party push to a foreign read session: space B's origin delivers third-party commits to a reader's standing foreign-read watch (the missing server surface `link-resolution.ts:321` names). Only built if WO-0 pins B1-server; otherwise struck. | C3.12.0 | a third-party B commit reaches the reader's B session's watch delivery |
| C3.12.2 | **Standing foreign-read subscription → reactive-dirty delivery** (CR9 boundary; CR5 regression): register the standing watch over the foreign-read docs and wire delivery (`v2.ts:4985`) → scheduler (`facade.ts:2179`, already space-agnostic) so a foreign change marks the dependent derivation dirty; preserve observer-own `(space,id,scope)` keying so the defect-(i) exemption (`engine.ts:7185`) still fires. If WO-0 pinned B2, split into 2a (delivery reaches `processStorageNotification` for B) + 2b (correct-keyed dirty). | C3.12.1 | C3.12.0's sink REFIRES on the later B change and `doubled` recomputes; **no-floor-poison regression:** N successive foreign-driven recomputes leave `scheduler_context_floor` space-rank and a later served claim resolves `executionContextKey=space`, `claim-context-mismatch==0` — through the LIVE client, not a `PushView`; same-space regression guard alongside |
| C3.12.3 | **Client-subscription authority + revocation** (CR4): a home-replica epoch-bump / B-READ-retraction observer tears down the standing subscription + evicts the foreign replica (hands back the CR1 reservation) INDEPENDENTLY of the claim lifecycle, re-checking READ per subscription-driven recompute, fail-closed. `v2-execution-cross-space-{epoch,idle-revocation}-test.ts` are the authority SOURCE, not the acceptance vehicle. | C3.12.2 (co-land or hold behind the flag) | new two-runtime fixture: retract B-READ mid-subscription ⇒ delivery stops, no further recompute, held overlay dropped, fail-closed |
| C3.12.4 | **Overlay hold/drop/suppress on the REAL change** (CR8): the live recompute drives `recordClaimedOverlay`→`captureOverlayForeignBasis` (`v2.ts:5767`) from the now-current replica → holds → drops exactly once on the host's committed vector settlement → suppresses; replace the C3.9 synthetic `PushView` drive with the real path. **Replica-AHEAD leg:** a B change between the speculative run and the host commit makes the first settlement's B component older than the captured basis ⇒ overlay HELD (`settlementCoversOverlay` false, `v2.ts:6290`), a later ≥-basis settlement drops it once, `cross-space-basis-divergence` fires but never blocks. | C3.12.2 (revocation edge C3.12.3) | the composed gate's delegated clause (a): reader recomputes on the B commit, `claimedOverlayRoutes≥1`, overlay drops exactly once, suppresses thereafter — plus the replica-ahead self-healing leg |
| C3.12.4c | **Co-hosted client foreign subscription + reconnect** (CR6, the C3.10a/b-split lesson): the client foreign subscription over `crossSpaceLinkSocketPair`/`CoHostedCrossSpaceTransport`; reconnect re-establishes the standing watch and re-pulls B changes missed during the gap (a reconnect-snapshot fixture analogous to C3A12/C3A14a). | C3.12.4 | the clause-(a) loop green over the co-hosted transport; link-loss→reconnect re-establishes and re-pulls exactly once |
| C3.12.5 | **Un-delegate + flip the flag + doc closeout** (CR6-narrowed): flip clause (a) from delegated to bound in `server-execution-cross-space-gate.test.ts` on BOTH transports; flip the client EXPERIMENTAL_OPTIONS flag ON (only after authority 12.3 lands); update the C3.12 status paragraph + EXPERIMENTAL_OPTIONS posture — the user-visible loop now works. | C3.12.4, C3.12.4c | gate green with clause (a) asserted directly over both transports; `check-docs` green |

Amendment references CR1–CR10 are archived in full in the review record;
build prompts carry the full text for their WO. The composed gate
(`server-execution-cross-space-gate.test.ts`) is the standing red harness
throughout — its currently-delegated clause (a) is the top-level
acceptance C3.12.4/C3.12.5 flip to bound.

Mapped against the landed substrate, which carries more than §5's wording
admits: cross-space read **indexing already exists** —
`scheduler_read_index` rows carry a `read_space` distinct from
`owner_space`, and a client observation that reads foreign spaces is
mirrored into each read space's engine
(`mirrorSchedulerObservation` → `upsertMirroredSchedulerObservation`) —
and cross-space **dirty propagation is already durable**: the committing
engine's mirrored foreign-owner reader rows drive
`propagateSchedulerDirtyToOwnerSpaces`, which marks the home engine's
actions direct-dirty. What does not exist: the demand join and executor
wake (a commit in B never wakes A's Worker), foreign point reads (the
Worker cannot even mount a foreign replica), authorization epochs, and
the vector basis. The panel's blocker corrections re-drew that map
before any of it can be built: both existing mechanisms are **in-process
accidents** — direct writes into the peer engine through an **ungated
`openEngine`** that silently creates a shadow engine for any space name,
with **no protocol carriage** for mirror upserts or dirt (C3A1) — and
the scout's "three reject sites" undercounts: a **fourth, engine-side
reject** (`foreign-space-surface` in `assertLaneScopedAddress`, in force
on both accept paths) blocks every foreign read address and no scout WO
relaxed it, making C3.5's own acceptance unbuildable as written (C3A2).
C2-skew rule: every line anchor was re-verified by the panel against the
C2-waves-A/B tree (`f95d53f22` + the C2.6 diff) and MUST be re-pinned
again at dispatch — C2.7+ is landing on the same surfaces (C3A17
carries the re-pin instruction).

**The adversarial panel (2026-07-17; 24 verdicts — 2 blockers, 15
serious, none refuted — archived in
[the review record](../../history/development/design/c3-adversarial-review-2026-07-17.md),
amendments C3A1–C3A24 binding) corrected the scout in load-bearing ways
— read them before building:**

- **C3A1 (blocker):** C3.1's vocabulary had no carriage for the mirror
  upsert or the durable dirt, so a split deployment silently sheds wake
  and dirt into shadow engines. Owned by new row **C3.1b**
  (`ForeignObservationMirror` upsert + removal, durable-dirt carriage,
  the `openEngine` hosted-space gate).
- **C3A2 (blocker):** the fourth reject site — engine-side
  `foreign-space-surface` — relaxes for space-scoped default-branch
  foreign READs **with C3.5** (that placement is what keeps
  C3.5-before-C3.6 self-contained, V24).
- **Authority holes (C3A3–C3A6):** the epoch bump rule under-covered ACL
  validity-state transitions — implicit-capability holders are
  enumerable in no ACL (C3A3); no read-time authority liveness existed,
  so sponsor rotation / lane drain left in-flight attempts able to issue
  foreign point reads (C3A4); the executor mirror path exists but gates
  on the wrong principal's open session, and fixing it without a B-side
  ACL check is a write-bypass into B — split out as **C3.3b** with the
  acting-principal READ rule and denial fixtures (C3A5); post-revocation
  cleanup of mirrored rows and subscriptions was unowned (C3A6).
- **Wake/fence soundness (C3A7–C3A12):** the co-hosted TOCTOU ruling is
  a forced binary (epoch-hold handshake vs receive-order fence) recorded
  in the table, not deferred to build — a synchronous epoch RPC does NOT
  close the window (C3A7); the C3.8↔C3.10 acceptance circularity breaks
  via the **C3.10a/C3.10b** split (C3A8); three distinct missed-wake
  windows — read-to-mirror, ack-overtakes-propagation, and the pool's
  home-seq suppression gates plus the missed running-Worker provider
  notice leg — each get an owning fixture (C3A9–C3A11); reconnect/replay
  is a named contract, not an afterthought (C3A12).
- **Vector-basis completeness (C3A13–C3A16):** peer-stamp trust is ruled
  now — link-authoritative hosts only, Worker/client stamps stripped,
  per-stamp signatures deferred to a gap-register row (C3A13); three
  fresh-literal settlement carriers would silently drop an additive
  vector (C3A14); missing-component coverage is defined once, vacuously,
  at all three compare/merge sites (C3A15); the mirror upsert's cause
  consumption crosses seq domains until the vector's read-space
  component lands (C3A16).
- **C2-skew (C3A17):** the scout's named build-note collisions
  (C2.1–C2.5) landed — satisfied-and-stale; the live collisions are
  **C2.7** (session-lane wake widening on `#publishAcceptedCommit` — not
  C2.6, whose landed row explicitly leaves wake paths untouched) and
  **C2.8** (`classifyStaticActionServability`, where C3.6 lands).

**Standing scout defaults after the panel (2026-07-17) — all six are
owner-ratifiable defaults following the C2 precedent (adopted for the
build, surfaced in the session; the owner may override):** #1 (protocol
seam at the host↔host boundary — Server↔Server, engines passive)
**adopted**; code-verified that engines are passive substrate and every
cross-space touch lives in `Server`; the promised §5 wording edit is now
owned by C3.11 (C3A21). #2 (epoch granularity/bump rule) **adopted as
amended by C3A3** — the scout's old∪new+ANYONE rule rested on false
support: effective capability is not a function of ACL entries
(missing-ACL grants implicit READ/WRITE to unenumerable principals;
invalid-ACL fails everyone closed), so every ACL validity-state
transition bumps the space-wide epoch floor, bound epochs revalidate by
EQUALITY, and unknown epochs fail closed. #3 (foreign reads
space-scoped-only in v1) **adopted**, restated against the landed
LaneRank machinery per C3A17. #4 (default-branch pairing only)
**adopted**. #5 (client compat gating) **adopted as amended** — the
direction is sound but the blanket (space, branch)-demanding cohort
predates C2.3's deliberate per-cohort refinement, and no row owned the
mechanism: new row **C3.6b** owns `cross-space-claims-v1` with
per-delivery-cohort gating (C3A18). #6 (foreign wake lane symmetry)
**adopted as amended** — a literal mirror of "the A4 shape" would ship
the scoped-lane starvation the decision itself warns against, since the
landed lookup enumerates user grants only; the subscription definition
includes the session-grant arm once C2.7 lands (C3A17).

| WO | Title | Depends on | Acceptance sketch |
| --- | --- | --- | --- |
| C3.1 | Cross-engine protocol substrate at the HOST boundary (Server↔Server, engines passive — decision #1): message vocabulary (`ForeignReadersSubscribe/Unsubscribe`, `ForeignStaleReaders` notice, `ForeignPointRead` request/response carrying resolved seq + authorization-epoch stamp, `ForeignAuthorizationEpochBump`, and the epoch query as a wire message per C3A12) + a `CrossSpaceTransport` interface, with the in-process transport (two endpoints inside one `Server`, FIFO per link) as first implementation; carries the single-multiplexed-link topology ruling if C3A7's receive-order arm is chosen | — | codec round-trip conformance for every message; two spaces in one Server exchange subscribe→notice→point-read over the transport object, never via direct method calls (module-boundary test); transport-parameterized harness reused by every later WO. C3A7, C3A12 |
| C3.1b | Mirror/dirt protocol carriage (blocker C3A1): `ForeignObservationMirror` — upsert AND removal (the `previousReadSpaces` drop path); durable-dirt carriage — either `ForeignStaleReaders` carries the dirtied foreign-owner reader rows (home host applies `markSchedulerActionsDirectDirty` on receipt) plus a subscribe-response dirt snapshot from the read host's `scheduler_action_state` (`owner_space` = home, `direct_dirty_seq` > cursor) covering parked/un-demanded accumulation, or a standalone `ForeignDirtyMark` with a durable per-link cursor; `mirrorSchedulerObservation` / `propagateSchedulerDirtyToOwnerSpaces` route via the transport; `openEngine` gains the hosted-space gate (fail loudly) | C3.1 | mirror upsert/removal and dirt round-trip over the in-process transport with zero direct peer-engine writes; no engine is ever opened for a non-hosted space. C3A1 |
| C3.2 | Foreign authorization epochs: per-(space, principal) generation table bumped transactionally with the ACL apply; bump rule per C3A3 — per-principal old∪new + ANYONE-entry changes + a space-wide epoch-floor bump on EVERY ACL validity-state transition (missing→valid genesis, valid→invalid retraction/malform, invalid→valid repair); comparison discipline pinned: bound epochs revalidate by EQUALITY and an unknown (space, principal) epoch fails closed (a host-restart reset over-revokes, never under-revokes); epoch query + `ForeignAuthorizationEpochBump` published over C3.1 | C3.1 | ACL mutation bumps exactly the affected principals (floor for wildcard AND validity transitions); genesis on a populated ACL-less space revokes a claim bound under implicit access; idempotent apply does not double-bump; bump observed over the transport in commit order. C3A3, C3A12 |
| C3.3a | Foreign wake pipeline (client-mirrored rows only): demand-joined `ForeignReadersSubscribe` registration — per-lane pairs for the space lane plus every OPEN lane grant of either rank (user AND session, the post-C2.7 shape), re-registering on lane-grant open/drain events as well as demand change (C3A17); committing host computes per-foreign-owner lane lookups against its mirrored rows and emits `ForeignStaleReaders`; wake routing per C3A11 — a distinct foreign-wake entry on the pool slot that bypasses the home-seq suppression gates entirely (spurious wakes safe, missed ones not; foreign seqs never merge into `pendingWakeSeq`/`lastSettledSeq`) AND the provider-channel notice leg so a running Worker hears its foreign inputs changed; two-part re-register barrier per C3A10 (subscribe ack emitted after the read host drains post-commit side effects for previously accepted commits; home host completes a post-ack direct-dirty-∩-demand scan with pool wake); closes the read-to-mirror missed-wake window per C3A9 — point-read stamps ride into the mirrored observation with a transactional stamp-vs-current-seq compare in the upsert, or a provisional read-time reader row (C3.4 hook) | C3.1, C3.1b; sequences after C2.7 or coordinates on `#publishAcceptedCommit` (one builder) | B-commit wakes A's demanded stale reader exactly once (barrier-driven, no sleeps); wake fires while A's slot `lastSettledSeq` numerically exceeds B's seq AND while A's executor is mid-run; "B accepts commit K against the stale subscription; the ack races K's queued propagation" bound via injectable barrier on the side-effect queue; B committing strictly between the stamped point read and the mirror upsert still wakes; a session lane grant opened after initial registration still wakes on a subsequent B commit, and a session lane's demanded foreign-read action wakes on a B commit; parked home space accumulates dirt without wake (§4 parity). C3A9, C3A10, C3A11, C3A17 |
| C3.3b | Executor-authored observation mirroring: mirror admitted iff the attempt's ACTING principal (lease sponsor for the space lane; lane principal for user/session lanes) holds READ on the read space via the same `#capabilityFor` resolution as C3.4's point read — replacing the open-session gate for executor commits, which passes on the sponsor's session but checks the wrong principal for scoped lanes and is never true for a headless sponsor (the cold-start wake hole); defines the writer key and cleanup lifecycle for executor-authored rows | C3.1b, C3.2 (epoch stamp on the row) | executor-authored observation mirrors and subsequently wakes; an acting principal without B READ produces ZERO mirror rows and ZERO wake (asserted by direct engine inspection); a scoped-lane mirror gates on the LANE principal's access, not the sponsor's. C3A5 |
| C3.4 | Executor foreign point reads under the acting context: relax the provider space guard for reads only; stop `pinBranch` stamping the home branch onto foreign `docs.read`; forward over C3.1 to the read space's host, where the ACL check runs for the ACTING principal; response stamped (seq, epoch); read-time authority liveness per C3A4 — before forwarding, the home host resolves the acting principal from the LIVE authority (space lane: the current owned lease at the claim's bound `leaseGeneration` with the claim still present; user/session lanes: the live lane grant at the bound `laneGeneration`) and rejects in the constant C1.3 fence-cause shape when any is dead, drained, or superseded — the read-side mirror of `claim-not-live`/`lane-generation-stale`; Worker side: read-only foreign mount keyed by (space, id, scopeKey) via per-space replica mounting — never a space-blind cache (`docKey` has no space dimension) | C3.1, C3.2 | read of a B-space doc through A's lease-bound channel returns the instance with seq+epoch stamp when the acting principal holds READ on B; rejects (constant shape) without it; write/transact naming B still rejects at the same guard; branch is B's default branch; a foreign point read after lease release/rotation rejects; a foreign point read after the owning lane's drain (session disconnect) rejects. C3A4, C3A9 (hook) |
| C3.5 | Vector input basis + the engine-side read relax (blocker C3A2 rides here — what makes C3.5-before-C3.6 self-contained, V24): `assertLaneScopedAddress` admits space-scoped, default-branch foreign READ addresses (summary + observation reads only; write/piece/owner surfaces keep `foreign-space-surface` byte-identical); additive `inputBasis?: readonly {space, seq}[]` beside the scalar (scalar stays ≡ home component, engine-authored as today) on EVERY settlement carrier — `ActionSettlement`/`ActionExecutionProvenance`/`ExecutionSettlementFrontier`, BOTH coalescers (the session-registry frontier updater and runner `mergeSuccessfulExecutionSettlements`), and `actionSettlementFromFrontier` (C3A14); foreign components admissible ONLY when received by the home HOST over the authenticated C3.1 link from the host authoritative for that space — Worker/client-supplied vector components stripped exactly like the scalar, peer-impersonation components discarded, the trust extension stated with its blast radius, per-stamp signatures deferred to a gap-register row (C3A13); missing-component coverage defined once — an absent component vacuously covers, a present-but-older component never does — required identically at all three compare/merge sites (C3A15); mirror cause consumption via the vector's READ-SPACE component (interim, pre-vector: the mirror call passes an explicit `causeCoverageSeq` — C3A16) | C3.4 | settlement for a two-space-read attempt carries home scalar + B component equal to the stamped read seq; foreign WRITE surfaces still reject `foreign-space-surface` (engine-level red-green); a fabricated Worker-asserted vector is stripped; a component for B arriving on a non-B-authoritative link is discarded; frontier merge takes per-component maxima under the vacuous rule; a B-space cause row newer than the home scalar's numeric value survives a mirrored upsert; scalar-only settlements byte-identical to today. C3A2, C3A13, C3A14, C3A15, C3A16 |
| C3.6 | Servability + issuance admission behind the dial's `cross-space-read` stage, specified against the landed LaneRank machinery (C3A17): relax `foreign-read-space` and `dynamic-foreign-read-space` on the LaneRank classifier for space-scoped, default-branch foreign read addresses only (decisions #3/#4; foreign-read admission is rank-independent); new unservable codes (`foreign-read-access-denied`; a named code for scoped foreign reads) registered beside the existing set; `foreign-owner/piece/write-space`, `dynamic-foreign-write-space`, `dynamic-foreign-space` byte-identical; issuance preflight binds the acting principal's foreign READ per read space, naming BOTH `UserLaneGrant` and `SessionLaneGrant` (space lane: current lease sponsor — the rotation "flip" lives here); the dial stage lands as the fourth ORDER entry (`space → user → session → cross-space-read`, implying session per §6); runner-side experimental option (e.g. `serverPrimaryExecutionCrossSpaceReadCandidates`) gating the relax, registered in EXPERIMENTAL_OPTIONS.md with the `experimental-options.test.ts` expected-set update (C3A20) | C3.4, C3.5; sequences after C2.8 or freezes the `classifyStaticActionServability` merge with its builder | foreign-read computation claim-ready at dial ≥ cross-space-read, unservable below; foreign WRITE still rejects at every layer (explicit regression assertions); sponsor without B access ⇒ `foreign-read-access-denied`; after rotation to a B-capable sponsor the action becomes claim-ready (and vice-versa); a session-lane claim gates on the LANE principal's B access, not the sponsor's. C3A4, C3A17, C3A20 |
| C3.6b | `cross-space-claims-v1` subcapability + per-delivery-cohort gating (decision #5 as amended): negotiation with cohort gating mirroring `#sessionAcceptsClaim` — space-lane cross-space claims gate on the (space, branch) routing-negotiating session cohort; user-lane claims on the lane principal's session cohort; session-lane claims on the owning session's own negotiation only (the C2.3 pattern); fence-and-revoke on non-negotiating attach before the open response (A11 shape) | C3.6 | mixed-version fixture: a non-negotiating attach fences cross-space claims before its open response releases; an unrelated principal's non-negotiating session does NOT fence session-lane claims it can never receive. C3A18 |
| C3.7 | Claims bind foreign authorization generations; idle revocation + cleanup: issuance records the bound {(space, principal, epoch)} set keyed to the shared `#executionClaimLaneBindings` map both grant kinds populate (C3A17); an `ForeignAuthorizationEpochBump` (or floor bump) covering a bound entry revokes the claim through the existing revoke path — the §7 "revocation while idle" gate — AND unsubscribes the affected demand pairs + tombstones the corresponding mirrored foreign-reader rows, or carries an explicit recorded owner ruling that residual rows/notices are host-trust-level metadata, counted B.4-style (C3A6); re-issuance re-runs the C3.6 preflight under the new epoch (equality compare, unknown fails closed — C3A3) | C3.2, C3.6 | ACL change on B revoking the sponsor's READ revokes the idle cross-space claim (client observes the revoke and fails open); an unrelated principal's ACL change does not; a scoped-lane claim revokes on the LANE principal's B-access loss, not the sponsor's; after the last authorized reader loses access, B emits no further `ForeignStaleReaders` for that demand. C3A3, C3A4, C3A6, C3A17 |
| C3.8 | Home-apply epoch revalidation (the TOCTOU fence), in-process transport only (C3A8): the accept transaction for a claimed attempt with foreign components revalidates every bound epoch by equality before applying — stale ⇒ the WHOLE attempt settles canonically unserved with a new constant fence cause (`foreign-authorization-stale`), no partial apply, like the engine fence-error family; carries C3A7's forced-binary ruling recorded in this row, not deferred to build: (i) epoch-hold handshake — the apply-time consult is validate-and-pin(attempt, bound epochs) with a bounded TTL, and B's ACL-bump completion awaits release/expiry of covering pins, making §7's "identically over both transports" literally true; or (ii) receive-order fence — a counted divergence metric for post-apply bump arrivals, C3.11 restates §5/§7 as receive-order-relative, and C3.1 carries the single-multiplexed-link ruling; the co-hosted half of the chosen ruling is owned by C3.10b | C3.5, C3.7 | injectable-barrier fixture (C1.10 TOCTOU-backstop pattern — the epoch resolver is injected at the engine seam, `ApplyCommitOptions.resolveForeignAuthorizationEpoch`; wire ordering cannot force this interleaving) lands the ACL bump between the stamped foreign read and the home apply ⇒ attempt settles `unserved`/`foreign-authorization-stale`, no partial apply, client reruns fail-open. GREEN under C3A7 arm **(ii) receive-order fence with a ZERO-WIDTH residual window**: over the in-process transport the C3.2 bump and this fence's read consult the SAME `authorization_epoch` table on ONE event loop, and the home apply's synchronous section admits no interleaving bump — so the in-process fence is EXACT (option (ii) degenerate to zero window, not requiring the (i) epoch-hold handshake). The co-hosted arm (the bounded residual window, or the synchronous-RPC alternative (i)) is C3.10b's; C3.11 folds this fixture in over both transports. C3A7, C3A8 |
| C3.9 | Client vector overlay basis + cross-replica confirmation correlation: overlay basis becomes a per-space vector — home component as today; foreign components captured at overlay creation from the foreign `SpaceReplica`s' confirmed state for the run's foreign read set (plumbed via `StorageManager`); drop rule generalizes per component under the C3A15 coverage relation (absent settlement component vacuously covers; present-but-older never); accepted-data gate stays home-space — the §5 vector divergence window is accepted and COUNTED via a computable comparand: settlement.component(S) > overlay.component(S) at drop time, surfaced as a routeDiagnostics code (C3A19); scalar-only settlements against vector overlays keep today's behavior byte-identically | C3.5 (testable with synthetic settlements, like C1.6) | overlay held while the settlement's B component lags the overlay's B basis, drops when all components cover; both delivery orders (home-data-first, settlement-first) drop exactly once; an overlay held across a reconnect snapshot (frontier-reconstructed settlement) drops exactly once, and settlement-before-claim (early-settlement cache) with a foreign component drops exactly once after merge (C3A14); an authoritative rerun that dropped the foreign read (settlement without the B component) against an overlay holding a B component drops under the vacuous rule (C3A15); divergence counter increments when the revealed value reflects B-state newer than the local B replica; no-foreign-read actions unchanged. C3A14, C3A15, C3A19 |
| C3.10a | Co-hosted link substrate (the genuinely parallelizable part — C3A8): the C3.1 protocol over a link between two `Server` instances, reusing the hello/session-open machinery with a space→host routing table that gates `openEngine` (fail loudly for a non-hosted space — C3A1) and binds link identity to the routing table so host X may only ever stamp spaces routed to X (C3A13); FIFO per link asserted; explicit low-latency/reliable-link assumptions recorded | C3.1, C3.1b | the C3.1 codec/ordering conformance harness green over the link; no engine is ever opened for a non-hosted space; a stamp for a space not routed to the emitting host is rejected. C3A1, C3A8, C3A13 |
| C3.10b | Transport parity + reconnect contract: the wake (C3.3a), point-read (C3.4), and fence (C3.8) fixtures parameterized over the link with identical outcomes — owns the co-hosted half of C3A7's ruling, binding the bump-after-consult-answer interleaving explicitly; reconnect per C3A12 — on re-establishment the home host (a) re-registers all subscriptions from current demand under the C3A10 barrier, (b) pulls a dirt resync from the read host (`owner_space` rows with `direct_dirty_seq` > the durable per-link cursor), (c) resyncs the epoch table before any claim re-issuance; the read host drops subscription state for dead link incarnations; loss detection and unilateral home-side revocation of every claim with a bound epoch on the dead link is the home host's named job | C3.3a, C3.4, C3.8, C3.10a | wake/point-read/fence fixtures green over the link under the chosen C3A7 arm; link loss or consult timeout during the fence fails closed (attempt unserved, claims revoke, never partial); kill link → B commits + B bumps an epoch during the outage → reconnect → the stale reader wakes exactly once and re-issuance under the bumped epoch is refused. C3A7, C3A8, C3A11, C3A12 |
| C3.11 | Two-space gate + parent-doc edits: the §7 C3 gate as a default-run patterns fixture (NOT env-gated — the FB14 lesson), transport-parameterized over the concrete co-hosted harness — in-test second Server linked via C3.10a, client wired through the existing `spaceHostMap` resolver — with an explicit CI-budget clause (own patterns-integration shard or a named runtime ceiling — C3A23); the gate covers BOTH C3.3 halves (C3A5) and C3.6b's mixed-version case (C3A18); the write-path regression list includes the engine's `foreign-space-surface` (C3A2). Docs: README §6.8 replaced by the protocol contract incl. the C3A13 trust statement and co-hosted assumptions; gap-register rows for the geo-distributed transport AND per-stamp signatures; R6 row updated; EXPERIMENTAL_OPTIONS doc-registry follow-through (C3A20); the §5 seam-wording amendment decision #1 promises (host↔host, engines passive) and the §7 sketch-table servability row — the two grep-verified "until C3" sites (C3A21); the C3A19 metadata-channel ruling recorded explicitly (declare-and-count the vector settlement's foreign space-id+seq exposure via a routeDiagnostics counter, or strip foreign components for sessions whose principal lacks READ on that space — owner decision, not shipped silently); doc edits verified in review, and any code blocks added to the spec pass `deno task check-docs` (C3A22 — the scout's "docs-structure CI" does not exist in this repo) | C3.3a/C3.3b, C3.6–C3.10b | the patterns gate green in default CI on both transports: a two-space read chain settles with a vector basis and the client drops the overlay exactly once; idle foreign ACL revocation revokes; read-vs-apply revocation settles unserved; cross-space writes still client-authoritative end-to-end; the mixed-version session fenced. C3A2, C3A5, C3A18, C3A19, C3A21, C3A22, C3A23 |

Build notes (rewritten per C3A17): the scout's named C2 collisions
(C2.1/C2.2/C2.3/C2.5) all landed — satisfied-and-stale. The live ones:
**C3.3a sequences after C2.7** or coordinates on `#publishAcceptedCommit`
(one builder) — C2.7, not C2.6, owns the session-lane wake widening;
**C3.6 sequences after C2.8** (itself sequenced after C2.9–C2.10) or
freezes the `classifyStaticActionServability` merge with its builder.
C3.3a + C3.5 share the `server.ts` publish path — one builder,
sequential patches, C1-style; C3.2 + C3.7 share the ACL/claims surfaces.
Before ANY C3 WO enters build, re-emit the table's
`server.ts`/`engine.ts`/`v2.ts`/`servability.ts` citations against the
then-current tree and carry the re-pin table as a scout-report appendix
so build prompts inherit correct lines (C3A17). One line for future
drift-guarding: `ForeignStaleReaders` is an executor-plane message with
no session-delivery leg — F6 cohort metadata is deliberately out of
scope for the foreign wake (C3A24).

Amendment references (C3A1–C3A24) are the adversarial-review amendments,
archived in full in
[the review record](../../history/development/design/c3-adversarial-review-2026-07-17.md);
build prompts must carry the full amendment text for their work orders.

Prerequisite: C3 build starts after the **C2 exit gate** — C2.8, per the
owner's 2026-07-17 ruling (itself sequenced after C2.9–C2.10). The two
blockers' protocol-carriage work (C3.1/C3.1b) may prototype earlier — it
touches no contended C2 surface — but nothing enables outside fixtures:
every WO lands dark behind the dial's `cross-space-read` stage until
C3.6, and nothing ships before C3.11's gate.

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
