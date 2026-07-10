# Scheduler v2 — Demand-Driven Transactional Reactive Scheduling

> **Status**: Proposal (design spec, not yet implemented)
> **Replaces (once implemented)**: the behavior described in
> `docs/history/specs/pull-based-scheduler/README.md`
> **Companion records** (archived point-in-time documents):
> [`current-system-inventory.md`](../../history/specs/scheduler-v2/current-system-inventory.md)
> — every mechanism in the v1 scheduler and what subsumes it here;
> [`migration-plan.md`](../../history/specs/scheduler-v2/migration-plan.md) —
> the executed v1→v2 phase plan;
> [`implementation/`](../../history/specs/scheduler-v2/implementation/00-README.md)
> — the executed work orders (start at `00-README.md`).
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

**P4 — One node, one static write surface.** A computation's writes fall into
three tiers, all fixed for the node's lifetime: its single primary output
document (its internal/result cell, per the per-internal-cell model of #3911 —
the pattern builder structurally allows only one output redirect, so this
needs no enforcement); statically-resolvable side-write targets (a passed-in
cell bound to a fixed link — just additional output documents); and declared
materializer envelopes for dynamic side-writes (§4.3). A registration-time
immediate `ReactivityLog` is also a declaration channel: when action
annotations do not supply a write surface, the log's writes seed the same
static surface, and later run logs never broaden it. What disappears is not
side-writing — it is *write-set discovery*: nothing about what a node can write
is learned from runs, so current-known/historical write tracking disappears
and the writer index is a static map. The price of side-writing is the
idempotency contract (§4.2), which the idempotency validator enforces in tests.

