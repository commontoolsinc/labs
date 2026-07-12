# Server-Primary Execution — Implementation Plan

Companion to [README.md](./README.md). Read the design first; this plan turns
it into reviewable, red-green work orders.

Status: executable plan for the scheduler prerequisite and client-driven
server-primary execution. Later background, feed, scoped, and handler work is
outlined only.

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
  record the resulting dependency.
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
- **executionPolicy:** optional owner-managed space policy expressing only
  whether server-primary execution is allowed. It does not contain liveness,
  actor, epoch, authority, or unservable-piece state.
- Runtime experimental option: serverPrimaryExecution, default false.
- Existing scheduler option: persistentSchedulerState, default true; explicitly
  setting it false remains the rollback path.
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

    Later:
      Phase 3 background demand and feed narrowing
      Phase 4 scoped execution with delegated keys
      Phase 5 server-directed handler events and enforced authority

Parallelizable start set after #4288: W0.1, W0.2, W0.4, W0.5, W0.6.

---

## 2. Phase 0 — prerequisites and protocol substrate

### W0.1 — Qualify durable scheduler state by effective execution context

**Priority:** first standalone prerequisite. It may be folded into #4288.

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

- [ ] Red→green headline: Alice and Bob run the same PerUser action; both
      snapshots, action-state rows, read rows, and write rows remain present
      and independently rehydrate.
- [ ] Two sessions for one principal retain distinct PerSession metadata.
- [ ] Alice's scoped write dirties Alice's matching reader and not Bob's.
- [ ] Running or clearing Alice's dirty action does not clear Bob's state.
- [ ] A proven space-only action has one shared row that either principal can
      rehydrate.
- [ ] A dynamic `space`→`user` or `user`→`session` violation cannot leave a
      broadly adoptable snapshot; the incompatible broader row is removed and
      the next runtime fails open by running.
- [ ] Observed space-only behavior without a complete static summary remains
      session-keyed; it cannot promote itself to a shared row.
- [ ] Narrowing Alice's user row never removes Bob's independent user/session
      row.
- [ ] Existing space-only persistent scheduler tests remain green.
- [ ] Query plans still use indexed target lookup at 10k rows.

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
5. Replace an action's dynamic write rows on re-observation; never accumulate
   stale targets.
6. On an index miss, fail open to piece-root instantiation and discovery. Do
   not infer producer from the target document's creator.

**Success criteria:**

- [x] A direct result target returns its producing action from the durable row
      after observation and from the live static surface before first run.
- [x] A side-write target and materializer target return the correct action.
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

1. Track the revision sequence actually observed for every effective read. For
   this same-space phase, inputBasisSeq is the maximum consumed same-space
   revision sequence, or zero for no durable reads. Do not substitute current
   head or accepting commit seq.
2. Define ActionExecutionProvenance with:
   - ActionClaimKey;
   - onBehalfOf user DID;
   - execution lease generation;
   - claimGeneration when the action is claimed;
   - causedBy source commit sequence(s), when known;
   - inputBasisSeq.
3. The host derives onBehalfOf from the authenticated sponsor lease and
   overwrites/rejects any worker- or client-supplied value. It means
   server-executed on behalf of this user, not semantic authorship of every
   input.
4. Carry provenance through the normal validated transaction path and store it
   with scheduler observation/commit diagnostics.
5. Separate acceptedCommitSeq from inputBasisSeq in types and tests.
6. Add ActionSettlement emission for committed, no-op, failed, and unserved
   attempts. Settlement names the exact leaseGeneration + claimGeneration and
   inputBasisSeq. A committed settlement must carry acceptedCommitSeq; no-op
   has no data commit. Emit either only after the normal confirmed-read
   validation accepts the corresponding data or observation-only transaction.
7. Co-order data patches and settlements on the session feed. A client may
   apply a committed settlement only after its confirmed/feed cursor reaches
   acceptedCommitSeq. No-op settlement follows the accepted observation-only
   transaction in that ordered stream.
8. Do not add persistent scheduler observations for handler runs in this phase.
   Handlers remain client-authoritative, their read sets do not participate in
   server-primary wake indexes, and existing event/source commit provenance
   remains unchanged. Phase 5 owns any handler-observation contract; handler
   semantic authorship remains the authenticated event sender.

**Success criteria:**

- [ ] An action reading an old revision while unrelated newer commits exist
      records the old consumed basis, not head.
