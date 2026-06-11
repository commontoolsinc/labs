# Scheduler v2 — Demand-Driven Transactional Reactive Scheduling

> **Status**: Proposal (design spec, not yet implemented)
> **Replaces (once implemented)**: the behavior described in
> `docs/specs/pull-based-scheduler/README.md`
> **Companion docs**:
> [`current-system-inventory.md`](./current-system-inventory.md) — every
> mechanism in today's scheduler and what subsumes it here;
> [`migration-plan.md`](./migration-plan.md) — phased path from v1 to v2.
> **Persistence**: builds on `docs/specs/persistent-scheduler-state.md`
> (the observation/rehydration model carries over with a smaller payload).

This document re-derives the scheduler from first principles. It specifies the
model, the invariants, the node state machine, the algorithms, and the
component boundaries. It deliberately does not preserve v1's internal
vocabulary (`pending`, `dirty`, `stale`, `conditionally scheduled`,
`continuation`, `demand root`) except where it maps cleanly; the inventory doc
provides the full translation table.

---

## 1. What is special about this system

Any redesign has to start from the ways Common Fabric differs from classic
signal graphs (Solid, MobX, preact-signals, the TC39 proposal). These
differences are the reason the v1 scheduler grew the machinery it did; v2 must
carry them as load-bearing requirements, not bolt them on.

**D1 — State is external, shared, and multi-writer.** Reactive state lives in
cells (documents in per-space storage), not in process-local signal objects.
Writes arrive from the local runtime (actions, event handlers, framework
code), from remote peers via sync (pull/integrate notifications), and from
conflict resolution (revert notifications). A classic signal graph only has to
react to its own setters; this scheduler must treat *every* committed change —
local or remote — uniformly.

**D2 — Dependencies are discovered, not constructed.** A computation's inputs
are whatever documents/paths it actually traversed under its schema during its
last run, including link hops into other documents and other spaces.
Dependencies are *addresses* `(space, id, path, depth)`, not object
identities. Invalidation is path-overlap + value comparison, not "this signal
object changed".

**D3 — The graph rewires itself through data.** Because reads traverse links,
a write that changes a *link* changes the shape of the graph. Conditional
reads (`ifElse`) change the read set run-to-run. There is no moment at which
the dependency graph is statically known.

**D4 — Nodes create nodes.** Running a parent (a `map` builtin, a pattern
body) instantiates child nodes mid-flight. Children can produce data the
parent already sampled in the same scheduling pass. Classic signal graphs do
not schedule dynamically created first-class compute units inside a
propagation turn.

**D5 — Large dormant regions.** Most of a space's graph is unobserved at any
given time (background pieces, closed UI). The defining win of the v1
push→pull switch: computations nobody observes must not run. This is also the
precondition for serializing scheduler state — "has not run yet, nobody
asked" is a meaningful persistent state.

**D6 — Runs are transactions.** Every run executes inside exactly one storage
transaction; commits are optimistic against the local replica and may be
rejected by the server later (conflict → rollback → re-trigger). The
scheduler's unit of side effect is "one committed transaction", which gives us
a natural place to carry provenance (which node wrote this) and the CFC label
joins.