**P5 — Self-identification through the transaction.** Every run's transaction
carries a reference to its originating node (object identity, not an id
string — diagnostic ids can collide across instances of the same source).
Change records derived from that transaction do not invalidate the
originating node. This single mechanism replaces the scheduler-internal
in-flight-source tracking. The `changeGroup` option remains, but as what it
actually is: a user-facing suppression feature for external subscribers
(e.g. a collaborative editor's sink filtering out its own edits), not
scheduler plumbing.

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
// Shown at module scope.
interface SchedulerNode {
  id: NodeId;                    // durable identity (§9.1)
  kind: "computation" | "effect";
  fn: (tx: IExtendedStorageTransaction) => unknown;

  // Static for the node's lifetime:
  outputs: DocumentRef[];        // primary output + static side-write targets;
                                 // empty for effects (§4.3)
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

**Computations** are transformations: read through schemas, return a result
that the runner writes to the node's primary output document, optionally
side-writing through cells passed to them. Required contract (already the
documented contract in v1): *idempotent* — re-running against unchanged
inputs produces the same writes, including side-writes. The scheduler may run
a computation any number of times. lift/computed/derive, the list builtins
(`map`/`filter`/`flatMap`), and raw builtins (fetch, llm, …) register as
computations. A computation whose run produces *unchanged* values generates
no change records (the storage layer already elides no-op writes), so
downstream stays clean — equality cutoff falls out of P1+P2 rather than
being a separate mechanism.

The idempotency contract is enforced by the **idempotency validator**, which
v2 keeps: the inline recheck mode re-runs every computation a second time
against post-commit state and diffs the writes (today
`enableIdempotencyCheck` / `runIdempotencyCheck`, wired into `cf test`
including the multi-user runners and the `expect-non-idempotent` assertion).
This is a test strategy rather than a production gate, but it is the thing
that makes "computations may run any number of times" a checked property
rather than a hope.

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

### 4.3 The write surface: three tiers

A computation's write surface is fixed at registration and has up to three
parts:

1. **Primary output** — the node's internal/result cell. The pattern builder
   structurally produces exactly one output redirect per node (the
   transformer cannot bind to multiple outputs), so this is a given, not an
   enforced invariant.
2. **Static side-write targets** — writable cells passed in whose links
   resolve at instantiation time (v1's `collectStaticRedirectWriteTargets`).
   These are simply *additional output documents*: they enter the writer map
   and the reader-edge graph exactly like the primary output, so demand
   flowing from readers of a side-written document reaches the writer the
   normal way. A node with static side-writes needs no standing demand.
3. **Materializer envelopes** — declared write envelopes for computations
   whose side-write targets are dynamic or broad (the function navigates a
   large structure behind a passed-in cell and may modify a small part
   anywhere within it). Membership and envelopes are **declared**
   (transformer capability analysis / module annotations, as in v1), never
   inferred from observed writes. v1's tiering rule carries over: a node
   with declared envelopes treats the envelope as its side-write surface
   (static target resolution is skipped); otherwise statically-resolvable
   writable inputs become tier-2 targets.

All three tiers require the §4.2 idempotency contract. Tiers 1–2 are ordinary
graph participants. Materializers (tier 3) are the one place where "who
writes X" is not answerable by the static output map, and they get three
special rules, and only these:

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
// Shown as interface or class members.
register(node: NodeSpec, opts: {
  mode: "fresh" | "resume";       // §9.2
  gate?: { debounce?: ms; noDebounce?: boolean; throttle?: ms };
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
        ∨ ∃ registered node R: R.reads overlaps one of N.outputs ∧ live(R)
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
constructing this subgraph (D4). Provisional demand expires at the **later**
of the node's first completed run and the end of its creating pass (resolved
decision 4). A provisionally-demanded node is runnable, so it normally runs
within its creating pass and expiry coincides with the pass end — keeping it
through the whole pass lets nodes created later in the same pass become its
readers before dormancy is decided. If a time gate defers the node past its
creating pass, provisional demand persists until that first completed run,
so the materializing run is never lost.

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
read closure ahead of an un-re-runnable action (§7.5; caching it is a
permitted later optimization).

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
  // Bounded downstream closure: add each invalid node's direct live readers,
  // but recurse past a reader only if it is itself invalid/never-ran.
  closure = seeds
  walk downstream from each seed via node edges:
    add live reader R to closure
    recurse past R only if R.status ∈ {invalid, never-ran}
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

The closure is **bounded to the active wavefront**: a clean live reader is
added (tier 1 — so it can run *this* iteration if its now-invalid direct
upstream changes it), but the recursion does **not** descend past it into the
clean *tail* of the cone. A clean reader cannot become runnable until it
actually runs, and when it runs and changes value P1 invalidates *its*
readers, which the loop re-seeds the next iteration. So the per-pass closure is
the invalid set plus one clean tier, not the whole transitive live cone — this
restores the bound v1's (now-deleted) staleness pruning provided, **without**
re-adding any per-data-change transitive marking. Tier 1 is kept rather than
pruned because some clean readers must be scheduled in the same pass as the
write that feeds them — notably materializer-output readers (a normal reader of
a cell a materializer eagerly writes; see the cutover guard "should schedule
normal output readers when a materializer input dirties"). Without staleness
pruning the unbounded cone is `O(fan-out)` per pass; under a wide-fan-out hub
(one tally many clean readers observe) the bound is what keeps the per-pass
work-set near v1 size (decision 16).

Node edges for the closure and the sort: writer→reader edges derived from the
static output map plus reader index (maintained incrementally as read deltas
are applied), plus materializer envelope edges (ordering only), plus
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

Events are dispatched per **ordering lane**. A lane is a FIFO queue with a
per-event retry policy (no retry count: a stale-basis commit failure retries
within a bounded backoff window, everything else drops fast — see the
rejection taxonomy in §7.6). There is exactly **one lane today** (lane =
everything), so observable behavior is v1's global FIFO unchanged — but the
spec states ordering, consistency gating, parking, and (future)
confirmed-commit dispatch *per lane*, so that relaxing ordering later is a
policy change, not a contract change. Decided: the first relaxation step,
when contention warrants it, is **per-space lanes** (per-piece is too
granular to buy much; finer schemes like handler-closure-overlap need
evidence first). An opt-in server-confirmed dispatch mode would occupy only
its own lane while others proceed. Nothing in v2 may assume "the head
event" is globally unique — components address "the head of a lane".

Every event gets a durable **event id minted at send time**, causally
derived from the originating context: the sending transaction's id (or the
external ingress id for events not born in a transaction), the stream link,
and a per-origin sequence number. The id orders events within a lane,
carries speculation lineage, derives receipt ids (§7.6), and names the
event in telemetry.

Per pass, for each lane's head event:

1. **Preflight.** Compute the handler's read closure in a read-only,
   commit-as-no-op transaction (CFC-inert, as today): declared writable-input
   links when present, else the `$event`-scoped schema closure — the one
   place a deep schema read survives in v2. **Default is
   populate-per-dispatch** (v1 behavior). Reusing the previous dispatch's
   logged closure is a permitted *implementation optimization*, adopted only
   behind the preflight benchmark and off by default: the consistency gate
   is the one place where an under-approximated closure weakens a
   user-visible guarantee (I4), so correctness-by-default wins until the
   cache is proven.
2. **Consistency gate.** Treat the closure as a transient demand root: any
   invalid upstream nodes of the closure join the pass's work set (they are
   demanded *by the event*, live or not). The invalid-upstream set is computed
   by **inverted reachability** from the maintained invalid-node set into the
   closure — not an upstream walk of the closure's cone, which is O(graph)
   against a hub (decision 15). If any are ineligible (time-gated),
   park the lane's head with `notBefore = min eligibleAt` and set the wake
   gate; the lane stays FIFO. The gate also covers **replica staleness**
   (CT-1795): addresses in the closure with in-flight replica loads park the
   head, and load completion — a definitively absent document counts as
   complete — is the wake source (same shape as the lineage park's
   origin-commit callback; a timeout backstop fail-opens). Computations need
   no such gate (they self-heal through the one channel when the load
   lands); handlers are at-most-once. Because preflight itself kicks
   fire-and-forget pulls on cold reads, a key that settled once while the
   event was head never re-parks it — otherwise each pass would re-arm the
   park on its own freshly kicked load, a livelock.
3. **Dispatch** once the closure is clean: presync handler inputs
   (`presyncInputs`, unchanged), run the handler in an immediate transaction
   stamped with the handler's id, commit optimistically (changes propagate
   through the one channel), retry a stale-basis rejection by re-queueing at
   the lane head (backoff-parked via `notBefore`), then run the internal
   `onCommit` callback (success or final failure; no external side effects —
   unchanged contract).

### 7.6 Event-initiated work and commit failure

A handler run can *launch* work that escapes its transaction: events sent to
streams, and pieces instantiated from its result (the runner's `postRun`
path). The handler's **data** writes are atomic with its commit and roll
back for free; the launched work is control flow, and v2 makes its failure
semantics explicit.

Requirements: invariant I10 (launched work survives only if the launching
commit succeeds, and descendants of a failed attempt are never retried) and
invariant I11 (events are handled at most once system-wide; the
result-cell receipt is the witness — default-on, decision 14).

Current state, for the record (verified in code, June 2026):

- *Sent events* are queued at send time (`Cell.set` on a stream calls
  `scheduler.queueEvent` immediately, `cell.ts:1167`), ungated on the
  sender's commit. A handler whose commit is rejected and retried queues its
  follow-up event once per attempt (duplication), and a follow-up queued by
  a permanently failed attempt still dispatches — possibly with a payload
  computed from rolled-back state. The storage layer's dependent-speculation
  rejection does **not** close this: it rejects a follow-up only when its
  handler *read* the parent's unconfirmed writes; a handler that consumes
  only the event payload (computed during the parent's run, embedded in the
  event value) has no read edge to the parent and escapes. This violates
  I10 today.
- *Handler-result pieces* are instantiated inline in the handler's
  transaction (data atomic — good), but their scheduler registrations are
  eager. The on-commit-error cleanup (cancel + stop) exists only in the dead
  push-mode branch (`runner.ts:2724-2729`); the pull path ties teardown only
  to the handler node's lifetime (`runner.ts:2735`). Convergence after a
  failed commit relies on retry + cause-derived deterministic ids
  (`{ resultFor: cause }` + `startCore`'s already-running check); a commit
  that never lands (retry window elapsed, or a fast-dropped rejection)
  leaves a registered piece running against rolled-back data. The
  commit-gated mechanism already exists (`startAfterSuccessfulCommit`) but
  is used only for `navigateTo` results.
- *Exactly-once handling* does not exist at all: a re-delivered event
  (cross-runtime or ingress retry) is handled again wherever it lands.

The design rests on two shared pieces of infrastructure — durable event
identity (§7.5) and a **rejection taxonomy**: commit rejections split into
*stale-basis* (a server-side conflict or the local
StorageTransactionInconsistent guard — re-running against fresher confirmed
state can succeed, so it retries with capped exponential backoff within a
bounded window, then surfaces a terminal CommitConvergenceError),
*terminal* (a deterministic commit-rule refusal — never retried, surfaced),
*non-retryable* (every other non-permanent rejection — deterministic with
respect to confirmed state, drops on the first attempt), and
*permanent* (a commit-time precondition failed — drop, never retry).

**Speculation lineage.** Follow-up work dispatches immediately and
speculatively, exactly as today — no added latency for resend chains — and
correctness comes from cancellation, not staging:

1. An event sent during a transaction carries that transaction's id as its
   *origin*. Dispatch policy depends on where the event's handling commit
   will land relative to the origin:
   - **Same-space origin** (the common resend chain): dispatch immediately
     and speculatively, exactly as today. The handler transaction carries a
     commit-time precondition — *origin committed* — verified by the
     memory engine; violation is a permanent rejection. Same-session
     commits are processed in order, so the origin's fate is already
     decided when the follow-up's commit arrives: the check is free.
   - **Cross-space origin**: the event **parks until the origin commit is
     confirmed**, then dispatches with ordinary semantics in the target
     space; if the origin fails, the parked event is dropped via the
     lineage registry. No cross-space server verification is needed: the
     local runtime is the sole holder of the event (queues are in-memory
     and events do not travel between runtimes), so withholding release
     until confirmation closes the gap completely — cross-space descendants
     of a failed origin never dispatch at all. This mirrors the existing
     cross-space write protocol (child-space commit first, then the
     handler transaction — `enableCrossSpaceChildCommit`) and shares its
     accepted latency: one confirmation round trip on the cross-space hop.
     Both are instances of one rule: *the depended-upon commit becomes
     durable before the depending action proceeds.* Parking uses the same
     head-parking mechanism as time-gated dependencies; under the single
     global lane this head-blocks for the round trip — accepted, and the
     concrete trigger for the agreed per-space lane split when it bites.
     (Future server-routed/cross-runtime event delivery would reopen this
     with an origin-attestation design; deferred until such a path
     exists.)
   If the send observes that its origin transaction is already settled, it
   does not create pending lineage: an already-committed origin is treated as
   confirmed immediately, and an already-failed origin is treated as failed
   immediately so descendants cancel or drop instead of waiting for a callback
   that will never arrive.
2. Client-side, the runtime keeps a lineage registry: origin tx →
   {queued events, started pieces}. When an origin's failure becomes known
   locally, undispatched descendant events (parked or queued) are cancelled
   in place and descendant pieces are stopped (the compensating cancel+stop
   that the pull path is missing today, now keyed off the same registry).
   This also improves the existing cross-space write protocol's accepted
   zombie: when the handler transaction fails *after* a successful
   child-space commit, the durable orphan data in the child space remains
   accepted, but the registry stops the locally registered piece so no
   running zombie sits on top of it. `navigateTo` results keep the fully
   commit-gated start (durability before navigation).
3. Descendants of a *failed attempt* are never retried (permanent
   rejection); when the parent itself retries and succeeds, the re-run
   emits fresh follow-ups under the new attempt's tx id. This is what
   kills the duplication: each attempt's launches are tied to that attempt,
   and only the committed attempt's launches survive.
4. Events with no transactional origin (renderer/UI gestures, external
   ingress) carry no lineage and behave as today.

Rejected alternatives, for the record: staging sends in the post-commit
outbox would serialize every handler→event hop behind a server round trip
(the outbox flush awaits the commit promise,
`extended-storage-transaction.ts:857-871`) — too slow for the trivial
resend chains that are common in practice. A "pure forwarder" fast path
(dispatch immediately iff the handler made no writes and launched nothing)
avoids that but bifurcates dispatch semantics on handler internals, and the
class becomes empty once receipts exist, since every handling transaction
writes at least the receipt (default-on). The outbox remains the
right tool for what it was built for: external side effects that *want*
server confirmation.

**Receipts (exactly-once handling).** Needed for CFC: certain events must
be handled at most once system-wide, not once per runtime that sees them.

The receipt is not a new document kind: **the receipt is the handling's
result cell.** Every event handling conceptually owns one result document —
the same `{ resultFor: cause }` cell that hosts a launched pattern when the
handler returns one; when the handler launches nothing, the cell is simply
the receipt. This gives handlers the same shape as computations: one
canonical output document per unit of work, whose creation doubles as the
exactly-once witness.

Each event is handled by **exactly one handler** (decided; multi-handler
dispatch is a future opt-in feature — if it lands, the handler id joins the
result-cell derivation). Today's `queueSchedulerEvent` silently queues one
event per matching handler; registration is tightened to enforce one
handler per stream link instead.

1. The result cell's id is causally derived from the **event id**. Today's
   handler-result cause is per-invocation but *random*
   (`{ ...inputs, $event: crypto.randomUUID() }`, `runner.ts:2995-2998`);
   substituting the durable event id (§7.5) for the random UUID is the
   whole bridge. It also makes every id minted inside the handler frame
   event-causal (the frame cause feeds id derivation for objects the
   handler creates): per-gesture uniqueness is preserved because event ids
   are unique per send, retries of the same event reuse the same ids
   instead of minting fresh ones per attempt, and duplicate handlings
   elsewhere derive the same ids — colliding exactly where intended.
2. **Default-on for all events** (no class machinery for now): every
   handling transaction creates its result cell **unconditionally**, under
   a create-only commit precondition. If it already exists, the commit
   fails with a *permanent* rejection: the client lost the race and must
   **not** retry — the event was handled elsewhere. Renderer-local UI
   events cannot race, so for them the precondition is inert and the cost
   is one small create per handling — accepted for uniformity (UI text
   input flows through two-way cell binding, not events, so the volume is
   gesture-scale). Layering — per-class refinements, receipt retention,
   alignment with the CFC exactly-once scope — is deliberately deferred
   (open question 2).
3. Retryable conflicts on other documents re-run the handler as usual; the
   re-run derives the same result-cell id from the same event id, so a
   handler's own retries never collide with themselves (the losing attempt
   never committed).
4. Receipts compose with non-durable event queues: delivery may be
   at-least-once (redelivery after restart, multi-runtime fanout); receipts
   make *handling* exactly-once, including across process restarts, without
   making queues durable. And because the receipt is the result cell, a
   redelivered pattern-launching event cannot create a second piece — the
   collision is on the very document the piece would live at.

Lineage and receipts are deliberately the same shape — commit-time
precondition, permanent rejection, no-retry client behavior, ids derived
from the event id — so they share their implementation (migration plan,
phase E).

**Computation-launched children are outside I10.** Computations are
idempotent and re-runnable; their children converge through deterministic
ids and normal re-runs, and orphaned registrations are bounded by the same
retry budget. (The exhausted-retry zombie is accepted as pre-existing; the
implementation should leave a watch-this comment at the retry-exhaustion
sites.)

All of this is independent of the v2 cutover and can land against v1 (see
migration plan, phase E).

### 7.7 Convergence bounds

- `MAX_ITERS` iterations per pass (default 10).
- `PASS_RUN_BUDGET` runs per node per pass (`= MAX_ITERS`, currently 10 —
  v1's 100 was a backstop, not a design point). A node runs at most once per
  iteration, so its per-pass run count is bounded by `MAX_ITERS` by
  construction; the budget is that bound's backstop against any
  multi-run-per-iteration path, **not** a depth limit. A budget below
  `MAX_ITERS` misclassifies a healthy deep first-run chain (which legitimately
  re-runs each downstream node once per unrolled level) as cycling, which is
  why it was raised from 5 to `MAX_ITERS`.
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
  N.gate.backoffUntil ?? 0,       // §7.7
)
eligible(N) = now ≥ eligibleAt(N)
```

### 8.2 Policies (all writes into the same gate)

- **Manual debounce / throttle** — per node, via registration options or the
  control API; persisted as part of the observation (§9.3).
- **Auto-debounce** — effects (never computations) averaging above a threshold
  after K runs get a default debounce unless `noDebounce` is set.
  `cell.pull()` sets `noDebounce: true` on its ephemeral effect, so pull roots
  opt out explicitly rather than through a write-surface proxy. Pure policy:
  adjusts `gate.debounce`.
- **Cycle backoff** — replaces v1's cycle-aware debounce *and* cycle breaker
  with the §7.7 escalating gate.

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

**I4 — Event ordering & consistency.** Handlers dispatch in enqueue order
within their ordering lane (today: one global lane). Before dispatch, every
invalid node upstream of the handler's read closure has been run, and every
in-flight replica load for an address the closure depends on has completed
(or the event is parked; it is never skipped or reordered within its lane).

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

**I10 — Event-launched work is lineage-gated.** Work launched by a handler
attempt (events sent, pieces started) may begin speculatively, but survives
only if that attempt's transaction commits: descendants of a failed attempt
are cancelled client-side or permanently rejected at commit, and are never
retried. A retried parent emits fresh launches under its new attempt. See
§7.6.

**I11 — Events are handled at most once.** At most one handling
transaction system-wide ever commits for a given event id: the create of
the handling's result cell (whose id is causal to the event id) is the
witness; receipts are on for all events. A receipt-exists rejection is
permanent: the losing client does not retry. Each event has exactly one
handler. See §7.6.

---

## 12. Component structure

Nine components with explicit interfaces; the Scheduler facade composes them.
(Replaces v1's pattern of ~25 ad-hoc state-bundle closures over a shared
field bag.)

| Component | Owns | Key operations |
| --- | --- | --- |
| `registry` | Node records, identity, lifecycle | `register`, `remove`, `get` |
| `graph` | Reader index (trigger semantics), static writer map, envelope index, node edges, liveness refcounts | `applyReadDelta`, `match(change)`, `edgesFor`, `liveRefDelta` |
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
// Shown for illustration only.
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
[`current-system-inventory.md`](../../history/specs/scheduler-v2/current-system-inventory.md).

| v1 mechanism | v2 disposition | Safety argument |
| --- | --- | --- |
| Push mode (5 modules, mode branches, APIs) | Deleted | Pull is the only production mode; push exists only as test toggles. |
| `pending`/`dirty`/`stale` + upstream-stale counts | One `status` + liveness refcount; downstream closure per pass | P2 holds for the **run** decision (effects gate on their own value-accurate invalid bit). The one reachability query that survives — the event-preflight consistency gate (§7.5/I4) — is served without per-data-change transitive marking by **inverting** it over the maintained invalid-node set (decision 15); the incremental refcount is the spec'd escalation. |
| `scheduleAffectedEffects` + `conditionallyScheduledEffects` + `changedWritesHistory` | Deleted | Effects run-gate on their own value-accurate invalid bit (§7.2/§7.3) — same observable filter, no watermarks. |
| Post-run `recordChangedComputationWrites` / `markReadersDirtyForChangedWrites` | Deleted | Local commit notifications are synchronous + value-bearing (P1); the channel already delivers exactly this. |
| `pullDemandedFirstRunComputations` / continuation set / `activePullDemandActions` | Provisional demand (§5.3) | Continuations are ordinary invalidation under P1; first-run demand is creation-context inheritance. |
| `populateDependencies` deep prefetch for reactive nodes | `declaredReads` ordering hints | Convergence loop corrects under-approximation (§6.2); outputs no longer need discovery (P4). |
| `inFlightSources` + change-group self-skip | `tx.nodeId` (P5) | One tx per run already holds; the id is already stamped (`debugActionId`) — promote, don't parallel-track. |
| unsubscribe/resubscribe around runs + memoized trigger diff | Read-delta application (P6) | The diff already exists (trigger-index memo); make it the primitive. |
| `SchedulerWriteIndex` current-known/historical/backfill/ancestor-pruning | Static write surface (outputs + envelopes) | P4: the builder already guarantees one primary redirect; static side-write targets and envelopes are fixed at registration (confirmed 2026-06-11). |
| Cycle breaker + cycle-aware debounce + effect pre-clear cycle detection | Budgets + escalating backoff gate (§7.7, §8) | Bounded-rate convergence preserves liveness without bespoke surgery. |
| 3 timer systems (debounce timers, computation trailing flush, event wake) | One gate + one wake timer (§8) | All were expressions of `eligibleAt`. |
| Per-action rehydration tokens/timeouts/awaitSync race guards | Piece-level resume phase (§9.2) | Sync-before-register makes per-node racing impossible by construction. |

---

## 15. Decisions log and open questions

### Resolved (2026-06-11)

1. **Write surface (was: single-output enforcement).** Confirmed: the
   pattern builder already produces exactly one output redirect per node —
   the transformer cannot bind to multiple outputs, so no corpus audit and
   no new enforcement is needed. Equally confirmed: computations *also*
   legally write into passed-in cells under the idempotency contract, and
   the full v1 taxonomy stays — statically-fixed passed-in cells are just
   additional outputs; dynamic/broad targets are materializer envelopes with
   eager-at-idle execution. P4 is therefore "static write surface", not
   "single write" (§4.3). The idempotency validator (inline re-run + write
   diff, `cf test` integration) is confirmed kept as the enforcement
   strategy.
2. **Server-confirmed dispatch.** Future feature, strictly opt-in — never
   the only mode. Decided now so it stays cheap later: events are specified
   per ordering *lane* with durable event ids (§7.5); a confirmed event
   would occupy only its lane. First FIFO relaxation step, when needed, is
   per-space lanes (per-piece is too granular to buy much); anything finer
   needs contention evidence.
3. **Preflight closure caching.** Default is populate-per-dispatch (v1
   behavior); caching the last dispatch's closure is an optional, off-by-
   default optimization to be adopted only behind the preflight benchmark
   (§7.5). No API decision needed now.
4. **Provisional-demand expiry.** Agreed: expire at end of the creating pass
   *or* first run, whichever is later; fixture due in migration phase 3.
5. **Run serialization.** Stays globally serialized. Actions are effectively
   synchronous today; parallelism only becomes relevant with multiple
   workers and is deliberately out of scope.
6. **`schedulerHistoricalMightWrite`.** Confirmed deletable — flag, legacy
   `getMightWrite` mode, and historical write tracking go in migration
   phase 1.
7. **Event-launch failure semantics: lineage over staging.** Staging sends
   in the post-commit outbox was rejected (it would put a server round trip
   into every trivial resend chain — the flush awaits the commit promise).
   Chosen design: speculation lineage — immediate dispatch, origin-tx
   annotation, server-verified *origin committed* precondition, permanent
   rejection class, client-side cancellation registry (§7.6). The
   pure-forwarder fast path was also rejected (bifurcated semantics; class
   vanishes under receipts).
8. **Exactly-once receipts folded in.** The CFC exactly-once requirement
   (receipt doc, id causal to the event id, create-precondition, lost-race
   = permanent rejection, no retry) is specified alongside lineage because
   the two share identity, precondition, and rejection machinery (§7.6,
   I11). Default-on for all events per decision 14.
9. **Zombie pieces on exhausted retries.** Accepted (bounded, rare,
   pre-existing); no reaper. Implementation leaves a watch-this comment at
   the retry-exhaustion sites.
10. **Effect-launched work.** No audit needed: effects re-run freely and
    deterministic ids converge the same way computation children do.
11. **Cross-space lineage: park until origin confirmed.** A follow-up whose
    handling commit lands in a different space than its origin parks until
    the origin commit is confirmed, then dispatches normally; on origin
    failure it is dropped. Sound (the local runtime is the event's sole
    holder — no speculation gap to verify server-side) and symmetric with
    the existing cross-space write protocol (child-space commit first,
    confirmed, then the handler transaction; first failure aborts, second
    failure's durable orphan is accepted — now with the lineage registry
    at least stopping the local zombie piece). Latency = one confirmation
    round trip on the cross-space hop, same accepted class of slowness as
    cross-space writes. Origin attestation is deferred until a
    cross-runtime event-delivery path exists.
12. **Exactly one handler per event.** Single-handler dispatch is the
    model; registration enforces one handler per stream link (replacing
    today's silent one-event-per-matching-handler fanout in
    `queueSchedulerEvent`). Multi-handler dispatch is a future opt-in
    feature; if it lands, the handler id joins the receipt derivation.
13. **The receipt is the handler's result cell.** Every handling owns one
    result document — the `{ resultFor: cause }` cell that hosts a
    launched pattern when there is one, and is just the receipt when there
    was nothing to launch. Implementation bridge: replace the random
    per-invocation `$event: crypto.randomUUID()` in the handler-result
    cause (`runner.ts:2995-2998`) with the durable event id, making the
    result cell and all handler-frame-minted ids event-causal (retries
    reuse ids; duplicates collide; per-gesture uniqueness preserved since
    event ids are unique per send).
14. **Receipts default-on for everything.** Every event handling creates
    its result cell under the create-only precondition — no class
    machinery for now. UI-local events cannot race (the precondition is
    inert for them; the cost is one small create per handling). Future
    layering stays open as open question 2.
15. **Preflight upstream-invalid reachability.** The event-preflight
    consistency gate (§7.5 step 2, I4) is the one surviving consumer of
    transitive-staleness reachability — P2's "reachability never decides
    runs" holds for the run decision but not for this gate. Deleting v1's
    `upstreamStaleCount` turned the gate's query into an O(graph) upstream
    walk (`collectInvalidUpstreamForLog`), O(N²) under rapid creation against
    a hub (measured: rapid-notebook, 564 ms/create). Resolution: **invert the
    walk** — reachability from the maintained invalid-node set (a
    `Set<Action>` in `NodeRegistry` updated through `setStatus`) downstream
    into the closure — cost bounded by invalid-set × observed downstream cone,
    re-adding no per-data-change transitive marking (dormancy stays zero-cost,
    D5/I2). Orthogonal to decision 3 (closure caching), which addresses
    read-closure *discovery*, a different cost. **Escalation (spec'd, not
    adopted):** if a read-side-fan-out workload (one invalid node feeding many
    closure writers) makes the inverted walk O(graph), adopt an incremental
    `hasInvalidUpstream` signal maintained the way §5.2 maintains liveness,
    scoped to live nodes — feeding only this gate, never the run decision, so
    push mode / conditional effects / watermarks stay deleted. Adopt only
    behind the preflight benchmark.
16. **Bounded settle work-set closure (2026-06-20).** The §7.2 downstream
    closure originally added the *entire* live downstream cone of every invalid
    seed, value-blind. With v1's staleness pruning deleted, that cone is
    `O(fan-out)` per settle pass; under a wide-fan-out hub (e.g. a vote tally
    that many clean readers observe, including a whole-state render sink) the
    per-pass work-set grew 3–4× vs the staleness-pruned v1 set. *Executions did
    not change* — value-gating (§7.3) already skips the clean members — but each
    pass iterated and value-checked a much larger consideration set
    (maintain-time → query-time cost shift, the dual of decision 15: there the
    eager signal's deletion inflated a *query*; here it inflated the *closure*).
    Resolution: **bound the closure to the active wavefront** — add each invalid
    node's direct live readers (tier 1) but recurse past a reader only if it is
    itself invalid/never-ran; the clean tail is re-seeded next iteration when
    its upstream actually runs and P1 invalidates it (§7.2). This is the
    walk-computed form of decision 15's `hasInvalidUpstream` signal — the
    downstream walk *is* the gate, so no maintained refcount is needed unless
    the walk itself becomes hot. Tier 1 is kept (not pruned) because
    materializer-output readers need same-pass scheduling (cutover guard "should
    schedule normal output readers when a materializer input dirties"); pruning
    tier 1 too regresses that. Measured: lunch-poll concurrent-vote peak
    per-pass work-set 62→43 / 61→49, single-runtime note-create @128 42→39 ms,
    with action-execution count and settle-iteration count unchanged; full
    runner suite green. Preserves lazy/non-transitive invalidation and the
    decision-15 dormancy guarantee. Closing the remaining gap to v1 (the kept
    tier-1 clean readers) would need value-awareness or the maintained refcount
    and is not adopted.

17. **Multi-user fan-out re-evaluation cost + push-pull completeness
    (2026-06-24).** On a multi-runtime CFC workload
    (`cfc-group-chat-demo/multi-user`) v2 runs ~2.2× the *scheduled-action
    executions* of v1 (165 vs 74) — **reproduced on clean trees**, non-windowed
    (two independent counters agree), wall **+12–16%**. Decomposed by whether the
    action site is scheduled by *both* schedulers (re-validated 2026-06-24 on fresh
    v2 @2bbc029ad vs main @d8085d3eb, per-runtime `actionStats` counts, NOT
    cross-tree node-id normalization): ~**+13 (14%)** is a real apex render-effect
    re-fire (36 vs 23 — the only *product* site that genuinely fires more on v2);
    ~**+5 (6%)** is test-harness assertion re-pulls (`multi-user.test.tsx`); the
    remaining ~**+73 (80%)** is a **scheduling-*granularity* shift, not
    over-execution** — 29 product computeds (per-row CFC labels `trusted.tsx:955-986`,
    the message `raw:map`, aggregates `main.tsx:309-386`) that v2 schedules and
    counts as *discrete reactive nodes* but that main runs **folded inline inside
    the apex pull's read-closure** (literal 0 scheduled-action runs in main's
    `actionStats`, yet 12/12 passes — same work, finer accounting). The clincher:
    counted actions are +123% but wall is only +12–16%, so the +73 folded work is
    cheap, not duplicated. The honest claim is therefore *v2 schedules ~2.2× more
    reactive nodes for the same work*, **not** *v2 re-runs computeds 2.2× more*.
    v2's memoization is sound (verified: an in-place single-row edit re-runs only
    that row's node; a clean producer's committed cell is the memo and is never
    re-invoked by a re-running consumer — see the Push-pull completeness note
    below). The finer granularity is a **tradeoff, not a strict loss**: an
    incremental single-row edit re-runs one node where main re-evaluates the whole
    apex closure.

    *Efficiency-only and accepted.* Final results are identical and single-runtime
    / static-graph workloads are neutral-to-faster (note-create @128 −22%,
    unchanged-recompute −42%, targeted-dirty-rehydrate −50%). Accepted via
    `NEW_PERF_BASELINE`.

    *Corrected mechanism — single-runtime control (2026-06-28; SUPERSEDES the
    "per-node hash/freeze + idle sync" wording below).* The decisive control: the
    regression **vanishes single-runtime** (v2 ≈ main, +1–3%, even though v2 still
    runs *more* nodes/commits there). So it is **not** raw per-node commit CPU
    (cheap in isolation) and **not** blocking on sync round-trips — commits are
    fire-and-forget (`run/commit` ends before awaiting the commit promise,
    `run.ts:94-98`; `synced()` round-trip counts are identical v2 vs main, driven
    by settle/step count, not commit count). It is the **multi-runtime
    amplification of the committed-node *count* × an expensive per-commit cost**:
    each discrete committed per-row map/render node is serialized into a
    cross-runtime push that the *peer* worker pulls and re-processes, inflating
    *both* runtimes' node/commit counts to 2.2× (165 vs 74); and each such commit
    is a VNode/render subtree paying **`prepareCfc` CFC-label work + value
    canonicalization** under `enforce-explicit` (~2.78ms vs ~0.74ms/commit), not a
    cheap value-hash. So the body-eval-CPU profile below over-weighted the
    commit-hash and mis-read the idle as blocking — it is genuinely
    multi-runtime-only. *Lever (revised):* collapse the committed-node count —
    coalesce per-row map/render computeds into the parent/apex transaction (the
    §4.8 VNode-doc consolidation direction), which cuts *both* the per-commit
    CFC/canonicalize CPU *and* the cross-runtime write fan-out; and skip re-paying
    `prepareCfc`/canonicalize on unchanged VNode subtrees. NOT sync-layer
    throttling (round-trips already batched, one `synced()` per settle).
    *Magnitude (confirmed stable, 2026-06-29):* 7 alternating warm runs give v2
    internal **5630ms** vs main **4854ms = +776ms / +16.0%** (wall +12.2%), with
    the v2 and main ranges **fully non-overlapping** (v2 min 5551 > main max
    5036) — deterministic every run, not noise. (An earlier `run-phase`-timer
    sample read as noisy because it was boot/compile-contaminated; the cf-test
    reported `(Xms)` is the stable signal.)

    *Where the +12–16% wall actually goes (CPU profile, 2026-06-28).* Confirmed
    at the function level (CDP V8 profiler inside each cf-test worker, clean
    trees) — it is the **inherent flat per-node tax of finer scheduling
    granularity**, not a hot function. v2 schedules ~73 more discrete reactive
    nodes (87 `scheduler/run` cycles, 43 native commits vs main's ~0 — main folds
    those computeds inline inside the apex pull), and **each extra node pays a full
    per-commit pipeline**: value hashing (`op_node_hash_update`, the single biggest
    frame, ~18–20% of the delta), deep-freeze, prepared-digest canonicalization,
    read-set compaction. Two components: **+466–604ms active CPU** (~2.5× main's
    compute = the sum of ~87 per-node commit cycles) and a *larger* **idle** chunk
    (workers are ~65% idle on *both* trees, blocked on cross-runtime settle/sync;
    v2's finer commits induce extra sync round-trips — the multi-user-specific
    part, absent single-runtime, consistent with single-runtime being
    neutral-to-faster). Every leaf primitive is equally efficient on both trees; no
    non-leaf frame exceeds ~6% of the delta (the 27% hashing leaf is a *symptom* of
    commit volume, not a target). **Lever:** only *coarsening* (fewer discrete
    nodes/commits — fold per-row computeds) recovers the bulk, attacking both the
    active-CPU tax and the idle round-trips — but it trades away v2's fine-grained
    incrementality (a single-row edit re-runs one node vs main re-evaluating the
    whole apex closure), so it is a tradeoff, not a free win. Runtime
    micro-optimization (deep-freeze frozen-cache memo ~+60ms, canonical-path
    interning ~+46ms) has a hard ceiling of ~150ms (~25% of active CPU, ~10% of
    wall) and touches none of the idle.

    *Root cause of the extra nodes (commit `1263d95e9`, "scheduler-v2 4.2: delete
    dependency collection").* The builder graph and node-subscription path are
    byte-identical on both trees (verified — `computed`/`lift`/`map` lower to the
    same `type:"javascript"` nodes and both trees `scheduler.subscribe()` all ~29
    sites; #3911 per-internal-cell storage is present in *both*, so storage is not
    the differentiator). The divergence is **dependency discovery**. main learned
    an action's reads by running a `populateDependencies` callback inside a
    **throwaway transaction it then aborted** (`scheduler/dependency-collection.ts`);
    when that resolution's `.get()` hit a nested per-row computed (a CFC label,
    `isMine`, an aggregate), it **evaluated that computed inline inside the aborted
    tx — value produced, but no commit, no separate `run()`, no counted run** — so
    those sites report literal 0 in `actionStats` while still computing. v2 deleted
    that whole run-to-observe path in favour of the transformer's *declared* reads
    annotation + pure P3 demand-gating. With no collect pass there is no
    inline-fold: when the live apex render propagates `liveRefs` up to the
    computeds it reads, each becomes live → demanded → **run in its own transaction
    and committed to its own internal/result cell** (#3911). So main's ~29
    inline-folded computeds become ~73 discrete committed runs in v2 — each paying
    the per-commit pipeline above. This is **deliberate and load-bearing**: the
    separate committed node *is* the per-row memo (the CHECK-skippable population
    probed 0 — v2 re-runs nothing main keeps clean, so it is real incrementality,
    not waste), and it carries per-node CFC label provenance (`addCfcTriggerReads`
    on the node's own tx) and per-node D8 rehydration state that main's inline-fold
    does not produce discretely. Coarsening it back inline — the only lever for the
    +73 — would forfeit exactly that per-row incremental-edit granularity, per-node
    provenance, and rehydration. So the 2.2× is the genuine price of v2 making
    every reactive value a persisted, independently-incremental, CFC-labelled,
    rehydratable node, not extra re-execution (actions +123% but wall only +12–16%).

    *Levers ruled out — do not re-try without new evidence.* The surplus is
    cross-runtime write volume with **no writer node to gate against** (apex
    read-set consults show `writers=0` for ~half its re-runs). Built and measured,
    all refuted: forward run-gate (165→184), reverse read-set pull-gate on effects
    (165→163) / +computations (165→181), effects-last (v2 already settles
    per-handler, with *fewer* settles than v1 — 29/31 vs 34/34), pattern
    read-granularity (0% — the count/membership closures genuinely depend on array
    length, which changes on append), and a sync-path bug (refuted — a local
    commit and a remote sync produce byte-identical invalidation). The only lever
    that would move the number is **inbound sync-apply/commit batching at the
    sync→settle boundary** — a deliberate latency/consistency tradeoff, out of
    scope.

    *Recoverable lever, kept as an option (not adopted): effect/wave-coalescing
    for the apex re-fire.* The one real *product* surplus (per the clean-tree
    re-validation) is the ~**+13** apex render-effect re-fire (the render effect
    fires ~2× per single append). The writer-gated variants above cannot reach it —
    the re-fires are direct cross-runtime cell writes (`writers=0`), so the reverse
    read-set pull-gate is ~neutral (165→163). The viable shape is a **per-wave
    render flush**: run a live, pure-render effect *once* at the settle-wave
    boundary after its invalidations are absorbed (the standard "flush effects at
    batch end"), collapsing the 2:1 over-fire. Parked prototype: `/tmp/effect-defer`
    (`CF_EFFECT_COALESCE` — hold a pure read-only sink effect, gated on
    `declaredWritesEmpty`, while a *runnable* upstream is still dirty this wave;
    proven SAFE — convergence holds, `scheduler-pull:351` stays 2, byte-identical
    tallies, no single-runtime bench regression). **Not adopted** — the win is
    small (~+13) and the +73 granularity bulk is unaffected — but **kept as the one
    viable lever** if multi-user render latency becomes a priority. *Re-entry gate:*
    a variant that collapses the apex pull from 36 toward main's 23 **without**
    regressing per-row incremental-edit granularity (a single-row edit must still
    re-run only that row's node).

    *Push-pull completeness (Track 1 — measured NO-GO).* v2 lacks the classic
    3-color (clean/check/dirty) machinery — no CHECK color, no per-node output
    cache/version (`NodeStatus = never-ran | clean | invalid`; `SchedulerNode`
    carries no `cachedValue`). But it is **outcome-complete**: it performs the
    value-check **eagerly at the write channel** (`determineTriggeredActions` / the
    trigger-index emit a change-delta only for readers whose read value actually
    changed) where classic signals do it **lazily at pull** via the CHECK color.
    The storage cell *is* the cache; the write-gate *is* the check-resolution. A
    probe measured the cached-reuse-**skippable** population (nodes v2 re-runs whose
    direct upstreams' outputs are all unchanged) at **0** in every scenario
    (reload-no-change demand-all, deep clean chain, sign-preserving input bump,
    diamond). A node only becomes CHECK-skippable when an upstream is demanded
    *without advancing* — which the eager write-gate guarantees never happens — so a
    CHECK color would be **dead state**, and adding it + per-node output versions +
    a transitive `markCheck` (re-introducing the decision-15 O(graph)-on-a-hub
    walk) buys nothing. **Re-entry gate:** revisit only if a probe shows a
    *non-zero* skippable count (e.g. non-`deepEqual`-comparable outputs where the
    write-gate conservatively over-invalidates).

### Open

1. **Lane relaxation beyond per-space.** Per-space is the agreed first step
   when contention warrants lanes at all (a parked cross-space follow-up
   head-blocking the global lane — resolved decision 11 — is the most
   likely concrete trigger). Finer schemes (per-stream,
   handler-closure-overlap) make ordering data-dependent and are deferred
   until real contention data exists. Pairing question when lanes split:
   the consistency gate also becomes per-lane.
2. **Receipt layering (future, CFC alignment).** Receipts are default-on
   everywhere (decision 14); this question holds the later layers: whether
   the CFC spec's exactly-once scope introduces classes with
   weaker/stronger guarantees, retention/GC policy for receipt cells, and
   whether any class should ever opt out (high-frequency programmatic
   event streams being the plausible candidate).