- [ ] Two consumed inputs at S1 and S2 record max(S1,S2).
- [ ] A no-op claimed action emits a settlement with its real basis despite
      producing no data commit.
- [ ] A committed settlement cannot clear an overlay before the client has
      applied the acceptedCommitSeq data patch, including forced reordering.
- [ ] Commit seq and input basis are independently asserted and cannot be
      accidentally interchanged by type/API.
- [ ] The store/control event records the sponsor user as onBehalfOf.
- [ ] A forged onBehalfOf from worker IPC or a client is rejected/overwritten.
- [ ] Cross-space input attempts are rejected by W1.3 rather than collapsed
      into this scalar.
- [ ] Handler execution emits no new scheduler observation in this phase and
      preserves existing authenticated event/source provenance.

---

### W0.5 — Authenticated in-process provider without an Engine bypass

**Depends on:** #4288.
**Unblocks:** leases and executor Workers.

**Status:** provider substrate implemented. Atomic ExecutionLease fencing is a
W1.1 integration criterion because the lease record and compare-and-swap
generation do not exist before that work package.

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
4. Bind the provider channel to an exact space, branch, and opaque executor
   principal. W1.1 supplies the current ExecutionLease and fence generation
   and adds their atomic validation to the canonical commit path.
5. Preserve remote and in-process behavioral equivalence with a differential
   fixture, including scheduler observations and rejected commits. Compare
   exact user operations/data, then normalize legitimate session ids,
   sequences, and transport metadata before comparing scheduler semantics.
   W1.1 extends the fixture with lease generation and host-derived provenance
   assertions once those fields exist.
6. Ensure provider disposal unregisters callbacks and cannot outlive its lease.

**Success criteria:**

- [x] Differential fixture produces identical user operations/data and
      normalized-equivalent scheduler semantics through remote/loopback and
      host-provider paths; expected session/transport differences are asserted
      explicitly.
- [x] ACL denial, CFC denial, and conflict produce the same atomic rejection
      shape with no partial apply.
- [ ] A revoked/fenced lease produces the same atomic rejection shape with no
      partial apply. Deferred to W1.1, which defines and validates the lease
      record and generation in the canonical transaction.
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

**Status:** implemented. The base protocol and demand feed are production-dark
behind `serverPrimaryExecution`; authoritative computation routing and builtin
passivity remain independently absent-false until W2.1 and W2.3.

**Read first:**

- docs/specs/memory-v2/04-protocol.md
- Memory-v2 session handshake/version negotiation
- Current piece watch/pull registration and session control ordering
- docs/development/EXPERIMENTAL_OPTIONS.md

**Steps:**

1. Add capability negotiation for server-primary-execution-v1. When a
   deployment/space requires server-primary semantics, reject clients that do
   not advertise the capability; do not silently mix stale authority rules.
2. Add session.execution.demand.set. A demand is bound to the authenticated
   connection, branch, space, and piece result roots. Replacement and disconnect
   remove that connection's references automatically. Host listeners receive
   `{space, branch, order, demands}` so the last empty snapshot remains
   actionable. Demand remains policy-independent for Phase 1 shadow execution.
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
   for control ordering.
6. Authorize demand using the session's existing READ access. Sponsor
   eligibility is a separate WRITE check in W1.1.
7. Add optional executionPolicy owner doc support at
   `of:${space}:execution-policy`, default branch and space scope, with exact
   value `{version:1,serverPrimaryExecution:boolean}`. It only opts a space
   into server-primary execution; absent/deleted/disabled/malformed means
   client-primary. Mutations are owner-only, whole-document set/delete,
   policy-only commits; direct host writes cannot bypass that rule. Enabling is
   rejected while an incompatible session remains attached. Do not put claims,
   actor identity, heartbeat, exception lists, or epochs in it.
   OWNER remains mandatory when ordinary ACL checks are off/observe; because
   ACL mutation is rollout-relaxed there, only implicit space/service owners
   qualify. Positive claims require the effective policy; disabling/deleting
   it revokes all live claims without suppressing shadow demand.
8. Gate all messages behind serverPrimaryExecution, default off.
   Negotiate absent-false `serverPrimaryExecutionClaimRoutingV1` and
   `serverPrimaryExecutionBuiltinPassivityV1` sub-capabilities while the WOs
   land; a server publishes only the claim classes the client says it can
   honor. Ordinary builds keep them false until W2.1 and W2.3.

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
- [x] Expiry or policy disable publishes revoke, removes live/snapshot
      authority, and rejects stale settlement.
