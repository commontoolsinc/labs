# Server-Primary Execution

Status: Phases 0–2 are implemented behind the default-off flag. W2.4's product
and deterministic failure gates are locally validated, including the accepted
500-event counterbalanced browser/CPU gate. The deployed-staging enable/disable
drill remains pending. Phases 3+ remain design. Terminal crash quarantine and
hard pool resource caps are later operational hardening tracked as G18, not
part of the Phase 0–2 acceptance contract.
Author: design session
2026-07-06; revised 2026-07-07 (doc-centric demand, SQLite-primary state,
transient executor passes, reactive interpreter de-scoped); revised
2026-07-11 after implementation review (scheduler-v2 as the base, user-
sponsored shared workers, positive per-action authority, writer-index
producer lookup, scope-safe fallback, causal settlement acknowledgements,
and server egress parity); revised 2026-07-12 after Phase 2 implementation and
local rollout validation; revised 2026-07-13 after the parked-worker wake,
causal-actor, permanent-builtin-failure, bounded-observability, and accepted
500-event browser/CPU follow-ups.
Completed work-order status is
recorded inline; unimplemented phases remain design requirements rather than
descriptions of current behavior. Operator procedure lives in the
[server-primary execution runbook](../../development/server-primary-execution.md).

Related specs: `docs/specs/scheduler-v2/`,
`docs/specs/persistent-scheduler-state.md`,
`docs/specs/content-addressed-action-identity.md`,
`docs/history/specs/pattern-id-retirement.md`, `docs/specs/memory-v2/`,
`docs/specs/toolshed-access-control.md`, `docs/specs/cfc-write-prefix-provenance.md`.
Related PRs: #4288 (scheduler-v2 cutover, assumed baseline);
#4495 (conflict catch-up, landed); #4139 (seq-token draft), #4115
(closeSpace), and #2659 (per-space LLM throttling) remain in flight.

---

## 1. Summary

Without the opt-in, the memory server remains central but passive: every client runs the full
reactive graph of every open piece, and clients race each other — N clients
means N redundant executions of the same computations, write-write conflicts
on shared derived state, async work (fetch, LLM) that dies with a closed tab,
and a per-session subscription machinery whose cost is
O(commits × sessions × graph-query re-evaluation) on the server.

This document designs the inversion: **the server becomes the primary
executor for positively claimed actions**. Clients send updates originating
from user intent, speculatively execute server-claimed derivations locally
for latency, and keep committing every action the server has not claimed.
One shared worker per eligible active space unions the demand of every
connected client, executes on behalf of one eligible requesting user,
performs async work, and feeds changes back to all clients. Until legacy
background demand is unified, those owned spaces are excluded rather than
given a second server runtime. The first iteration treats
capability-compatible clients as trusted participants; a required handshake
rejects clients that do not understand the authority protocol. Later server
admission and CFC work may make the split adversarially enforceable.

A third motivation joins races and cost: **trust asymmetry** — the server is
more trustworthy than any client, so executor-computed results can eventually
form the basis for downstream integrity guarantees. In v1, however, the
important identity fact is narrower and concrete: each server execution is
attributable as `onBehalfOf` an authenticated user. A future delegated user
key can strengthen that authorization without changing the execution model.

Four approaches are explored in depth:

- **A — Server catch-up executor**: run a server participant while clients
  remain authoritative. Low risk, helps async fragility, does *not* kill
  races. It remains a useful diagnostic mode, but background-registry cleanup
  is not on the critical path.
- **B — Positive derived-authority split** (the proposed model): the server
  claims eligible actions individually; clients commit event-driven writes
  and every unclaimed action, while speculative results for claimed actions
  stay in a never-committed overlay. Authority fails open to the client.
- **C — Event shipping**: clients ship signed event envelopes; the server
  runs handlers too, authoritatively, while clients keep running them
  speculatively. Total per-space serialization; largest protocol and
  identity lift; adopted as the end-state for events.
- **D — Thin projector**: no client execution at all; the server computes
  everything including VNode docs; clients materialize DOM.

**Recommendation: fix scheduler-state context keys on top of #4288, build
the shared client-demand executor in shadow mode, then adopt B one eligible
action at a time.** B matches the product need: races disappear for claimed
derived data, async survives a tab closing, and clients retain instant local
feedback. Positive `ExecutionClaim`s make fallback local and structural:
absence or revocation of a matching claim means today's client-authority
behavior. Background-only execution remains a lower-priority identity mode;
event shipping and rigorous delegated authorization follow after the core
data path works end to end.

The load-bearing base is #4288: scheduler v2's demand-driven facade,
reload-stable action identity, bounded settle, static write surfaces,
read-delta bookkeeping, and persistent scheduler state. Before the server
uses those tables as authoritative coordination state, their action keys
must include the effective space/user/session context (§3.2.1). Producer
recovery uses `scheduler_write_index` joined to durable action state, not a
document's creation provenance (§3.3). Execution density comes from the
SQLite-primary state model (§6.7): idle spaces cost no runtime memory and
workers can be transient. §9 records the remaining gaps.

---

## 2. Today's topology and what it costs

### 2.1 Execution: N clients × same graph

Each browser tab boots one runtime per (identity, apiUrl) in a web worker
(`packages/shell/src/lib/runtime-lifecycle.ts:8`,
`packages/lib-shell/src/runtime.ts:527`). The space root pattern is the
canonical demand root (`packages/lib-shell/src/runtime.ts:240`); navigated
pieces start on demand (`getPattern(space, id, { start: true })`). Every
client runs the *entire* reactive graph of every started piece: computations,
materializers, render effects, and async builtins.

Consequences, all previously measured:

- **Redundant compute.** Two tabs on the same space run every lift/computed
  twice. The multi-user perf baseline records ~+19% action volume from a
  second participant on group-chat-scale patterns even after coalescing
  work; the pre-#4237 lunch-poll write-write ping-pong was the same shape at
  its worst.
- **Races on derived data.** Both runtimes write the same derived docs.
  Conflicts are cheap now (seenSeq-gated refresh, commit `5abe477c7`), but
  they still ratchet under multi-browser load and burn retries; the
  cross-tab mutex machinery inside async builtins
  (`packages/runner/src/builtins/fetch-utils.ts:90`) exists only to paper
  over exactly this.
- **Async fragility.** fetch/LLM calls run in whichever tab claimed the cell
  mutex; a closed tab aborts the request
  (`packages/runner/src/builtins/fetch.ts:312`) and someone else may re-claim
  after a 5s–5min timeout. Streaming LLM partials live in an in-memory
  `partial` cell and are lost on disconnect.
- **Cold start.** A fresh client cannot paint pattern UI until it compiles
  and executes patterns locally (browser cold-compile floor ≈ 525ms for the
  entry-file emit alone, plus dependency collection and first settle).

### 2.2 Subscriptions: per-session graph re-evaluation

The wire is a WebSocket session (`session.open` with a signed challenge;
per-space ACL `OWNER/WRITE/READ`). Clients register *graph queries* via
`session.watch.set`. On every commit the server marks the space dirty and,
after `SUBSCRIPTION_REFRESH_DELAY_MS = 5` (`packages/memory/v2/server.ts:92`),
walks all connections × sessions whose watch is affected and **re-runs each
session's graph query** against live state
(`refreshTrackedGraph`, call site `packages/memory/v2/server.ts:2224`,
imported at :67). There is no
query-result caching; cost is O(dirty commits × affected sessions ×
graph-traversal). This is the cost the redesign wants to remove — and it is
also *duplicated* state: the query describes the client's dependency
closure, which the client's own scheduler already knows, and which a
server-side executor would know natively.

### 2.3 What already points the right way

- The client write path is already optimistic: handler transactions apply
  locally before the server confirms; conflicts retry with a budget
  (`packages/runner/src/scheduler/events.ts:715`). "Speculate locally,
  confirm remotely" is the existing model — it just applies to *all* writes
  instead of only source writes.
- The commit protocol already carries read provenance
  (`ClientCommit.reads.confirmed = (id, path, seq)` and
  `pending = (id, path, localSeq)`), and replays are idempotent by
  `(sessionId, localSeq)` (`docs/specs/memory-v2/03-commit-model.md` §3.6).
- `background-piece-service` already runs a runtime per space in a **Deno
  Worker thread** (`packages/background-piece-service/src/worker-controller.ts:78`),
  discovered reactively from a registry cell, under a single service
  identity. It is a lifecycle/isolation precedent for the executor pool (§6),
  not its registry or discovery substrate: bps-owned spaces are excluded from
  the client-demand pool until Phase 3 unifies their demand. Today bps remains
  limited to a ~60s polling updater and websocket transport back to the same
  host.