**D7 — Events are serialized, transactional, and consistency-gated.** User
gestures dispatch in global FIFO order; before a handler runs, the
computations feeding the data it will read must be brought up to date
(otherwise a click acts on a total that doesn't reflect the just-typed input).
Handlers commit real writes and are not idempotent, so they cannot be
optimistically run-and-retried the way computations can.

**D8 — Scheduler state persists across process restarts.** With persistent
scheduler observations (see persistent-scheduler-state.md), a resumed piece
restores its read sets and clean/dirty status instead of re-running everything.
"Initial run" is therefore not a fundamental concept — it is the degenerate
case of "no valid observation exists".

**D9 — Confidentiality flows through scheduling.** A run exists *because*
certain addresses changed; CFC (§8.9.2 of the CFC spec) requires the labels of
those trigger addresses to join the run's transaction even if the run's branch
never re-reads them. The scheduler is part of the information-flow surface.

---

## 2. Design principles

**P1 — One change channel.** All invalidation flows from the storage
notification stream: local commits (emitted synchronously at local apply,
value-bearing — see `packages/runner/src/storage/v2.ts` `notifyOptimistic`),
remote pulls/integrations, and reverts. The scheduler never propagates changes
through a second, in-process side channel. (v1 has both, plus watermark
machinery to reconcile them.)

**P2 — Value-accurate invalidation, reachability only for ordering.** A node
becomes invalid only when a value it actually read actually changed (the
existing trigger-index comparison semantics). Graph reachability is used to
*order* and *scope* work inside a pass, never to decide that something must
run. This single rule replaces v1's dirty/stale/conditionally-scheduled
triad: in v1, reachability-based fanout scheduled effects speculatively, and a
watermark history was needed to filter them back out at run time.

**P3 — Demand gates execution; nothing else does.** A node runs only when it
is invalid *and* live (§5). Effects are live by construction. Everything else
derives liveness from being read. Registration does not imply a run.

**P4 — One node, one output.** A computation owns exactly one output document
(its internal/result cell, per the per-internal-cell model of #3911). The
writer index degenerates to a 1:1 map, write-set tracking disappears, and
"what does this node produce" is static for the node's lifetime.
Side-writing through caller-provided cells is a separate, declared capability
(§4.3, materializers) — not a generalization of output.

**P5 — Self-identification through the transaction.** Every run's transaction
carries its node id. Change records derived from that transaction do not
invalidate the originating node. This single mechanism replaces in-flight
source tracking and change-group comparison for self-suppression.

**P6 — Subscriptions are durable; runs apply deltas.** A node's read set is
updated by diffing the new run log against the registered one and applying
the delta. There is no unsubscribe/resubscribe cycle around runs. The common
case (read set unchanged) is a no-op by construction, not by a memoized
fast path bolted onto a tear-down/re-add primitive.

**P7 — Convergence is bounded, not surgically forced.** Dynamic graphs can
ping-pong. The scheduler guarantees progress through per-pass iteration caps
and per-node run budgets, then *defers* remaining work with escalating time
gates. There is no cycle-breaker that force-runs or force-cleans specific
nodes.

**P8 — Policies are time gates.** Debounce, throttle, auto-debounce,
cycle-backoff, and event parking are all expressions of one primitive:
`eligibleAt(node) → timestamp`, with one wake timer for the earliest future
eligibility. Policies adjust gate inputs; they do not own timers or queues.

**P9 — Persistence-first lifecycle.** Node registration takes an explicit
start mode (`fresh` vs `resume`). Resume restores the observation (read set,
gate config, clean/invalid) and *does not run*; fresh starts invalid and runs
when demanded. Waiting for storage sync is a piece-level precondition of
`resume`, not a per-node racing timeout.

**P10 — Diagnostics observe, never participate.** Stats, traces, snapshots,
idempotency checking and non-settling detection read scheduler state through a
narrow interface. No scheduling decision may depend on whether diagnostics are
enabled.

---

## 3. Vocabulary

| Term | Meaning |
| --- | --- |
| **Cell / document** | Storage-level unit; addressed `(space, scope, id)`. |
| **Address** | `(space, scope, id, path)` — a path within a document. |
| **Change** | `(address, before, after, sourceNodeId?)` derived from a committed transaction (local or remote). |
| **Node** | Unit of scheduling: a function `(tx) => unknown` plus scheduler state (§4). |
| **Output** | The single document a computation node writes (its internal cell). |
| **Read set** | Addresses + depth (`deep` or `shallow`) the node's last run traversed. |
| **Invalid** | A value in the node's read set changed since its last completed run (or it has never run). |
| **Live** | The node's output is (transitively) observed by an effect, or the node is itself a demand source (§5). |
| **Eligible** | `now ≥ eligibleAt(node)` — no time gate blocks it. |
| **Runnable** | invalid ∧ live ∧ eligible. |
| **Pass** | One execution of the settle algorithm (§7); ends in quiescence, deferral, or budget exhaustion. |
| **Tick** | A queued invocation of the pass (microtask/macrotask coalesced). |

---

## 4. Nodes

### 4.1 Node record

All per-node scheduler state lives in one record. (v1 spreads this over ~25
collections on the Scheduler class; that diffusion — membership in many sets
encoding state implicitly — is the single largest source of v1's complexity.)

```typescript
interface SchedulerNode {
  id: NodeId;                    // durable identity (§9.1)
  kind: "computation" | "effect";
  fn: (tx: IExtendedStorageTransaction) => unknown;

  // Static for the node's lifetime:
  output?: DocumentRef;          // exactly one; absent for effects
  sideWriteEnvelope?: Address[]; // materializers only (§4.3)
  declaredReads: LinkRef[];      // from node bindings; ordering hints only (§6.2)
  parent?: NodeId;               // creation context (§5.3, §7.4)

  // Dynamic:
  reads: ReadSet;                // registered read set (drives the reader index)
  status: "never-ran" | "clean" | "invalid";
  invalidCauses: Address[];      // CFC trigger reads (§10); cleared on run
  liveRefs: number;              // demand refcount (§5)
  provisionalDemand: boolean;    // (§5.3)
  gate: GateState;               // debounce/throttle/backoff (§8)
  runBudget: RunBudget;          // per-pass runs, retry counter
  observationIdentity?: ObservationIdentity; // persistence key (§9)
}
```

`status: "never-ran"` is deliberately distinct from `"invalid"`: both are
runnable, but never-ran nodes have an empty read set (ordering falls back to
`declaredReads`) and, under persistence, only never-ran nodes consult
rehydration.

### 4.2 Node kinds

**Computations** are pure-ish transformations: read through schemas, return a
result that the runner writes to the node's single output document. Required
contract (already the documented contract in v1): *idempotent* — re-running
against unchanged inputs produces the same output. The scheduler may run a
computation any number of times. lift/computed/derive, the list builtins
(`map`/`filter`/`flatMap`), and raw builtins (fetch, llm, …) register as
computations. A computation whose run produces an *unchanged* output value
generates no change records (the storage layer already elides no-op
writes), so downstream stays clean — equality cutoff falls out of P1+P2
rather than being a separate mechanism.

**Effects** are demand sources with externally visible behavior: `sink()`
callbacks (UI render), `cell.pull()` (ephemeral effect), framework
subscriptions. Effects have no scheduler-visible output. Effects are assumed
re-runnable and speculation-safe (same assumption as v1: they may observe
locally-committed state whose server confirmation is still in flight).
Irreversible external side effects do not belong in effects; they belong in
event handlers or post-commit outboxes.

**Event handlers are not nodes.** They are dispatched from the event queue
(§7.5) with their own transactional/retry contract. They share the node
machinery only for preflight (computing a read closure to pull against).

### 4.3 Materializers (declared side-writers)

A materializer is a computation that writes *through cells passed to it*
(dynamic targets) instead of — or in addition to — its own output. Membership
and the write envelope are **declared** (transformer metadata / module
annotations, as in v1), never inferred from observed writes.

Materializers are the one place where "who writes X" is not answerable by the
1:1 output map. They get three special rules, and only these:

1. **Standing demand, idle priority.** A materializer is always live
   (`liveRefs` includes a permanent self-reference): its consumers are
   unknowable by construction, so invalidation must eventually cause a run.
   But it runs at *idle priority* — after the primary work set of a pass is
   empty — and its invalidations coalesce.
2. **Promotion under demand.** If a pass's primary work (an effect or the
   head event's closure) reads inside a dirty materializer's envelope, the
   materializer is promoted into that pass and ordered before the reader.
3. **Envelope edges are for ordering only.** The envelope contributes
   topological-sort edges within a pass. It never marks readers invalid —
   only the materializer's *actual* committed changes do (through the normal
   change channel, P1/P2).

This carries over v1's hard-won materializer semantics essentially unchanged;
they were redesigned recently and are sound. What v2 removes is the parallel
"current-known writes" generality for ordinary computations that materializers
were entangled with.

### 4.4 Registration and removal

```typescript
register(node: NodeSpec, opts: {
  mode: "fresh" | "resume";       // §9.2
  gate?: { debounce?: ms; noAutoDebounce?: boolean; throttle?: ms };
}): Cancel
```

Registration:

1. Inserts the node record; indexes `output` in the writer map and
   `sideWriteEnvelope` in the envelope index.
2. Wires *reader* edges immediately for any already-registered node whose
   read set overlaps this node's output (the new node may replace a
   predecessor writing the same document — v1's "seed declared writes"
   special case becomes a structural consequence of static outputs).
3. `fresh`: status `never-ran`. If the node is an effect it is live and
   therefore runnable → tick. If it is a computation it runs only when
   demand reaches it (P3). **There is no "run on subscribe".**
4. `resume`: defer to rehydration (§9.2). No tick for this node.
5. Computations created *during a live run* get `provisionalDemand` (§5.3).

Removal cancels reader-index entries, removes writer/envelope entries,
decrements liveness it contributed, and drops the record. There is no
unsubscribe-during-run dance: self-suppression is P5, not subscription
lifecycle.

The cost model this enables: registering N nodes of a dormant piece is O(N)
index inserts. No data is fetched, nothing runs, nothing is scheduled. v1's
register-time deep prefetch (`populateDependencies` with
`traverseCells: true`) is deleted (§6.2).

---

## 5. Liveness (demand)

### 5.1 Definition

```
live(N) ⇔ N is an effect (registered, not cancelled)
        ∨ N is a materializer (standing self-demand)
        ∨ ∃ registered node R: R.reads overlaps N.output ∧ live(R)
        ∨ N.provisionalDemand
        ∨ N is in the head event's preflight closure (transient, §7.5)
```

### 5.2 Maintenance

Liveness is maintained as a reference count (`liveRefs`), updated only when
node edges change — which is rare (a run whose read set changed, node
register/unregister) — not per data change. Edge updates propagate refcount
deltas downstream-to-upstream; cycles are guarded by a visited set, and a
refcount transition to/from zero is what propagates further (standard
observer-count maintenance, like signal libraries' subscriber counts).

This replaces v1's per-query graph walks (`isDemandedPullComputation` walks
dependents transitively on every check, including once per candidate node per
pass) with O(Δedges) bookkeeping.

### 5.3 Provisional demand

A computation registered while a live node is running inherits demand
provisionally: the creating run is itself evidence that something live is
constructing this subgraph (D4). Provisional demand expires at the end of the
node's first completed run — by then its output edges exist and real liveness
takes over — or when its creating pass reaches quiescence without anyone
reading its output.

This is the principled form of v1's `pullDemandedFirstRunComputations` +
`hasDemandedParentContext`. v1's *continuation* set
(`pullDemandedContinuationComputations` — "child wrote what the already-run
parent sampled") is **not needed at all**: the child's commit emits change
records; the parent's read set overlaps them; the parent becomes invalid; the
parent is live; the running pass picks it up (§7.2). Continuations were a
patch for the speculative-fanout model, not a real concept.

---

## 6. Invalidation

### 6.1 The change channel

The scheduler subscribes once to the storage manager. Every notification kind
(`commit`, `pull`, `integrate`, `revert`) carries concrete changes with
before/after values; local commits are emitted **synchronously at local
apply** (today's behavior). Processing each change:

```
for change in notification.changes:
  readers = readerIndex.match(change)          // path-overlap + value compare
  for N in readers:
    if change.sourceNodeId == N.id: continue   // P5 self-suppression
    markInvalid(N, change.address)
  if readers ≠ ∅ and any reader is runnable: tick()
```

`readerIndex.match` keeps v1's trigger-index semantics exactly (they are
correct and well-tested): deep reads match on `deepEqual` at the registered
path with reachability-transition handling; shallow reads match on same-path,
ancestor-path, or child-key-set changes.

`markInvalid(N, cause)`:

```
N.invalidCauses += cause                       // CFC §8.9.2 accumulation
if N.status == "clean": N.status = "invalid"
```

Nothing else happens at invalidation time. No transitive marking, no effect
scheduling, no history append. A dormant node accumulates `invalid` + causes
and sits there at zero cost (D5).

Reverts need no special handling: a revert's changes transition values back,
the comparison fires, affected readers re-invalidate, and the optimistic
chain re-settles.

### 6.2 First-run dependencies — no prefetch

v1 discovers a new node's reads by running a `populateDependencies` callback
that performs a full schema-driven read (`get({ traverseCells: true })`),
following every link — a deep fetch of the entire input closure per node per
piece start, before any run. The justification was (a) topological placement
of first runs and (b) historically, discovering arbitrary deep write targets.
(b) is gone: outputs are static (P4) and side-writes are declared (§4.3).
For (a), v2 uses what is statically known:

- A never-ran node's ordering edges come from `declaredReads` — the input
  links recorded in the node's bindings at instantiation. These are already
  in memory; deriving edges from them costs no I/O.
- If declared edges under-approximate (a link hop the binding didn't
  mention), the consequence is bounded and self-healing: the node may run one
  iteration early, the upstream run's changes re-invalidate it, and the same
  pass re-runs it (§7.2). One wasted run in a rare case, versus v1's
  guaranteed full-closure fetch in every case.

The deep prefetch survives in exactly one place: event-handler preflight
(§7.5), where consistency-before-dispatch (D7) genuinely requires knowing the
read closure ahead of an un-re-runnable action — and there it is cached
(§7.5).

---

## 7. Execution

### 7.1 The pass

One pass per tick. Single-run-at-a-time global execution (one in-flight
transaction; runs may be async and are awaited). Structure:

```
pass():
  for iter in 0..MAX_ITERS:
    workSet = collectWorkSet()
    if workSet is empty: break
    order = toposort(workSet)
    for N in order:
      if not runnable(N) at this moment: continue   // re-check at turn (§7.3)
      runNode(N)
  dispatchHeadEventIfReady()                        // §7.5
  runIdleMaterializersIfNoPrimaryWork()             // §4.3
  scheduleWakeOrResolveIdle()                       // §8.4
```

### 7.2 Work set

```
collectWorkSet():
  seeds = { N : N.status ∈ {invalid, never-ran} ∧ live(N) ∧ eligible(N) }
  closure = seeds ∪ { live R reachable downstream from seeds via node edges }
  return closure
```

The downstream closure is included **for ordering and single-pass completeness
only**: a clean effect downstream of an invalid computation is placed *after*
it in the order, so if the computation's run changes its output (invalidating
the effect synchronously via P1), the effect runs in the same iteration. If
the output doesn't change, the effect is still clean at its turn and is
skipped (§7.3). This recovers v1's "conditional effect" precision — *effects
run iff their actual inputs changed value* — without the watermark history,
because the run-gate is the node's own value-accurate `invalid` bit.

Node edges for the closure and the sort: writer→reader edges derived from the
1:1 output map plus reader index (maintained incrementally as read deltas are
applied), plus materializer envelope edges (ordering only), plus
`declaredReads` edges for never-ran nodes.

### 7.3 Run gate and run

```
runnable(N) = N.status ∈ {invalid, never-ran} ∧ live(N) ∧ eligible(N)
            ∧ N.runBudget.passRuns < PASS_RUN_BUDGET
```

`runNode(N)`:

1. `causes = take(N.invalidCauses)`; `N.status = clean` (set *before* the run:
   changes committed by the run itself are self-suppressed via P5; changes
   from elsewhere during the run legitimately re-invalidate).
2. Open transaction `tx = runtime.edit()`, stamp `tx.nodeId = N.id`,
   `tx.addCfcTriggerReads(causes)` (§10).
3. Invoke `N.fn(tx)` in the harness (await if async).
4. Build the run log from the transaction; **apply the read delta** to the
   reader index and node edges (P6); update liveness refcounts for edge
   deltas.
5. Commit optimistically. The local apply emits change records synchronously
   → downstream invalidation happens *here*, through the one channel, before
   the next node in `order` runs.
6. On commit rejection (conflict): restore `causes` into `invalidCauses`
   (the retry exists because of them), `N.status = invalid`, consume retry
   budget, tick. On `RetryImmediately` (name-resolution signal): same shape.
   On exception: report through error handlers; node keeps its registered
   read set (it stays subscribed); status stays clean until something it read
   changes — plus a bounded-retry policy for transient failure classes.
7. Under persistence, attach the observation to the transaction (§9.3).

Note what is *absent* from the run path relative to v1: no
resubscribe/unsubscribe, no changed-write diffing and reader-marking (the
channel does it), no demand-context entry/exit sets, no first-run/continuation
set deletions, no conditional-scheduling cleanup.

### 7.4 Ordering rules

Topological sort over the work set with:

1. **Data edges win.** Writer-before-reader from output/read overlap.
2. **Parent tie-break.** Within cycles, prefer nodes whose creating parent is
   already placed (D4: parents may unregister/replace children; running the
   parent first avoids running doomed children). Identical to v1's rule,
   which is sound.
3. Deterministic fallback on remaining ties (registration order).

### 7.5 Events

The event queue is global FIFO with per-event retry budget, unchanged in
contract from v1. Per pass, only the head event is considered (strict
ordering):

1. **Preflight.** Compute the handler's read closure: the last dispatch's
   logged read set when available (cached per handler; invalidated when the
   handler is re-registered), else populate via declared input links and the
   `$event` schema closure (the one surviving deep-read, scoped to the event
   payload). Run in a read-only, commit-as-no-op transaction (CFC-inert,
   as today).
2. **Consistency gate.** Treat the closure as a transient demand root: any
   invalid live-or-not upstream nodes of the closure join the pass's work set
   (they are demanded *by the event*). If any are ineligible (time-gated),
   park the head event with `notBefore = min eligibleAt` and set the wake
   gate; the queue stays FIFO.
3. **Dispatch** once the closure is clean: presync handler inputs
   (`presyncInputs`, unchanged), run the handler in an immediate transaction
   stamped with the handler's id, commit optimistically (changes propagate
   through the one channel), retry by re-queueing at head on rejection,
   then run the internal `onCommit` callback (success or exhausted failure;
   no external side effects — unchanged contract).