- [x] A committed settlement delivered before its data frame is buffered until
      the acceptedCommitSeq patch is applied.
- [x] Reconnect neither double-delivers retained control events nor replays a
      claim class excluded by the session's current sub-capabilities.
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
   expiry, sponsor authorization, and executionPolicy immediately before apply.
5. Renew with server time while demand/in-flight work exists. A heartbeat
   document is not a lease and must not be introduced.
6. On sponsor disconnect/revocation, allow a bounded drain of already-started
   work, revoke the lease, and restart under another eligible requester if
   demand remains. No old/new overlap is allowed.
7. Provenance records onBehalfOf and worker generation. Future user-delegated
   keys can replace the session-derived lease without changing that semantic.

**Success criteria:**

- [ ] One requester yields one valid lease and commits marked onBehalfOf that
      user.
- [ ] Two hosts racing acquire produce one winner; loser cannot commit.
- [ ] A delayed commit from generation N is rejected after generation N+1
      begins.
- [ ] Sponsor loses WRITE or disconnects: in-flight boundary is deterministic,
      old Worker is fenced, and remaining demand restarts under another user.
- [ ] A READ-only requester can demand data but cannot sponsor writes.
- [ ] With only READ-only demand, no worker claim appears and current client
      behavior continues unchanged.
- [ ] No user private key enters Worker memory or IPC.

---

### W1.2 — Shared demand pool: one Worker per eligible active branch/space

**Depends on:** W0.6, W1.1, W0.1.
**Unblocks:** W1.3.

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
   From the first pull, enforce shadow mode: apply computation results only to
   the Worker's private replica for graph discovery, reject every upstream
   derived commit, and deny all external builtin broker calls. Source/handler
   work is not injected into this runtime.
3. Register post-commit buffering before initial load. Worker reports live at
   seq S; release buffered notifications after S so spawn has no gap.
4. Demand exact piece result roots with pull-per-wake. Do not install a
   schema-less standing sink. Scheduler-v2 deduplicates overlapping client
   demand inside this single scheduler.
5. Demand changes update the union without restarting unless sponsor context
   must rotate. Empty demand begins bounded drain/hibernate.
6. Isolate Worker crashes, back off, and discard CandidateClaims before retry.
7. Add a mandatory legacy-background exclusion interlock without refactoring
   its registry: if background-piece-service has a registration, active
   controller, or lease for the branch/space, do not launch the new pool slot
   and publish no claim. Existing background behavior continues. Phase 3
   imports that demand into the shared slot and removes the exclusion.

**Success criteria:**

- [ ] Ten clients demanding the same piece produce one Worker, one scheduler
      action run per invalidation, and ten reference-counted demands.
- [ ] Disjoint roots from two clients run in the same space Worker and only
      demanded closures stay live.
- [ ] Closing one client does not remove another's demand; closing the last
      drains and terminates.
- [ ] Commit during spawn buffering is observed without a second wake.
- [ ] Worker crash discards CandidateClaims (and revokes any test-only claims)
      before restart and leaves other spaces unaffected.
- [ ] An unrelated document write causes zero pulls/action runs.
- [ ] Every ordinary shadow pull produces zero server data operations and zero
      external builtin calls while still collecting local graph observations.
- [ ] Concurrent legacy background registration plus client demand starts no
      second server Worker and publishes no server-primary claim.

---

### W1.3 — Whole-action servability, firewall, and claim readiness

**Depends on:** W0.2, W0.3, W0.4, W1.2.
**Unblocks:** Phase 2 and async serving.

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

- [ ] Same-space pure computation becomes claim-ready in ordinary shadow mode
      with zero server data commits.
- [ ] The explicit test capability claims that computation and commits
      server-derived output under its sponsor.
- [ ] Mixed space+user writes abort as one transaction; zero operations apply;
      claim is absent/revoked; client execution commits the complete result.
- [ ] Cross-space read or write aborts before apply and remains client-primary.
- [ ] Dynamic scope change after a claim revokes it and converges via client
      rerun without data loss.
- [ ] First-run index miss safely instantiates/discovers the piece.
- [ ] Pre-existing redirected output is served through writer-index identity,
      not creation source.