- Server-initiated writes into spaces exist and pass CFC: webhook ingest
  (`POST /api/ingest/:id` with `externalIngestStamp`) and the sqlite
  builtin's server-executed query + result writeback.
- The store is fast and co-locatable: reads are synchronous FFI (~2µs;
  JSON decode dominates for large docs), and an in-process transport exists
  (`loopback`, `packages/memory/v2/client.ts:1299`;
  `StorageManager.emulate()`, `packages/runner/src/storage/v2-emulate.ts:36`).

---

## 3. Foundations assumed to land (and what each contributes)

This design builds on #4288. It does not preserve compatibility with the
pre-cutover scheduler. Each subsection notes residual gaps on that base; the
consolidated register is §9.

### 3.1 Scheduler v2 (#4288, phases 3c–7)

Implemented by scheduler v2 (#4288): durable event IDs, speculation lineage, static write
surfaces, tx-carried source action, node records and liveness refcounts,
unified gates, declared reads, read-delta tracking, persistent action state,
and bounded settle (`PASS_RUN_BUDGET = 10`).

Contribution: a scheduler whose per-node state is one record
(status/liveRefs/reads/writes), whose demand is refcounted rather than
walked, and whose settle loop is bounded — i.e., a graph that can be
suspended, described, and resumed. That is precisely the shape a server
executor must hold for hundreds of spaces.

### 3.2 Persistent scheduler state (BUILT, default-on with rollback)

Implemented on the #4288 branch with the default-on runtime option
`persistentSchedulerState` (env `EXPERIMENTAL_PERSISTENT_SCHEDULER_STATE`; an
explicit false remains the rollback path):
the full durable stack, not just shapes. Per-action observations
(`SchedulerActionObservation` — `pieceId`, `actionId`, `actionKind`,
`implementationFingerprint`, `observedAtSeq`, `reads`, `currentKnownWrites`,
`declaredWrites`, gate options, status —
`packages/runner/src/scheduler/persistent-observation.ts:22`) are attached
to the live commit tx (`run.ts:516`) and persisted **inside the
single `applyCommit` SQLite transaction** (`packages/memory/v2/engine.ts:1554`
→ `upsertSchedulerObservationTransaction` `:3285`) across five tables
(`scheduler_observation`, `scheduler_action_snapshot` LWW,
`scheduler_read_index`, `scheduler_write_index`, `scheduler_action_state` —
DDL `engine.ts:206`+). Cold start reads them back
(`listSchedulerActionSnapshots` through the provider seam) and rehydrates
without re-running unchanged actions. On #4288, the runner loads the
snapshots and the facade in `packages/runner/src/scheduler/facade.ts` applies
fingerprint-gated, fail-open
rehydration. Restart-skip is proven by `reload-rehydration.test.ts` and
`v2-scheduler-state-test.ts`.

G4 is now implemented: durable dirty markers are consumed through the indexed
stale-reader query, and accepted commits selectively wake only demanded
readers in a parked/live space. The reverse `scheduler_read_index` and producer
`scheduler_write_index` remain the authoritative lookup surfaces (§3.3).

Contribution: spin-up/spin-down becomes cheap. An idle space's graph is a
set of observation rows; waking it is `rehydrate` + running only actions
whose inputs moved. `observedAtSeq` remains useful scheduler metadata, but is
not a causal input watermark; reconciliation requires an explicit input
basis and settlement acknowledgement (§5.B.4).

#### 3.2.1 Prerequisite: context-qualify durable scheduler state

The updated #4288 baseline fixes the scheduler-projection bug that originally
left action snapshots, action state, and read/write-index ownership
unqualified by effective user/session context. Cell revisions were already
partitioned by effective `scope_key`; the scheduler tables now preserve that
same separation instead of allowing two users or sessions running the same
scoped action to replace each other's metadata.

The implementation:

- derive an action `context_key` on the server using the shareability lattice
  `space < user < session`, where moving right is narrower;
- permit a shared `space` or `user` row only when a trusted complete
  transformer/runner scope summary covers the piece/result plus every possible
  read, write, materializer envelope, and direct output; incomplete, unknown,
  or dynamic surfaces start at `session:<principal>:<session-id>`, and observed
  absence alone can never promote them;
- include `context_key` in the action snapshot, action-state, read-index,
  and write-index action keys;
- persist the resolved `read_scope_key` / `write_scope_key` on indexed
  addresses and dirty only exact effective-scope matches;
- never accept principal/session identity from client-provided observation
  payloads; and
- retain one shared `space` row for genuinely space-only actions so their
  scheduler state is reusable across users.

Within one action fingerprint, runtime evidence may only narrow context.
`space`→scoped invalidates the shared row; `user`→`session` invalidates that
principal's user row without deleting another principal's independent row.
Broader classification requires a new implementation/runtime fingerprint.

Regression coverage runs the same action as two users and as two sessions,
proves their scoped snapshots/index rows/dirty markers coexist, proves
monotonic narrowing and unknown-summary fallback, and keeps a 10k-row indexed
lookup guard while space-only observations continue to coalesce.

### 3.3 Producer lookup: durable writer index, not creation provenance

Result cells carry `patternIdentity = {identity, symbol}`
(`packages/runner/src/runner.ts:1014`); serialized modules/handlers carry
`$implRef` / `$patternRef` sentinels; verified provenance is a WeakMap keyed
by the function object; `pattern:<identity>` source docs form a
Merkle-verified closure with `loadPatternByIdentity` +
`compileCache:<runtimeVersion>/<identity>` for cold recovery (single-flighted,
#4460). Action identity is per-instance
(`cf:module/<hash>:<symbol>:<instanceKey>`,
`docs/history/specs/action-id-per-instance-decision.md`), reload-stable.

Creation provenance is not producer identity. A computation may redirect its
output into a pre-existing cell whose creator is unrelated to the action that
currently recomputes it. Existing `result` metadata (the meta link from a
builtin-allocated cell back to its piece's result root — the field that
replaced the earlier `source` metadata; see
`packages/runner/src/result-utils.ts`) may remain useful as a local or
historical diagnostic, but this plan neither adds universal provenance
stamping nor promises a per-document causal-audit mechanism. A future audit
lineage design is separate; creation provenance must not select an executor
action.

The authoritative producer projection is `scheduler_write_index`, joined to
`scheduler_action_state` and the durable action snapshot. The implemented
`writersForTargets` lookup is by
effective `(space, scope_key, doc id, path)` with path-overlap semantics and
returns every candidate writer; it must never choose an arbitrary winner.
The action snapshot supplies `(pieceId, actionId,
implementationFingerprint)`, and the piece's `patternIdentity` is the sole
durable pointer used to load executable code. Implementation-plan W0.3 adds
the named target/path lookup over the durable declared, current-known, and
materializer rows written with scheduler observations. A live worker can also
consult its registration-time static surface before the first run.

If a demanded piece has no usable writer row yet, the client interest already
identifies the piece. The executor instantiates that piece, validates its
transformer-emitted root binding and declared surfaces, runs it under client
authority until an eligible claim can be proven, and persists the resulting
index. Missing/corrupt rows therefore fail open to ordinary execution rather
than guessing a producer.

#### 3.3.1 Transformer invariant: one direct root output binding

Important patterns now go through the transformer. Enforce that every normal
computation node has exactly one primary output binding, directly to the
root path of its target cell. The runner does not recursively search the
emitted static output binding for a redirect to determine result identity.
This replaces the former `firstResolvedOutputRedirect` path; plain
lift/computed result identity from `_resultFor` does not recurse and is not
being replaced.
Additional static side writes and materializer envelopes remain explicit write
surfaces and are indexed separately.

There is no legacy data migration or corpus audit. Update the small number of
tests that hand-construct Pattern JSON, reject nonconforming new JSON at the
runner boundary, and simplify the redirect-resolution code accordingly.
Hand-built `type: "passthrough"` nodes have no transformer emission path but
participate in the same output-binding contract: their primary binding must
also be direct at the root, and nested/multiple aliases are fixed in tests or
rejected.
General Cell aliases remain supported; this invariant concerns the primary
computation result binding, not every Cell redirect in the system.

### 3.4 Reactive interpreter — de-scoped (delayed; not a dependency)

An earlier revision listed the reactive-interpreter line of work as a
density/spin-up accelerator for the executor. That work is delayed, and
this design no longer references or depends on it: everything here runs
on today's compiled pattern path (per-piece SES sandboxes, current doc
counts). The de-scope was checked deliberately and invalidates nothing:

- **Density** is carried by the SQLite-primary state model instead
  (§6.7): parked spaces cost zero memory, workers can be transient
  (§6.5), and module/compile caches are shared per host — executor
  economics do not rest on cheaper per-piece execution.
- **Scoped derivation on the executor** (§5.B.6, Phase 4) is
  engine-agnostic: it runs on the compiled path; nothing waits for an
  interpreter.
- **D-projector mode** loses its intended mechanism (render output
  stored as VNode docs was prototyped on that line of work); it was
  already a bookend rather than a migration target and is now explicitly
  deferred until a concrete VNode-document design exists.

If that work later revives, it slots back in as a pure optimizer — no
interface in this design changes.

### 3.5 Deliberately not assumed

- Memory-v2 branching (`docs/specs/memory-v2/06-branching.md`) — useful for
  speculation (§5.B.4 option ii) but the recommended design does not
  require it.
- Verifiable execution / receipts (`docs/specs/verifiable-execution/`) —
  the long-term frame for "who computed this and can we check it", but this
  trusted-client design only needs existing authenticated session-derived
  authority. Signed delegated request proofs are later hardening, not a v1
  prerequisite.

---

## 4. The four design questions

Every approach is an answer to these four questions; naming them keeps the
approach comparison honest.

- **Q1 — Authority: which writes may a client commit?**
  All writes (today) / all writes except actions covered by a matching live
  server claim (B) / no writes, events only (C). B deliberately does not ask
  the client to predict scope or cross-space behavior: absent a positive
  action claim, today's commit path remains authoritative.
- **Q2 — Reads: how do clients learn about remote changes?**
  Per-session graph-query re-evaluation (today) / doc-granular delta feed
  filtered by a server-maintained interest closure (§6.4) / whole-space
  feed for small spaces.
- **Q3 — Speculation: what does the client compute locally, and how is it
  reconciled?** Nothing (A, D) / claimed-action overlay reconciled by an
  explicit input basis and settlement acknowledgement (B) / handlers +
  derived, reconciled by event acks (C).
- **Q4 — Executor placement and isolation:** none (status quo) / worker
  thread per active branch/space co-located with the memory engine (§6.1) /
  subprocess
  tier for untrusted or heavy spaces (§6.6).

---

## 5. Approaches

### Approach A — Server catch-up executor (generalized background-piece-service)

**Model.** Keep client behavior exactly as today while running the shared
client-demand executor in observe-only mode. Its private replica may settle
computations to discover the graph, but the provider rejects all upstream
derived commits and external builtin effects. An explicit test capability may
exercise redundant commits/effects; ordinary sessions never see it. This
validates pool lifecycle, demand unioning, sponsor identity, the provider, and
scheduler rehydration without transferring authority.

**What changes.**

1. Compatible client sessions export demand; the pool unions it into one
   worker per eligible active space (§6.3).
2. The worker uses the full executor-grade provider (§6.2) and reports the
   actions it could claim without yet changing client authority.
3. Async builtins can be exercised in test/opt-in spaces, but authority is
   not transferred until the corresponding action claim is live.

Raw authenticated demand remains available while the durable execution policy
is absent or false: Phase 1 needs it to drive observe-only shadow work. That
policy gates positive claims, not discovery of work clients currently care
about.

**Identity/CFC.** Unchanged for clients. The worker runs on behalf of an
eligible requesting user, selected as described in §6.1, rather than an
anonymous deployment executor. Background-only work keeps its distinct
service identity and lower-priority lifecycle.

**Failure modes.** Server executor down → exactly today's system. Ordinary
shadow mode has no server data writes or external effects, so it adds no
writer. The explicit test capability may observe conflicts and exercises
existing mutex guards without creating a production authority window.

**Perf.** No client-side win. Server cost: one runtime per active branch/space.
Subscription serving cost unchanged.

**Verdict.** A short shadow-validation milestone, not a product phase. It
does not remove races or client cost. Move promptly to positive action claims
once equivalence and provider correctness are proven. Background-registry
consolidation is later, but the exclusion interlock is immediate.

---

### Approach B — Positive derived-authority split (proposed)

**Model.** Authority is per action, positive, and ephemeral:

| Write class | Authority | Sync behavior |
| --- | --- | --- |
| Event-handler writes (user intent) | client | today's optimistic commit + retry |
| Setup / seed structural writes | client | part of the creating action's tx |
| Direct UI-binding writes (`$value`, etc.) | client | user intent |
| Eligible same-space, space-scoped derivation | server **only while an exact `ExecutionClaim` is live** | client writes go to a local overlay |
| Unclaimed, scoped, cross-space, render, or unknown actions | client | today's commit path |
| Eligible async builtin request/result | server while claimed | client renders pending/overlay state |

The fail-open default is therefore unchanged client authority. The server is
the sole committer only for the actions it has positively claimed; there is
no space-wide `derivedAuthority` bit and no client-maintained exception list.

#### B.1 Demand, claims, and the client write path

At handshake the client must advertise the server-execution protocol version.
An incompatible client is rejected rather than allowed to participate with
stale authority rules. A compatible authenticated session exports
branch-qualified `ExecutionDemand` for the pieces/docs it is pulling. The pool
unions demand from all sessions on that branch; it does not create one worker
per client (§6.1).

After static eligibility checks and at least one successful shadow run, the
control plane may publish an ephemeral claim:

```ts
// Shown for illustration only.
interface ExecutionClaim {
  branch: BranchName;
  space: DID;
  contextKey: SchedulerExecutionContextKey; // `space` in the first phase
  pieceId: string;
  actionId: string;
  actionKind: SchedulerActionKind;
  implementationFingerprint: string;
  runtimeFingerprint: string;
  leaseGeneration: number;
  claimGeneration: number; // fresh monotonic value for each claim issuance
}
```

Claims ride the authenticated session/control feed and are not ordinary
space documents. Each session retains only a bounded suffix of control
history; reconnect always installs a complete claim snapshot plus a coalesced
successful settlement frontier for each exact live claim. A cursor older than
the suffix therefore resynchronizes both authority and overlay reconciliation
instead of growing an unbounded queue. A durable policy may opt a space into
server-primary execution, but runtime ownership, liveness, generations, and
exceptions do not belong in mutable user data.

The implemented opt-in is the default-branch, space-scoped document
`of:${space}:execution-policy`, whose value is exactly
`{ version: 1, serverPrimaryExecution: boolean }`. It is owner-managed through
whole-document set/delete policy-only commits. Absent, deleted, disabled, or
malformed state is client-primary; direct host writes cannot bypass owner
authorization. OWNER is enforced for this authority switch even when ordinary
ACL enforcement is configured `off` or `observe`; in those rollout-relaxed
modes, only the implicit space identity/service owners qualify, so a writer
cannot first rewrite the ACL to manufacture policy authority. Positive claims
require an enabled policy; disabling or deleting it revokes every live claim
while leaving shadow demand intact. The runtime flag remains the
higher-priority rollback, so a true policy is inert when
`serverPrimaryExecution` is off. Deployment flag changes take effect on new
negotiated connections (normally after host restart/redeploy).
Operators use `cf execution enable|disable|status`; rollout and rollback order
is documented in the
[server-primary execution runbook](../../development/server-primary-execution.md).

The fields from `branch` through `runtimeFingerprint` form the shared
`ActionClaimKey` that both client and server can derive. `leaseGeneration`
fences a Worker;
`claimGeneration` identifies one incarnation of this action's authority and
changes even when the same Worker revokes and reclaims it. The client runner
routes by that exact identity:

- event handlers, setup/seed writes, direct UI writes, and every action with
  no matching claim use today's commit pipeline;
- a claimed action applies its result to an `ISpaceReplica` overlay keyed by
  lease generation, claim generation, and input basis, visible to local
  downstream computation
  but never enqueued upstream; and
- server-confirmed claim removal/fingerprint mismatch restores client
  authority and dirties the action for a normal rerun/commit.

Connection loss is not proof that a claim ended: another requester may keep the
shared Worker and claim alive. While disconnected, a client may continue local
speculation but must not enqueue previously claimed derived writes. Reconnect
first negotiates the capability and applies a complete claim snapshot for the
exact branch at a feed-sequence barrier, followed by any missed successful
settlement frontiers for those exact live incarnations; only then may newly
unclaimed work flush. Source, handler, and direct UI commits keep their
existing offline behavior.

Trusted compatible clients cooperate with this split in the first iteration.
Later server admission and CFC policy can reject commits that conflict with a
live claim without changing the protocol shape.

#### B.2 Server write path and whole-action servability

The executor runs the scheduler-v2 graph through the executor-grade provider
(§6.2) under a fenced `ExecutionLease`. It never calls raw engine mutation
APIs around normal authorization. Its commits traverse the same authenticated
principal, ACL, CFC preparation/validation, conflict, scheduler-observation,
and feed-notification path as equivalent client commits, while avoiding wire
and graph-watch overhead.

Client speculation matches only the shared `ActionClaimKey`. After validating
the lease, the server appends trusted `ActionExecutionProvenance` —
`onBehalfOf`, lease/claim generations, causal sources, and `inputBasisSeq`.
Those server-only fields are not inputs a client must predict to recognize a
claim.

Each executor action attempt does carry a transient
`executionClaimAssertion` containing the effective context key and exact
lease/claim generations captured when that attempt started. It is an untrusted
selector, not provenance: the authenticated host reconstructs the rest of the
key from the same scheduler observation, requires an exact live claim on the
bound connection/session-token/principal, and the memory transaction verifies
that the derived effective context equals the claim. The assertion is stripped
from accepted scheduler state but retained in request replay identity. Thus a
late generation cannot be relabeled onto a replacement claim, while an exact
already-accepted replay remains idempotent after revoke.

Initial eligibility is deliberately narrow: the complete action transaction
must read and write only the same space's space-scoped cells. Static output
bindings, declared reads/writes, materializer envelopes, and the writer index
reject known scoped, cross-space, render, or unknown surfaces before a claim.
The provider additionally stages each claimed transaction behind a scope
firewall. If any actual read or write crosses a space or effective scope, the
whole transaction is discarded, the claim is revoked, and clients rerun the
whole action authoritatively. Never split one action transaction between
server- and client-authoritative operations.

Async builtins are claimable only when their request and result surfaces pass
the static check before the external effect starts. This preserves the same
whole-action fallback rule without attempting to undo an external side
effect.

#### B.3 Handler reads: today's semantics, then dual execution

Handlers keep today's optimistic semantics, which are already correct for
this model: a handler runs against the client's local state; if that state
was outdated, the commit fails conflict detection, and the client retries
once caught up, then succeeds. Nothing new is built for B here — the
existing conflict/retry machinery
(`packages/runner/src/scheduler/events.ts`, retry budget + `readyToRetry`)
*is* the speculation guard.

Phase B does not add persistent scheduler observations for handler runs.
Handlers remain client-authoritative, their read sets do not drive the
server-primary wake index, and their existing authenticated event/source
provenance remains unchanged. Phase 5 defines any handler-observation contract
needed when events move to the server.

One residual window is accepted knowingly: a handler may read an
overlay-derived value the server has not computed yet (a prediction), and
its source write can be admitted before the server's recompute lands —
conflict detection can only compare against *committed* state. This is the
same class of optimistic bet the system already makes; it self-heals (the
server's recompute overwrites, downstream re-settles) and is counted, not
prevented.

The end-state closes the window structurally: **the event ships to the
server and the handler runs on both sides** — the server's run is
authoritative (it reads authoritative derived state by construction), the
client's run is the speculative part, reconciled by the event's durable ID
(#4088) and its ack. That is approach C's machinery (§5.C), adopted as the
target for events rather than an escape hatch; B is the intermediate state
in which only the handler's *writes* ship, not the event itself.

#### B.4 Reconciliation protocol: causal basis and settlement

`observedAtSeq` is the sequence at which an observation commit was accepted;
it is not proof of which inputs the action consumed. Each server run instead
tracks `inputBasisSeq`, the maximum same-space confirmed-read sequence accepted
by the engine, with pending local reads translated to their server-assigned
global sequence. Reads excluded from the canonical conflict set are excluded
from the basis; no durable reads yields zero. The engine strips any supplied
basis/provenance and authors the canonical values only after validation.
Derived patches carry that basis, and every
claimed run produces an `ActionSettlement` on the control/feed path:

```ts
// Shown for illustration only.
type ActionSettlement =
  | {
    branch: BranchName;
    claim: ExecutionClaim;
    inputBasisSeq: number;
    outcome: "committed";
    acceptedCommitSeq: number;
  }
  | {
    branch: BranchName;
    claim: ExecutionClaim;
    inputBasisSeq: number;
    outcome: "no-op" | "failed" | "unserved";
    acceptedCommitSeq?: never;
  };
```

A no-op must still settle; otherwise a correct local overlay can wait forever
for a derived patch that will never exist. Failure settles the attempt;
`session.execution.claim.revoke` separately names and removes the currently
live claimGeneration and dirties the client action. A later claim issuance
gets the next generation. Host-authored expiry performs the same revoke,
removes the claim from reconnect snapshots, and rejects delayed settlements.
Cross-space execution, when admitted later, requires
an input-basis vector rather than this scalar. A successful
settlement is published only after the normal confirmed-read validation has
accepted the data or observation-only transaction; `inputBasisSeq` is not an
unverified Worker assertion. Commit patches, claim snapshots/revokes, and every
settlement outcome share an ordered reconnectable feed with sequence barriers.
A bounded reconnect snapshot coalesces successful outcomes newer than its
acknowledged cursor per exact live incarnation: it carries the maximum covered
input basis, the newest successful feed sequence, and the maximum committed
data-application gate. Clients install claims first and apply that frontier
once; ack, revoke, and reclaim prune it. Thus suffix eviction cannot strand an
overlay or bypass `acceptedCommitSeq`, and retained successes are not delivered
twice.
A committed settlement always names its `acceptedCommitSeq`; if control arrives
first, the client buffers it until its confirmed/feed cursor reaches that
sequence. This is an additional data-application gate, not a substitute for
control ordering. No-op has no data patch and is ordered after its accepted
observation-only transaction.

The settlement's top-level `branch` must equal `claim.branch`, and both must
match the feed branch before the client considers it. Client state per doc is
`confirmed(seq)`, speculative `overlay(claim, basis)`, and pending local source
commits. An overlay based on an unconfirmed
local commit stays until that commit receives global sequence `S(L)`. Once a
matching settlement has `inputBasisSeq >= S(L)`, the server has consumed that
source basis when the claimed action reads that source directly. The scalar is
not transitive across a claimed-action chain: a downstream action can read a
stale intermediate while an unrelated newer input pushes its maximum basis past
`S(L)`. V1 accepts the resulting brief stale-confirmed display after overlay
drop; the intermediate/downstream re-settle self-heals it and records
divergence. A later transitive causal-frontier design can remove that window.
For `committed` the client drops the covered overlay only after applying
`acceptedCommitSeq`; for `no-op` it drops after the ordered settlement. Exact
lease + claim generation matching prevents a delayed settlement from an older
claim incarnation clearing a newer overlay. Rejected source commits invalidate
dependent overlays; handler retry creates a fresh basis.

#### B.5 Async builtins and egress parity

Claimed `fetch*` and `generate*` builtins run on the executor. Client-side
instances remain passive for that claim and render pending/overlay state;
streaming partials flow down the ordinary feed. Moving execution must not
widen network reach relative to browser execution:

- relative request paths resolve against the trusted serving origin for the
  space and remain allowed, including a localhost serving origin in local
  development;
- absolute and authority-bearing inputs (including `//host/path`) are treated
  as external and reject loopback, link-local, metadata, and private-network
  destinations; DNS resolution and every redirect hop are revalidated. A
  request that began relative remains trusted across redirects whose normalized
  origin equals the canonical serving origin, even if `Location` is absolute;
  any origin change becomes external and receives the full policy; and
- the worker receives the canonical serving origin explicitly and must not
  infer it from an internal memory-server address.

A host egress broker is preferred so workers need no broad network
permission. Direct builtin execution is acceptable only when it enforces the
identical policy. Pattern code in SES has no raw-fetch escape from the builtin
path. Full durable streaming, quotas, cross-engine idempotency, and circuit
breakers follow after the move; v1 need only preserve current retry and
deduplication behavior without making it worse.

Identity-sensitive first-party calls must not silently use whichever sponsor
currently owns the space. For every accepted source commit, the host compares
its authenticated origin session with the exact current lease sponsor. Only
the resulting match boolean enters Worker claim logic; the broker request
carries the exact claim but no causal actor identity. A match permits execution
under the lease sponsor. A mismatch or ambiguous origin reaches no broker
egress and settles the exact claim canonically unserved with revoke. When a
relevant commit wakes a parked lane, sponsor acquisition prefers that commit's
origin session. Dynamic per-action actor multiplexing waits for delegated
execution contexts.

#### B.6 Scoped state: explicit first-phase boundary

The first phase claims only provably same-space, space-scoped actions.
PerUser, PerSession, cross-space, render, and statically unknown actions stay
client-authoritative. The guarantee does not depend on predicting the whole
graph: clients run the complete graph by default, and only exact claims
suppress an action's commits. The static eligibility check plus the staged
transaction firewall catches dynamic behavior before apply and revokes the
whole claim.

Supporting every scope immediately would require principal-aware runtime
contexts and scheduler lanes: one shared space lane, per-user lanes, and
per-session lanes, with all replicas, transactions, indexes, dirty matching,
and CFC context qualified by `SchedulerExecutionContextKey`. The prerequisite
in §3.2.1 fixes durable metadata collisions but does not by itself make a
single Runtime switch acting principal per action. Scoped execution therefore
remains a later phase rather than complicating the first server path.

#### B.7 Identity, provenance, and CFC

Client-demand execution is never signed by an anonymous executor principal.
The pool derives a short-lived `ExecutionLease` from one authenticated,
WRITE-capable requesting session. The worker acts as that principal and every
derived commit records `onBehalfOf: <user DID>`. The host retains the
credential/provider binding; it does not hand the user's private key to the
worker. A future user-delegated execution key can replace the session-derived
lease.

`onBehalfOf` is execution authority, not semantic authorship. Provenance also
records the producing action and causal source commits/principals. The module's
verified implementation identity and ordinary CFC labels/gates remain
unchanged. A future `executor-computed` endorsement must be specified by CFC
owners; it is not required to move execution in this trusted-client phase.

Background-only execution is the sole use of the existing service identity
and is separately attributable. It never signs client-pulled work.

#### B.8 Failure modes

- **Executor down / space not served:** its lease expires or is revoked and
  claims actively expire/revoke. Clients dirty those actions and commit them normally.
  No mutable config flip or negative exception propagation is required.
- **Competing/replaced worker:** every claim and commit is fenced by
  `ExecutionLease.leaseGeneration`; the provider rejects a stale generation.
  Within one lease, revoke names the action's live `claimGeneration` and the
  next claim issuance increments it, so delayed settlement cannot target the
  new incarnation. The attempt's exact assertion also prevents a delayed write
  from being attributed to that new incarnation or silently becoming an
  ordinary unclaimed write. More generally, every first-application semantic
  transaction on a host-bound executor session must resolve exactly one live
  claimed-action incarnation inside the lease-fenced transaction; assertion-
  free semantic writes fail atomically. Exact accepted replay is checked first
  and remains idempotent after revoke.
- **Sponsor disconnect:** the lease enters a bounded teardown drain and fences
  every new first application immediately; exact accepted replays remain
  idempotent. The worker then restarts under another eligible requester. It
  does not change Runtime principal mid-settle. A later exact attempt-admission
  mechanism may safely preserve work proven to have started before the drain.
- **Client offline:** source writes queue (pending commits) and local overlays
  keep the UI coherent, but previously claimed derived writes do not flush
  merely because the connection disappeared. Reconnect applies the
  authoritative claim snapshot and any missed successful settlement frontier
  before derived work resumes. True offline
  (persisted pending queue) remains a separate, orthogonal gap — the replica
  is in-memory today.
- **Executor crash mid-settle:** observations persist per commit;
  claims are revoked, then a replacement rehydrates and reclaims only after
  successful catch-up. Bounded by scheduler-v2's budget + backoff gates.
- **Divergent speculation:** silent server-wins; counted.

#### B.9 Performance model

Per space with C connected clients, piece graph of size G, event rate E:

- Executor compute: one unioned server scheduler's settle work plus today's
  client schedulers during the initial authority split. The first rollout adds
  server compute so it can remove duplicate commits and external effects; it
  does not yet remove N× local speculative computation.
- Client compute: the complete graph still runs by default so unsupported
  actions and immediate local-source overlays remain correct. An exactly
  claimed computation may coalesce remote feed invalidations behind one
  non-sliding 50 ms observation-adoption grace; `idle()` waits for its bounded
  local fallback. A later, separately gated closure/claim-snapshot optimization
  may leave remotely owned actions cold until local speculation demands them.
  First paint therefore retains today's browser compile path; zero-execution
  first paint requires D/projector output.
- Server subscription serving: today's graph-query path remains for unclaimed
  actions. After exact closure parity (§6.4), claimed closures can move toward
  O(commits × sessions × set-membership + patch size).
- Store: derived docs written once per change (by the executor) instead of
  once per client + conflict retries.
- New costs: executor pool memory (∝ active spaces; hibernation via
  persisted state, §6.5), and the feed fan-out (cheap: doc-id filtering).

**Verdict.** B delivers authority transfer incrementally. Every exact claim
removes redundant wire writes and duplicate external effects; every unsupported
or failed action remains on the known client path. Removing duplicate local
compute and browser cold-start work is a later optimization, not a claimed v1
benefit. B's main additions are authenticated demand, fenced leases, ephemeral
claims, the overlay, and explicit settlements.

---

### Approach C — Event shipping (server runs handlers too)

**Model.** Clients do not commit at all. A UI event becomes a **signed
event envelope**: `{space, piece, handler-link, payload, provenance,
user-DID, session, nonce/expiry, signature}` — the request-proof format of
`toolshed-access-control.md:35` applied to events, replacing the
non-serializable WeakSet trusted-event mark
(`packages/runner/src/cfc/ui-contract.ts:95`). The server verifies the
envelope, marks renderer-trust server-side, and runs the handler in the
space executor with the event queue as the single per-space serialization
point. Clients speculate handler effects + derived locally and reconcile on
the event's ack (durable event IDs from #4088 give the ack identity).

**What it buys over B.**

- Zero client-side write authority → no client-induced write conflicts at
  all; the per-space event lane is a total order (the scheduler's event
  FIFO already is one; decision 2's per-space lanes make it explicit).
- Handler reads are always against authoritative state — B.3's chained-
  interaction subtlety disappears.
- Clients become capable of running on trivial devices (they need handler
  *speculation* only for latency, not for correctness).

**What it costs.**

- The envelope + verification + replay-protection machinery (G13) — a real
  cryptographic protocol where B needs none.
- Handler authority semantics: the handler runs server-side but must act
  *as the user* for CFC (`ownerPrincipal` minting, per-user partition
  writes from handlers, trusted-event-gated `uiContract` fields). That
  means either delegation tokens (G16) or re-deriving "acting-as" from the
  envelope — new CFC surface that B avoids entirely.
- Latency floor: input → authoritative effect now includes a round-trip
  *before* the handler runs; speculation hides it for display, but any
  external effect of the handler (async kick-off) waits.
- PerSession state referenced by handlers must be readable server-side —
  solvable once the executor maintains live per-session subtrees for
  connected sessions (§5.B.6's final phase, which the event stream itself
  enables by carrying session identity); until then, session-heavy
  handlers stay client-run.

**Verdict.** Not the next step, but the **end-state for events**: the
target model is dual execution — the event ships to the server, the
handler runs there authoritatively *and* on the client speculatively, the
client's run reconciled by the event's durable ID and ack (§5.B.3). Dual
execution is also what closes B's residual speculation window and, via the
session identity the event stream carries, unlocks session-scoped
execution (§5.B.6). Sequencing is unchanged — B first, because dual
execution needs everything B builds plus the envelope. Design the envelope
format alongside B (so `queueEvent`'s durable IDs and provenance survive
serialization); adopt per-handler (`serialize: "server"` for contended
handlers, headless/API clients) as the on-ramp before it becomes the
default event path.

---

### Approach D — Thin projector (server renders everything)

**Model.** Clients run nothing: the server computes all derived data
*including VNode docs* (requires render output stored inline in docs —
prototyped only on the de-scoped interpreter branch, not on main,
currently unscheduled; §3.4), and clients
are DOM projectors: materialize VNode docs via the existing reconciler,
send events (as C envelopes), echo input locally.

**Why it is not a separate destination.** D = C with speculation deleted.
Everything D needs, B/C build; whether a given client *chooses* to run the
speculative graph is then a client policy (device class, battery, page
type). The interesting D-specific observation: once the executor computes
VNode docs, **first paint requires zero pattern execution on the client** —
boot becomes "open feed, materialize VNode docs" — which is worth having as
a *mode* regardless (fast cold loads, embeds, previews, native shells).

**Why not lead with it.** Input latency (every keystroke/hover-derived
update is a round-trip unless the pattern splits interactive state into
PerSession cells — most don't today); PerSession/render entanglement
(render effects read session state); and it maximizes the identity surface
(everything C needs). Revisit after B, as "projector mode" for cold start
after render output has a durable document representation, rather than as
the execution model.

---

## 6. The server executor (shared architecture for A/B/C/D)

### 6.1 Topology: one unioned, user-sponsored worker per active branch/space

One **executor pool** service is co-resident with the memory engine (initially
inside toolshed; separable later). Per active branch/space there is at most one
authoritative Deno Worker generation running one Runtime — the bps shape
(`packages/background-piece-service/src/worker-controller.ts:78`). Realm
isolation is required, and a worker remains a natural unit of resource
accounting and crash isolation. Most importantly, one scheduler instance
unions `ExecutionDemand` from every connected client; there is never one
worker per connection.

The pool chooses one authenticated, WRITE-capable requester as a sticky user
sponsor. Prefer the principal whose commit wakes a cold worker when that
principal still has active demand; otherwise choose deterministically from
eligible requesters. Runtime/StorageManager identity is construction-wide, so
the sponsor does not switch per causal wave. Sponsor loss drains and restarts
the worker under a replacement rather than mutating its principal in place.

The pool owns a fenced
`ExecutionLease(branch, space, leaseGeneration, onBehalfOf)`.
Only its generation may publish claims or commit through the provider. This
is the single-owner coordination primitive even if the pool later spans
multiple processes; a heartbeat document alone is not sufficient.

Background-only demand is a distinct, lower-priority mode. A background
generation uses the existing service identity and claims only background work;
it never signs client-pulled execution. Before the registry is unified,
background-piece-service must acquire a durable service-owned exclusion before
constructing a Worker. That makes a branch/space with an active legacy
controller ineligible for the new client-demand pool until the Worker stops and
releases it. A dormant registration does not block because it has no competing
runtime. Acquire and renew responses include the server clock sampled with the
authority transaction. The background manager converts the server-relative
remaining duration into a request-start-anchored monotonic deadline; a response
from an older host without that field fails closed. Phase 3 imports that demand
into this same slot and removes the exclusion; only then may client demand
preempt a background generation.
Registry cleanup is not a prerequisite, but preventing two server runtimes is.
A subprocess tier remains optional for hard isolation.

Threading note: the engine's SQLite reads are synchronous FFI on the engine
thread; executor workers do **not** open the database. They talk to the
engine over an in-process channel (below). This respects the single-writer
engine assumption and keeps WAL discipline in one place.

### 6.2 Storage transport: in-process, no subscriptions

The implemented **executor-grade provider** gives the Worker an opaque
`MessagePort`, principal DID, and exact space/branch lane. The host owns the
real authenticated `Server.connect` session and its grant; neither a private
key nor raw `Engine` access crosses into the Worker. Reads and commits therefore
traverse the canonical protocol path, preserving session authentication, ACL
and CFC validation, conflict handling, scheduler-state updates, and post-commit
hooks. In-process means transport-efficient, not policy-bypassing.

The provider does not install a `session.watch` graph query. Instead, the
server's host-only accepted-commit callback reports successful canonical
first applications after their scheduler side effects. Its frozen payload is
limited to scalar revision metadata and changed scheduler-row ids; document
values never enter the callback surface. Replays, rejected transactions, and
catch-up reads do not appear as accepted commits. The provider tracks the
Worker's known roots and performs authenticated point queries for affected
state, then delivers ordinary replica syncs over the port. Scheduler-adoption
failure is fail-open for those required data invalidations. Callback failures
are contained and disposal unregisters the callback. The callback's per-space
`order` is process-local wake ordering, not the reconnectable execution-control
feed defined in §6.4/W0.6.

The provider now binds the durable `ExecutionLease` generation, host-derived
`onBehalfOf`, and atomic fence validation to this same canonical transaction
path. W1.3 will make it buffer a claimed transaction until
whole-action scope validation succeeds (§5.B.2).

### 6.3 What runs: demand, not pieces

The unit of demand is the **doc**, not the piece. The scheduler is
already pull-based — computations run only when demanded — so the only
real design question is where demand comes from. Answer: the docs
clients actually read, plus standing registrations for work with no
client-read output. "Run this piece" is not a concept the client or the
protocol needs; the client just pulls data.

A space is *active* when any of:

1. **Authenticated client-read demand:** the docs a client session reads — which is
   exactly the session's feed set (§6.4), so the server already holds it;
   in the limit no separate declaration protocol is needed. v1 grain is
   coarser — an authenticated
   `ExecutionDemand {branch, space, pieces}` message
   replacing `session.watch.set` (G7) — because a standing
   per-doc pulled-set export from clients doesn't exist yet
   (`.pull()` is one-shot, `packages/runner/src/cell.ts:1032`). The
   message is a granularity hint over the doc-centric model, not the
   model.
2. **Standing registrations (lower priority):** pieces whose value is their effects rather
   than client-read outputs (importers, BG work, timers, webhook
   targets) — today's bps registry generalized. These are the only place
   a piece-shaped declaration survives, because no pulled doc can imply
   them.
3. **Wake-on-commit:** an incoming commit touches a doc that the
   **persisted read index** maps to some demanded-but-parked downstream
   (the §3.2 readers index) — wake, catch up, hibernate.

Serving a demanded doc: `scheduler_write_index` identifies candidate actions
by effective address/path and joins them to durable action state (§3.3). The
worker loads the piece through `patternIdentity`, rehydrates scheduler-v2,
and pulls that doc. Per-piece demand roots are the v1 implementation and a
safe over-approximation. If no writer row exists, declared piece demand
supplies the cold-start code-loading unit; the server shadows it without
claiming until its surfaces are known.

Claims exclude scoped/cross-space subtrees and render effects in the first
phase. Those actions remain part of the client graph; absence of a claim keeps
them client-authoritative.

### 6.4 Client feed (replacing graph-query subscriptions)

During the shadow and first authority-split phases, the existing client
`session.watch` path remains authoritative for every unclaimed action. The
server scheduler exports exact read closures only for actions it actually
serves; those doc ids are unioned with the session's existing interest, and
matching `ExecutionClaim` / `ActionSettlement` records ride the same ordered
control/data path. This lets execution move before feed discovery is complete.

Graph-query re-evaluation may be retired only when every demanded action has
one of two complete closure sources: a server-served scheduler observation or
an exact client-exported closure. Scoped, cross-space, render, or otherwise
client-primary actions keep today's watch behavior until that proof exists.
At that point commit fan-out becomes set-membership filtering plus patch/control
payload size, while the existing `fromSeq`/`toSeq` catch-up path continues to
handle reconnect. Cross-space client links continue riding the requesting
user's ordinary session against the other space.

### 6.5 Lifecycle: spawn, catch-up, liveness, hibernate

**Start and keep-live triggers:**

1. **Demand:** a compatible authenticated client session publishes
   `ExecutionDemand`. The pool keeps one mapped lane while any reference
   remains.
2. **Indexed wake-on-commit:** while that mapped demand exists, an accepted
   commit whose host-index result names stale demanded readers can retry a
   parked or draining lane. A live Worker receives the same commit through its
   provider instead of starting another generation. Unrelated, wrong-branch,
   and already-settled commits do not wake the lane.
3. **Async continuation:** existing claimed work keeps its current Worker from
   completing a graceful drain; it is not a cold-start source.
4. **Background-only demand (Phase 3):** lower-priority standing registration,
   using the background identity rather than a client sponsor. Until registry
   import, its controller acquires the durable exclusion before starting rather
   than allowing a second pool Worker.
5. (Future) server-side timers.

**Spawn sequence** (ordered; the order is load-bearing):

1. The first demand snapshot maps the branch/space lane and installs its
   host-only accepted-commit subscription before lease acquisition.
2. After the legacy-background exclusion check, acquire/fence the
   `ExecutionLease`. A parked commit wake prefers that commit's authenticated
   origin session; otherwise sponsor selection remains deterministic among
   eligible demand sessions.
3. Construct the host provider before the Worker realm. Its accepted-commit
   subscription is registered before the Worker endpoint is transferred, so
   `MessagePort` queues notices across initial point reads without a graph
   watch or notification gap. No raw user key enters the Worker.
4. The Worker builds the runtime through that validated provider and rehydrates
   context-qualified observations for the demanded piece set. Dirty state and
   confirmed input revisions determine the stale set; missing/invalid rows
   degrade to a full unclaimed pull (fail-open).
5. A successful start makes the generation live. Graceful settle returns the
   accepted sequence watermark used to ignore old wake notices; a later
   indexed-relevant commit above that watermark can start one coalesced
   replacement generation.

Cold start consists of pattern load, context-qualified observation rehydrate,
and the stale demanded subset. Parked-wake and hibernation latency are measured
by the pool; no comparison with browser cold-boot latency is claimed yet.

The limit case is the **transient executor pass**: because scheduler
bookkeeping is SQLite-primary (§6.7), a worker need not outlive its work
— wake, reconstruct the workset (`scheduler_action_state` dirty markers
∩ demand, scanning only state changes past the worker's last-settled
seq), instantiate only the affected pieces, settle (bounded by
scheduler-v2's pass budget, so interruption is safe), write back, exit.
Worker lifetime becomes a latency/cache-warmth policy knob, not a
correctness concern; an idle space costs zero RAM. The liveness pins
below are that policy's defaults, not requirements.

**Liveness — what keeps a worker alive:**

- Live client `ExecutionDemand` and its sponsor lease pin the worker (default policy; under memory
  pressure the pool MAY hibernate pinned-but-quiescent workers anyway —
  wake-on-commit keeps that correct, only latency suffers).
- In-flight async builtin work pins it past idle, bounded by the builtin
  timeouts plus a hard cap (default 2× the longest builtin timeout) so a
  wedged request cannot pin a worker forever.
- Otherwise, `idleTimeout` (default 10 min — the existing bps worker
  timeout) of no commits, no dirty work, `settled()` resolved, and no
  interest → hibernate.
- **Catch-up without spin-up:** if the readers index shows no demanded
  piece downstream of a commit, do nothing (the doc is stale but nobody
  cares — pull semantics, now durable). When a stale doc is demanded, the
  writer index plus declared piece demand names candidates to wake (§3.3).
- **Hibernate** (the drain protocol): mark the space *draining* in the
  pool and record the worker's last-settled seq (wake decisions treat
  draining spaces as having no worker and compare incoming commit seqs
  against it) → `runtime.settled()` → tear down the space's storage
  through the provider's per-space teardown seam → terminate the worker →
  the pool re-checks for commits past the
  last-settled seq and respawns immediately if any landed during the
  drain. A parked space holds zero memory; its whole scheduler state is
  the observation rows.
- **Crash handling (implemented):** worker error → revoke its lease and claims
  first, so clients immediately resume normal commits, then retry with capped
  exponential backoff. Terminal quarantine, operator alerting, and manual
  un-quarantine remain later operational hardening (G18); Phase 0–2 does not
  claim those controls.

### 6.6 Isolation and resources

This section describes both the implemented isolation boundary and the target
resource-control envelope. Phase 0–2 implements SES/broker isolation, bounded
settle passes and control-feed retention, builtin timeouts, and fenced failure
cleanup. Hard per-Worker memory limits and bounded-LRU pool admission/eviction
remain later operational hardening (G18).

- Pattern leaf code still runs in SES inside the worker. Pattern network and
  generation operations are exposed only through `fetch*` / `generate*`
  builtins. Prefer a host broker and no broad Worker network permission;
  direct builtin execution is acceptable only with the exact §5.B.5 policy.
- **Target state — per-Worker budgets:** hard memory cap, settle-pass budget
  (scheduler-v2), event lane depth, and async concurrency
  (`runtime.getOrCreateQueue`). A space that exhausts budgets degrades to
  catch-up-on-demand rather than starving the pool.
- **Target state — pool sizing:** workers ≈ active spaces, bounded LRU;
  hibernation makes the bound soft. Multi-machine sharding (space → executor
  affinity) is a later concern; single-writer-per-space makes it embarrassingly
  shardable by space DID (G14 notes the coordination primitive).

### 6.7 State residency: SQLite is primary, memory is a cache

With observation persistence in the tree (§3.2 — durable tables
including `scheduler_action_state` with dirty markers), nearly all
scheduler bookkeeping is already durable, transaction-coupled with the
commits it describes. The design therefore treats **SQLite as the
primary store of scheduler state, and worker memory as a materialized
view** rebuilt on demand:

1. **Primary tier — SQLite, transaction-coupled.** The context-qualified
   observation rows (reads / writes / `observedAtSeq` / gate options per action,
   `packages/runner/src/scheduler/persistent-observation.ts:22`), the
   read/write indexes, and `scheduler_action_state` including dirty
   markers — written in the same transaction as the commits they
   describe. Consumers: rehydration on spin-up, wake-on-commit (the
   engine answers "does this commit make any parked piece stale?" with
   one indexed lookup, no worker running), producer lookup through
   `scheduler_write_index`, and workset reconstruction. `inputBasisSeq` is
   collected from actual confirmed reads during a run; it is not inferred
   from `observedAtSeq`.
2. **Cache tier — memory, per live worker.** The RAM residue, enumerated
   — everything here is rebuildable from tier 1, which is what makes the
   transient executor pass (§6.5) legal:
   - the runnable code graph (module closures, instantiated pieces): a
     cache keyed by `patternIdentity`, shareable across every space on
     the host and backed by the disk compile cache;
   - decoded doc values (JSON decode dominates the ~2µs synchronous
     read): an LRU decode cache — the "bit of caching";
   - per-pass computation: the workset toposort, derived each settle
     pass from the durable edge tables restricted to the workset (it was
     never persistent state), plus trigger-index/dependents maps as
     write-through caches of the durable indexes;
   - soft scheduling state (gate timers, debounce/backoff eligibility):
     resets on restart fail-open — worst case a run fires slightly early
     or late, never incorrectly.
3. **Session tier.** The delivery cursor (`seenSeq`) is already durable in
   the session-resume sense. The per-session **interest declaration**
   (space + piece ids) is persisted with the session; the derived doc-id
   **closure is deliberately not persisted** — it is recomputed on session
   open from the declaration plus tier 1 (or the live cache when the
   space is hot), because closures churn with every read-delta and the
   durable read index is already their source of truth.

The work queue is a query, not a data structure: the settle workset is
`scheduler_action_state` dirty markers ∩ demand, reconstructed on wake by
scanning state changes past the worker's last-settled seq (the drain
protocol's watermark, §6.5), and ordering is computed per pass. Nothing
queue-shaped needs separate persistence or periodic flushing — the
per-commit state updates *are* the flush.

Rules that keep this sound:

- **Disk projections are indexes of ground truth, not ground truth.** Commits and
  revisions remain the durable record; observations are a
  transaction-coupled projection of them. Because observation writes ride
  the same commit, the readers index can never be ahead of or behind the
  data it indexes. Context keys and effective scope keys prevent scoped
  projections from overwriting or dirtying a different user/session.
- **Fail-open to recompute.** Missing, stale, or corrupt observations
  degrade to re-running actions (the persistent-scheduler-state spec's
  invariant: never incorrect cleanliness, at worst wasted recompute). The
  cache tier is therefore always rebuildable, and only from durable
  state: worker crash → rehydrate from the SQLite primary (tier 1);
  damaged/missing primary rows → cold re-run, i.e. today's behavior. The
  cache tier is never a recovery source.
- **Per-commit work stays memory-resident for hot spaces.** Feed fan-out
  consults in-memory per-session doc-sets; the disk index is consulted
  per-commit only on the cold path (no worker, no sessions — the
  wake-on-commit lookup), a single indexed read (µs-scale; reads are
  synchronous FFI). SQLite-primary sets the *authority* order, not the
  hot-path data flow.
- **Growth and compaction.** The action snapshot is last-write-wins per
  `(SchedulerExecutionContextKey, actionId)`; no-op observations are elided (`payloadChanged` gating,
  `schedulerObservationBatch` — shipped); a space's rows drop wholesale
  with the space. The `scheduler_observation` history table is the one
  unbounded-growth surface; compaction remains a separate storage-maintenance
  question.

### 6.8 Cross-space

The scheduler may discover foreign-space reads or writes only at runtime.
That uncertainty is why v1 authority is positive and whole-action: any known
cross-space surface prevents a claim, and any dynamically discovered one
causes the staged transaction to abort and its claim to be revoked. Clients
then rerun and commit the complete action exactly as today. There is no
`unservablePieces` document and no stale window waiting for an exception to
propagate.

Client feeds continue following remote links through the requesting user's
ordinary sessions. Server-side cross-space reads may be added later after
permission continuity, multi-space input-basis vectors, wake subscriptions,
and ownership are specified. Cross-space derived writes additionally need
coordination between both spaces' executor leases; ordinary convergent
co-writing is not sufficient for server-primary authority.

---

## 7. Comparison and recommendation

| Criterion | A catch-up | B derived split | C event shipping | D projector |
| --- | --- | --- | --- | --- |
| Removes derived-data races | no (shadow only) | **yes, structurally** | yes | yes |
| Removes redundant N× compute | no | later client-suppression phase | later client-suppression phase | yes |
| Async reliability | no (shadow only) | yes | yes | yes |
| Input→display latency | today | today (overlay) | today (speculation) | +RTT |
| Chained handler reads | today | today's retry semantics | authoritative | authoritative |
| Client cold start | today | today; zero-exec requires D | today; zero-exec requires D | **fastest** |
| Subscription serving cost | today | today, then narrower feed | set-membership feed | set-membership feed |
| New identity machinery | session-derived lease | user-sponsored fenced lease + `onBehalfOf` | + signed envelopes | same as C |
| CFC surface touched | none | none new (labels data-derived) | trusted-event + acting-as | same as C |
| Runner changes | small | **write split + overlay (G5)** | + event serialization | + render split |
| Offline degradation | today | source queue + claim-resync barrier | needs envelope queue | poor |
| Incremental deliverability | **high** | **high (per-action claims)** | medium | low |
| Revertibility | trivial | revoke claims | protocol migration | protocol migration |

**Recommendation.** Context-key fix → shadow executor → B claims → scoped
execution → dual handler execution:

1. **Correct #4288 scheduler context keys** before durable rows drive server
   ownership or wake decisions (§3.2.1).
2. **Shadow A briefly** to validate one unioned user-sponsored worker,
   provider parity, rehydration, and eligibility without suppressing clients.
3. **B** publishes claims action by action. Eligible async builtins move with
   their claims; unsupported actions remain unchanged on clients.
4. **Scoped execution** extends B to user-scoped derivation via delegated
   grants (G16), then session-scoped once events ship — closing the
   integrity hole rather than leaving a permanent client-computed
   carve-out (§5.B.6).
5. **C — dual handler execution** as the end-state for events: envelope
   designed from day one (durable event IDs and provenance
   serialization-ready), adopted per-handler, then as the default event
   path.
6. **D-projector** as the later zero-execution boot mode, deferred until render
   output is stored as doc data (§3.4).

---

## 8. Phased plan

Phases build directly on #4288 and its persistent scheduler wiring.
Executable work orders with per-step success criteria and review
checklists: [implementation-plan.md](./implementation-plan.md).

- **Phase 0 — scheduler correctness (implemented).** Add
  `SchedulerExecutionContextKey` and effective scope keys across snapshots,
  state, and indexes (G1); enforce the transformer root binding (G6); add
  writer lookup (G4). The authenticated execution handshake, connection-owned
  demand, and ordered claim/settlement feed are implemented.
- **Phase 1 — shadow client-demand executor (implemented).** Add authenticated
  `ExecutionDemand`, one fenced user-sponsored `ExecutionLease` per
  branch/space,
  the validated provider, and claim eligibility reporting without authority
  transfer plus indexed parked-reader wake (G0/G2/G3/G4). Background-registry
  consolidation is deferred, but legacy-owned spaces are excluded immediately
  so a second server Worker cannot start.
- **Phase 2 — positive B claims (implemented and locally validated,
  default-off).** Add client overlay routing, ephemeral
  `ExecutionClaim`, `ActionSettlement.inputBasisSeq`, whole-action scope
  firewall, passive claimed builtins, and egress parity (G5/G10/G11). Measure
  conflict rate, multi-client action volume, divergence, revocations, and
  fallback latency. Fallback is claim removal. The operator runbook,
  product-derived/literal multi-client fixtures, and deterministic local
  enable/disable and failure drills are complete. The parked-worker
  claim-readiness failure is fixed, and the 500-event counterbalanced CPU gate
  passes; only a deployed-staging policy drill remains pending. The initial,
  superseded
  occupancy-proxy measurement is retained only as a historical snapshot in the
  [initial rollout report](../../history/development/performance/server-primary-rollout-2026-07-12.md),
  and the accepted result is recorded in the
  [500-event rollout report](../../history/development/performance/server-primary-rollout-2026-07-13.md).
- **Phase 3 — background demand + narrower feeds.** Fold existing background
  registrations into the same lower-priority pool and retire graph-query
  subscriptions only after the doc-set feed has parity. Separately gate
  client-compute suppression once claim snapshots and closures are complete;
  that later optimization, not Phase 2, removes N× local compute.
- **Phase 4 — scoped execution.** User-partition delegation (G16) +
  per-user demand roots; executor endorsement atom on scoped writes.
- **Phase 5 — dual handler execution (C).** Signed event envelopes
  (`serialize: "server"` handlers first, then the default event path);
  the server runs handlers authoritatively while clients keep running them
  speculatively; session-scoped execution rides the event stream.

---

## 9. Gap register

Gaps that remain **after** the assumed in-flight work lands. "needs-spec"
means a design doc/decision is required before implementation.

| # | Gap | Blocks | Status |
| --- | --- | --- | --- |
| G0 | Executor-grade provider with canonical ACL/CFC/conflict/apply hooks and commit invalidations | shadow | implemented, including atomic lease fencing |
| G1 | `SchedulerExecutionContextKey` and effective scope-qualified snapshots/state/indexes (§3.2.1) | server reliance on durable state | implemented |
| G2 | Branch-qualified authenticated `ExecutionDemand`, sticky sponsor selection, and fenced `ExecutionLease` | shadow | implemented, including client root export, one shared Worker lane, sponsor rotation, and durable legacy-background exclusion |
| G3 | Branch-qualified ephemeral per-action `ExecutionClaim` with worker lease generation + independent claim generation, revocation, and required client handshake | B | implemented and opt-in |
| G4 | Named parked-reader wake query plus target/path-overlap `scheduler_write_index` producer lookup | shadow/B | implemented |
| G5 | Exact-claim client routing, speculative overlay, read layering, revoke-and-rerun | B | implemented |
| G6 | Transformer/runner enforcement of one direct root result binding; update hand-built tests | producer eligibility | implemented; no migration |
| G7 | Authenticated branch-qualified demand + reconnect claim snapshots + ordered doc-set delta feed carrying commit/settlement sequence barriers; closure export | B/feed | demand, reconnect snapshot, and ordered data/control barriers implemented; exact closure export remains later |
| G8 | (retired — reactive interpreter de-scoped from this design, §3.4; its gates are tracked in its own specs) | — | retired |
| G9 | Cross-space basis vectors, permissions, wake, and dual-space ownership | later expansion | explicitly client-authority in v1 |
| G10 | Actual-read `inputBasisSeq` plus no-op/failure/unserved `ActionSettlement` and committed `acceptedCommitSeq` gating | B reconciliation | accepted-read basis, nominal sequence types, host-derived provenance, committed/no-op/failed run emission, and client data gate implemented; W1.3 and W1.4 emit canonical unserved attempts, including permanent builtin servability failures |
| G11 | Server builtin egress parity, relative serving-origin resolution, redirect/DNS revalidation | claimed async | implemented for v1; durable quotas/ledger remain G12 |
| G12 | Durable streaming, quotas, circuit breakers, and cross-engine effect ledger | async hardening/failover | later; v1 preserves current behavior |
| G13 | Signed event envelope format (serialize trusted-event provenance; replay protection; verify path) — design now, build in Phase 5 | dual handler execution (C) | needs-spec; request-proof precedent exists |
| G14 | Durable multi-process `ExecutionLease` acquisition/fencing | shadow executor exclusivity | implemented and covered by a two-Worker shared-store CAS race |
| G15 | Client pending-commit durability (true offline) | orthogonal | out of scope here; noted |
| G16 | Principal-aware scoped runtime lanes and delegated user keys | scoped execution | later; context-key prerequisite is G1 |
| G17 | Complete-closure client-compute suppression with cold remote-owned actions | remove N× local compute | later; Phase 2 only suppresses writes/effects |
| G18 | Terminal crash quarantine/manual un-quarantine, operator alerting, hard per-Worker memory limits, and bounded-LRU pool admission/eviction | production resource hardening | later; Phase 0–2 fences and revokes failed generations, retries with capped exponential backoff, bounds settle/control-feed work, and preserves correctness through hibernation/wake |

Cross-engine idempotency (the intent/attempt-cell ledger from
`cfc-runner-future-work.md` Tier 2) is deliberately *not* listed as a B
blocker: under B a derived action runs on exactly one engine (the space
executor), and handler re-execution stays client-side under today's retry
semantics. It becomes relevant with executor failover (G14); under dual
handler execution the client's speculative run never commits, so the
single authoritative run per event is preserved.

## 10. Open questions

1. **When does dual handler execution become the default event path
   (§5.B.3)?** Per-handler opt-in is the on-ramp; the trigger for flipping
   the default (contention data, headless-client demand, integrity
   requirements on handler writes) should be named in advance.
2. **Shape of user-partition delegation (G16):** a standing grant (user →
   executor, revocable, per space) vs short-lived tokens minted at session
   time; and does user-scoped execution get its own sub-worker per user or
   per-user demand roots inside the space worker?
3. **Where does the executor pool live long-term:** inside toolshed
   (co-process, simplest) vs a sibling service with the engine extracted
   behind the in-process channel? Phase 1 forces no commitment; the
   provider seam (G0) is the interface either way.
4. **What user consent and visibility does sponsorship require:** may any
   active WRITE-capable requester silently sponsor space-wide derivation caused
   by other users, should sessions expose an opt-out, or should v1 restrict
   sponsorship to space owners? Whichever policy is chosen must be visible in
   sponsor selection and provenance, not inferred from semantic authorship.