The preflight read-closure cache is the v2 answer to "preflight is a deep
fetch on every event": steady-state events hit the cache; the deep walk runs
only on first dispatch or topology change. Cache correctness is the same
argument as §6.2 — an under-approximated closure can only come from the
closure changing, in which case the previous dispatch's log is stale by
exactly the data that changed, which is invalid in the graph and pulled
anyway, or it is corrected on the next dispatch. (If a stronger guarantee is
wanted for specific handlers, they can opt into populate-every-time.)

### 7.6 Convergence bounds

- `MAX_ITERS` iterations per pass (default 10).
- `PASS_RUN_BUDGET` runs per node per pass (small, default 5 — v1's 100 was a
  backstop, not a design point; with value-gated re-runs a node that runs 5×
  in one pass is cycling, not converging).
- Exhaustion (iterations or budget): remaining runnable nodes keep
  `status = invalid` and receive an escalating backoff gate
  (`gate.backoffUntil`, ×2 per consecutive exhaustion, capped); one wake is
  scheduled; `scheduler.non-settling` telemetry fires once per episode.

No node is force-run or force-cleaned. A non-converging subgraph degrades to
rate-limited convergence attempts while the rest of the system stays
responsive; an eventually-consistent graph eventually wins.

---

## 8. Time gates