- [ ] No-op produces settlement and leaves no stuck overlay prerequisite.
- [ ] CFC/ACL denial is not converted into servability or a trusted shortcut.

---

### W1.4 — Server async builtins and egress policy

**Depends on:** W1.3.
**Unblocks:** W2.3.

**Scope:** fetch-family and generate-family builtins. Full quotas, a durable
async ledger, rigorous idempotency, and delegated execution keys are later
hardening. This WO must not make network reach or duplicate behavior worse than
the client runtime.

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
   and receives the full policy.
6. Route generate-family calls through configured provider policy/credentials;
   never inherit arbitrary client secrets from the demand payload.
7. For identity-sensitive first-party requests, derive the request actor from
   the authenticated commit that produced the request and require it to match
   the current lease sponsor. Never sign as an unrelated sticky sponsor. A
   mismatch is unservable in v1 or triggers a fenced sponsor handoff; dynamic
   per-action actors are later work.
8. Claim a builtin before clients become passive. Transient failure remains a
   server-owned pending/retry according to existing builtin semantics;
   permanent policy/servability failure revokes and settles explicitly.
9. Preserve existing cross-runtime mutex/result guards as defense in depth.
10. Keep async claim publication dark until W2.3 builtin passivity is deployed
   and negotiated by every participating client session.

**Success criteria:**

- [ ] Relative /api/... reaches the configured serving host in local and
      deployed fixtures.
- [ ] A relative request may follow an absolute same-serving-origin redirect;
      an origin-changing redirect is reclassified and blocked when private.
- [ ] Absolute localhost/private/metadata URLs are blocked, including DNS and
      redirect rebinding cases.
- [ ] Raw fetch remains unavailable in a pattern SES test.
- [ ] Supported fetch and generate actions execute once on the claimed server
      path in a multi-client fixture.
- [ ] A request produced by user B is never signed/executed as sticky sponsor A;
      it stays unclaimed or performs a fenced handoff.
- [ ] Unsupported builtin/action stays client-primary without first causing an
      external request.
- [ ] Claim loss/crash behavior is no worse than today's client mutex tests.

---

### W1.5 — Indexed wake, drain, and hibernation

**Depends on:** W0.3, W1.3.
**Unblocks:** efficient rollout.

**Steps:**

1. Expose an indexed staleReadersForTargets query qualified by effective target
   scope and execution context. Return distinct demanded actions/pieces.
2. While a Worker is live, push changed target batches and pull only stale
   demanded roots.
3. When the last demand disappears and no async work remains, await
   runtime.settled(), record last-settled seq, release claims, release lease,
   close provider callbacks, and terminate.
4. During drain, buffer commits. New demand or a relevant commit before final
   release cancels drain or starts a later generation after fencing.
5. Demand itself wakes a cold space. A source commit wakes it only while a
   durable/active demand reference exists; background wake arrives in Phase 3.
6. Emit counters for worker count, wakes, suppressed unrelated commits,
   action runs, claim churn, and settle latency.

**Success criteria:**

- [ ] Relevant write wakes/re-runs only its demanded readers.
- [ ] Unrelated write performs one indexed lookup and no Worker/action work.
- [ ] Commit in the settle→terminate window is not lost.
- [ ] Rapid commits and demands coalesce without duplicate Worker generations.
- [ ] Cold resume rehydrates only context-appropriate scheduler rows.

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
   stream discards affected overlays, marks actions dirty, and resumes
   committing from the next settle.
7. Connection loss is not evidence that authority returned: keep claimed
   derived writes local/speculative and do not enqueue them upstream. On
   reconnect, complete capability negotiation and apply an authoritative full
   claim snapshot for the exact branch at a feed-sequence barrier before
   flushing any derived work. Source/handler/UI commits retain their existing
   offline queue behavior.
8. Keep clients trusted in v1: protocol tests pin compliance; CFC/server
   enforcement arrives later.

**Success criteria:**

- [ ] Claimed pure action produces local UI output but zero derived client wire
      operations.
- [ ] Unclaimed action produces byte-identical commits to current behavior.
- [ ] Mixed-scope claimed action commits whole from client; no partial
      suppression.
- [ ] Two actions in one piece can independently be server- and client-primary.
- [ ] Identical action identities on two branches route independently; a claim,
      revoke, reconnect snapshot, or settlement on branch A never affects
      branch B.