### 8.1 One primitive

```
eligibleAt(N) = max(
  N.gate.debounceReadyAt ?? 0,    // reset on each invalidation while gated
  N.gate.throttleReadyAt ?? 0,    // lastRunAt + throttleMs
  N.gate.backoffUntil ?? 0,       // §7.6
)
eligible(N) = now ≥ eligibleAt(N)
```

### 8.2 Policies (all writes into the same gate)

- **Manual debounce / throttle** — per node, via registration options or the
  control API; persisted as part of the observation (§9.3).
- **Auto-debounce** — effects (never computations, never `cell.pull` roots)
  averaging above a threshold after K runs get a default debounce unless
  opted out. Pure policy: adjusts `gate.debounce`.
- **Cycle backoff** — replaces v1's cycle-aware debounce *and* cycle breaker
  with the §7.6 escalating gate.

### 8.3 Semantics

Debounced/throttled nodes are simply ineligible: they stay `invalid`, are
skipped by `collectWorkSet`, and nothing downstream of them runs early
(downstream is only invalidated by actual changes, P2). A parked head event
(§7.5) is the same condition surfacing through the event path.

### 8.4 One wake timer

At pass end, if no work is runnable now but some `invalid ∧ live` node (or
parked head event) has a future `eligibleAt`, set a single timer for the
minimum. `idle()` resolves when: no run in flight, no background piece-start
task, no tick queued, no runnable work now, and no parked event — i.e.
exactly v1's contract with the special cases collapsed into the gate
primitive. Dormant invalid computations (not live) never hold `idle()` open.

---

## 9. Persistence and rehydration

The durable model is `docs/specs/persistent-scheduler-state.md`; v2 keeps its
architecture (observation rows attached to commits, server-side read/write
indexes for dirtying inactive pieces, durable dirty/stale markers, fingerprint
validation) and shrinks the per-observation payload.

### 9.1 Node identity

Unchanged from the persistent-state spec v1 identity: owner space, branch,
piece id (result-cell scope:id), process generation, action id with
implementation hash preferred (`impl:` > `src:` > derived). The runtime
fingerprint loses its `pull`/`push` mode component (only one engine exists);
the fingerprint string is versioned so v1 observations are simply misses.

### 9.2 Start modes

- **`fresh`** (new piece, locally re-run after stop): nodes register
  `never-ran`; demand decides everything else.
- **`resume`** (piece loaded from storage): the runner awaits the space's
  sync **once per piece** before registering nodes (subsumes v1's per-action
  `awaitSync` + shared-deadline machinery), then registers each node in
  resume mode: look up the observation; on fingerprint match, install
  `reads` (+ gate config) directly into the indexes, set `status = clean`,
  or `invalid` if durable dirty markers say so; on miss/mismatch/timeout,
  degrade that node to `fresh`.

Rehydrated-clean nodes cost index inserts only. The v1 race-guard apparatus
(per-action rehydration tokens, superseded checks, per-action timeout sharing)
collapses because resume is a piece-level phase that completes before the
piece's nodes can be scheduled at all.