- [ ] Revocation/expiry causes deterministic dirty rerun and convergence.
- [ ] Disconnect while another client keeps the server claim live queues no
      derived wire commit; reconnect claim-snapshot barrier prevents a stale
      flush and then converges.
- [ ] Flag off has byte-identical commit and control traffic.

---

### W2.2 — Settlement-driven overlay reconciliation

**Depends on:** W0.4, W2.1.

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

- [ ] Direct source read at S → local overlay → server settlement basis ≥ S →
      overlay is physically removed only after acceptedCommitSeq is locally
      confirmed; the confirmed value remains.
- [ ] Settlement basis < S retains overlay.
- [ ] A no-op settlement clears the overlay.
- [ ] Two rapid source commits require settlement through the later basis.
- [ ] Old generation cannot clear new overlay.
- [ ] Delayed/reordered commit data keeps the overlay until the matching data
      frame is applied; settlement-first delivery cannot flash stale state.
- [ ] A chained-action fixture demonstrates the accepted non-transitive basis
      window, records divergence, and deterministically converges after the
      intermediate and downstream actions re-settle.
- [ ] Rigged divergence records one event and shows server value.
- [ ] Rejected source basis discards and recomputes correctly.

---

### W2.3 — Client builtin passivity per claim

**Depends on:** W1.4, W2.1, W2.2.

**Steps:**

1. A client builtin action becomes passive only for an exact supported live
   claim. It renders pending/result from local overlay and confirmed feed.
2. Missing/revoked claims preserve today's client claim/mutex behavior.
3. Do not use a worker heartbeat as authority. Claim generation and lease-backed
   settlement are the signal.
4. Server transient failure keeps clients passive while the claim is valid;
   permanent failure revokes and releases them.

**Success criteria:**

- [ ] Three clients plus one server claim produce one external request.
- [ ] Pending→result UI transition arrives through overlay/feed.
- [ ] No claim behaves identically to current client builtin execution.
- [ ] Permanent revoke releases client work without busy waiting.

---

### W2.4 — Measurement and opt-in rollout

**Depends on:** W1.5, W2.2, W2.3.

**Deliverable:** perf fixtures, operational metrics, and an enable/disable
runbook using serverPrimaryExecution plus optional executionPolicy.

**Measure:**

- active demands, workers, sponsor rotations, and fenced rejects;
- per-action claims/revocations/unserved reasons;
- client vs server action runs and derived commits;
- derived conflicts and divergence;
- feed/settlement latency and overlays retained;
- async requests by role;
- hibernation/wake latency.

**Success criteria:**

- [ ] Multi-client lunch-poll/group-chat fixtures approach one server action run
      per invalidation and zero client derived wire writes for claimed actions.
- [ ] Unclaimed/scoped/cross-space actions remain behaviorally identical.
- [ ] Enabling then disabling a staging space converges without data migration.
- [ ] Kill/restart/sponsor-loss drills demonstrate fail-open authority and no
      duplicate worker commits.
- [ ] Browser compute and lazy-client CPU are measured; first rollout is at
      least no worse, with later suppression optimization tracked explicitly.

---

## 5. Later phases — do not pull into the first implementation

### Phase 3 — background demand and narrower feeds

Client demand is P1. Background registry cleanup is lower priority.

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
5. Add a separately gated client-compute suppression mode only after the claim
   snapshot and closure are complete: a client may leave a remotely owned
   action cold until local dependency or handler speculation demands it.
   Measure first-paint and interaction regressions. This later work removes N×
   client compute; the initial authority split removes duplicate writes and
   external effects, not local speculative computation.

### Phase 4 — scoped execution and delegated user keys

Entry requires a separate reviewed design for:

- principal/session-qualified runtime and replica contexts;
- one shared space lane plus per-user and per-session lanes without duplicating
  unscoped computation;
- scope-monotonic read/write rules;
- bounded user-delegated execution keys that survive connection loss;
- context-qualified claims, indexes, wake, and cross-space permission changes;
- vector input bases if cross-space actions are admitted.

The W0.1 context-key fix is necessary but not sufficient for this phase.

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
8. **No implicit authority docs.** executionPolicy is opt-in only. Claims,
   leases, heartbeats, actors, and unservable lists do not belong in ordinary
   writable space state.
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
- executionPolicy is optional opt-in only; positive per-action claims control
  authority.
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