### 9.3 Observation payload (slimmed)

Per node: identity, kind, `reads` (+depth), gate config, status
(`success`/`failed` + error fingerprint), watermark seq. Dropped relative to
v1: `currentKnownWrites`, `declaredWrites`, write-set history (outputs are
static — derivable from the piece's process graph), and the mode fingerprint.
`sideWriteEnvelope` is declared metadata and also needs no observation copy,
but keeping it inline is acceptable as a denormalization if graph-snapshot
lookup at rehydration time is not yet available.

Observations attach to the run's transaction at commit (including no-op
commits, which the memory layer accepts for observation carriage — unchanged).

---

## 10. CFC integration

- **Trigger reads (§8.9.2 of the CFC spec).** `invalidCauses` *is* the
  trigger-read set: the addresses whose changes made this node invalid.
  Consumed into the run's transaction at start (`addCfcTriggerReads`),
  restored on retry (commit rejection / RetryImmediately) because the retry
  still exists because of them. Self-suppressed changes (P5) never enter
  `invalidCauses` — a change that did not cause scheduling must not taint it.
- **`attemptedWrites`** remain CFC prepare/digest evidence only — never
  dependency or scheduling evidence. v2 removes the one v1 use that blurred
  this (dependency prefetch marking output reads as attempted writes).
- **Event preflight transactions** commit as no-ops and stay out of CFC
  gating (unchanged).
- The implementation-identity stamping on run transactions
  (`setCfcImplementationIdentity`) is runner-level and unchanged.

---

## 11. Invariants

**I1 — Live consistency.** At quiescence (no runnable work, no parked event),
every live node's last run observed inputs equal to the current committed
values of its read set.

**I2 — Dormancy.** A node that is never live never runs. Registration,
invalidation, and unregistration of dormant nodes perform no reads of cell
data.

**I3 — Value-gated execution.** A node with at least one completed run only
re-runs if a value in its registered read set changed (per §6.1 comparison
semantics) or its commit was rejected. Corollary: a computation producing
unchanged output triggers no downstream runs.

**I4 — Event ordering & consistency.** Handlers dispatch in global queue
order. Before dispatch, every invalid node upstream of the handler's read
closure has been run (or the event is parked; it is never skipped or
reordered).

**I5 — Self-stability.** A run's own committed changes never invalidate the
node that produced them. A run that writes only its output with unchanged
values causes no scheduling activity at all.

**I6 — Bounded non-convergence.** A pass executes at most
`MAX_ITERS × |workSet| ` runs and at most `PASS_RUN_BUDGET` runs of any single
node; non-converging subgraphs continue only behind escalating time gates and
never starve events, other subgraphs, or `idle()` (which excludes gated work).

**I7 — Restart equivalence.** Resuming a piece whose observations validate
yields the same set of future runs as a process that had stayed alive
(modulo durable-dirty markers accrued while down). Resuming with invalid or
missing observations degrades, per node, to fresh registration — never to
incorrect cleanliness.

**I8 — Provenance.** Every scheduler-initiated transaction carries the
originating node id and the trigger-read addresses that caused the run.

**I9 — Ordering within a pass.** If M and N are in the same work set with a
data edge M→N, M runs (or is skipped as clean/ineligible) before N in that
iteration.

---

## 12. Component structure

Nine components with explicit interfaces; the Scheduler facade composes them.
(Replaces v1's pattern of ~25 ad-hoc state-bundle closures over a shared
field bag.)

| Component | Owns | Key operations |
| --- | --- | --- |
| `registry` | Node records, identity, lifecycle | `register`, `remove`, `get` |
| `graph` | Reader index (trigger semantics), 1:1 writer map, envelope index, node edges, liveness refcounts | `applyReadDelta`, `match(change)`, `edgesFor`, `liveRefDelta` |
| `invalidation` | Storage subscription → `markInvalid` + tick | `onNotification` |
| `settle` | The pass: work set, toposort, run-gating, iteration/budget bounds | `pass()` |
| `runner` | One-tx run, commit watch, retries, read-delta handoff, observation attach | `runNode` |
| `events` | FIFO queue, preflight + closure cache, dispatch, parking | `queueEvent`, `addHandler`, `headEventStep` |
| `gates` | Time-gate state, policies (manual/auto/backoff), the single wake timer | `eligibleAt`, `applyPolicy`, `scheduleWake` |
| `persistence` | Observation build/lookup, fingerprints, resume flow | `rehydrate`, `attachObservation` |
| `introspection` | Stats, traces, graph snapshot, non-settling detection, idempotency check | read-only over `registry`/`graph` |

Dependency direction: `settle` → {`registry`, `graph`, `gates`, `runner`,
`events`}; `invalidation` → {`graph`, `registry`, `gates`};
`introspection` → read-only everything. No component reaches back into the
facade.

---

## 13. Public API (target)

```typescript
class Scheduler {
  // Lifecycle
  register(node: NodeSpec, opts?: RegisterOptions): Cancel;
  remove(node: NodeRef): void;
  dispose(): void;

  // Events
  queueEvent(link, event, opts?): void;
  addEventHandler(handler, link, opts?): Cancel;

  // Demand & flow
  idle(): Promise<void>;
  pullOnce(read: () => void): Promise<void>;   // backs cell.pull()

  // Gates
  setDebounce / clearDebounce / setThrottle / clearThrottle / setNoAutoDebounce

  // Introspection (stable diagnostic surface)
  getGraphSnapshot(); getStats(); getActionStats();
  setTraceEnabled(kind, on); getTrace(kind);
  runDiagnosis(); idempotencyCheck controls; breakpoints;

  // Hooks
  onError(fn); onConsole(fn);
}
```

Gone from the v1 surface: `enablePullMode`/`disablePullMode`/
`isPullModeEnabled` (one engine), `subscribe(action, populateDependencies)`
(replaced by `register` with static `NodeSpec`: kind, output, declared reads,
envelope — no populate callback for reactive nodes), `resubscribe`
(internal), `run(action)` (internal to settle; tests use demand or a test
hook), `getMightWrite` (meaningless under P4; snapshot exposes outputs).

---

## 14. What v2 deletes, and why it is safe

Summary table; the full per-mechanism walkthrough with file references is in
[`current-system-inventory.md`](./current-system-inventory.md).

| v1 mechanism | v2 disposition | Safety argument |
| --- | --- | --- |
| Push mode (5 modules, mode branches, APIs) | Deleted | Pull is the only production mode; push exists only as test toggles. |
| `pending`/`dirty`/`stale` + upstream-stale counts | One `status` + liveness refcount; downstream closure per pass | P2: reachability never decides runs, so transitive marking has no decision left to make. |
| `scheduleAffectedEffects` + `conditionallyScheduledEffects` + `changedWritesHistory` | Deleted | Effects run-gate on their own value-accurate invalid bit (§7.2/§7.3) — same observable filter, no watermarks. |
| Post-run `recordChangedComputationWrites` / `markReadersDirtyForChangedWrites` | Deleted | Local commit notifications are synchronous + value-bearing (P1); the channel already delivers exactly this. |
| `pullDemandedFirstRunComputations` / continuation set / `activePullDemandActions` | Provisional demand (§5.3) | Continuations are ordinary invalidation under P1; first-run demand is creation-context inheritance. |
| `populateDependencies` deep prefetch for reactive nodes | `declaredReads` ordering hints | Convergence loop corrects under-approximation (§6.2); outputs no longer need discovery (P4). |
| `inFlightSources` + change-group self-skip | `tx.nodeId` (P5) | One tx per run already holds; the id is already stamped (`debugActionId`) — promote, don't parallel-track. |
| unsubscribe/resubscribe around runs + memoized trigger diff | Read-delta application (P6) | The diff already exists (trigger-index memo); make it the primitive. |
| `SchedulerWriteIndex` current-known/historical/backfill/ancestor-pruning | 1:1 output map + declared envelopes | P4 (user-confirmed direction; enforced in migration phase 1). |
| Cycle breaker + cycle-aware debounce + effect pre-clear cycle detection | Budgets + escalating backoff gate (§7.6, §8) | Bounded-rate convergence preserves liveness without bespoke surgery. |
| 3 timer systems (debounce timers, computation trailing flush, event wake) | One gate + one wake timer (§8) | All were expressions of `eligibleAt`. |
| Per-action rehydration tokens/timeouts/awaitSync race guards | Piece-level resume phase (§9.2) | Sync-before-register makes per-node racing impossible by construction. |

---

## 15. Open questions

1. **Single-output enforcement.** P4 is assumed per current direction (one
   write redirect = the action's internal cell; #3911 landed per-internal
   cells). Migration phase 1 must verify no pattern in the corpus binds one
   node's result into multiple target documents, and make multi-target
   bindings a compile-time error in the transformer rather than a runtime
   surprise.
2. **Effect speculation contract.** v1/v2 both run effects against
   locally-committed-but-unconfirmed state. Should the spec promise a
   server-confirmed mode for designated effects (e.g. payment-ish UI), or is
   the post-commit outbox the only sanctioned path? v2 keeps v1's stance
   (outbox only) but the contract should be stated in pattern-facing docs.
3. **Preflight cache strictness.** §7.5 allows last-log closures for handler
   preflight. Are there handlers whose consistency requirement is strict
   enough to mandate populate-every-time (opt-in flag), and should the
   transformer emit that flag for handlers reading through dynamic links?
4. **Provisional-demand expiry edge.** A parent may create a child whose
   output is read only by a node created even later in the same pass. Expiry
   "at end of creating pass" vs "at first run" changes whether the child can
   go dormant prematurely. Default proposal: expire at end of the creating
   pass *or* first run, whichever is later; needs a fixture during phase 3.
5. **Global run serialization.** v2 keeps one-run-at-a-time. Per-space
   parallelism is structurally possible (transactions are per-commit, the
   channel is ordered per space) but interacts with cross-space reads;
   explicitly out of scope until the single-engine design is proven.
6. **`schedulerHistoricalMightWrite`.** The experimental flag and historical
   write tracking die with the write index. Confirm no diagnostic consumer
   (toolshed dashboards?) reads `getMightWrite` in historical mode before
   removing rather than stubbing.
