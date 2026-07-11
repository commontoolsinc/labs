# Pull-Based Scheduler

> **Status**: Implemented and enabled by default
> **Location**: `packages/runner/src/scheduler.ts` plus helper modules under
> `packages/runner/src/scheduler/`

This document describes the scheduler behavior in the Common Fabric runtime.
Push mode has been removed; this document describes the remaining (pull)
behavior. The forward-looking design is `docs/specs/scheduler-v2/`.

## Background: Why Pull-Based?

The original scheduler was **push-based**: when data changed, all dependent actions ran immediately. This was wasteful because:

1. **Greedy execution**: All actions that *could* be affected ran, regardless of whether their outputs were observed
2. **No lazy evaluation**: Intermediate computations ran even if final consumers didn't need them
3. **Wasted work**: In sparse graphs with many computations but few observers, most work was unnecessary

The **pull-based** approach inverts this:
- When data changes, computations are marked *dirty* but don't run
- Demand roots such as *effects* (side-effectful actions like `sink()`), event
  preflight, and explicit `cell.pull()` calls pull dependencies on demand
- Computations only run if one of those demand roots actually needs them

## Core Concepts

### Actions

An **action** is a function `(tx: Transaction) => any` that the scheduler manages. Actions are created by the runtime when patterns use reactive primitives:

| Pattern Primitive | Creates Action Type | Description |
|-------------------|---------------------|-------------|
| `sink(cell, callback)` | Effect | Runs callback when cell changes |
| `lift(fn, ...inputs)` | Computation | Transforms inputs, writes to output cell |
| `computed(() => ...)` | Computation | Derives a new reactive value |
| Event handlers | Queued event action | Responds to user events |

The scheduler doesn't know about patterns - it only sees actions with read/write dependencies.

### Effects vs Computations

| Type | Description | Behavior |
|------|-------------|----------|
| **Effect** | Side-effectful action | Eligible to run when scheduled. These are "roots of demand" |
| **Computation** | Pure transformation | Only runs when an effect, event preflight, or explicit pull needs its output |

When you call `sink()`, the runtime registers the subscribed action with
`isEffect: true`. Other subscribed reactive actions are computations. Event
handlers are queued separately and run through the event path.

### Dirty vs Pending

- **Pending**: Actions scheduled to run this cycle
- **Dirty**: Actions with direct changed inputs
- **Stale**: Actions that are dirty, or whose upstream computations are dirty

In pull mode, when a cell changes:
- Effects → added to `pending`
- Computations → marked `dirty`/`stale`, and downstream effects are scheduled
  through the ordinary dependency/output graph
- Materializer computations → also queued for idle side-write materialization,
  but their broad write envelopes are not used for downstream fanout

A computation stays dirty until an effect, event preflight, or explicit
`cell.pull()` needs it. If nothing ever observes it, it never runs.
Materializers are the exception: broad or dynamic writable-input computations
are dirty-coalesced and run from the idle pull loop so their actual changed
writes can drive precise downstream propagation.

In push mode, triggered effects and computations are both scheduled in
`pending`.

### Current-Known Writes

Each action tracks its current known write set from the latest run plus
declared writes. This keeps the dependency graph precise while still
handling no-op runs and declared outputs:

```typescript
// Shown inside a pattern body.
// Sometimes writes A, sometimes B
if (condition) cellA.set(x);
else cellB.set(x);
```

By default the scheduler uses the latest known writes rather than cumulative
history, so stale branches can disappear when an action changes what it writes.
The public diagnostic API still uses the older name `getMightWrite()`, but it
returns this active scheduling write set by default. The old cumulative
write-history behavior is retained behind the experimental
`schedulerHistoricalMightWrite` flag.

### Materializer Write Envelopes

Computations that write through writable inputs are not indexed from transaction
`attemptedWrites`. If the write target is statically simple and safely
resolvable, it is represented as a normal declared write. Broad or dynamic
writable-input targets are represented as `materializerWriteEnvelopes`, a
separate pull-mode index.

Materializer membership normally comes from explicit module/action metadata.
For generated `computed()` callbacks, the transformer emits
`materializerWriteInputPaths` only when capability analysis observes actual
writes through captured cell inputs. A Writable input in an output-producing
generated action schema is not enough evidence: pure computations commonly
accept Writable cells so they can read their current values. When an
output-producing action also has materializer metadata, materializer membership
is treated as an additional side-write facet and must not suppress normal dirty
fanout for its declared or current-known outputs. The current runtime fallback
is limited to opaque-result generated computations that do not carry write-path
metadata, where the computation has no normal output surface and its observable
work is side-writing through captured Writable inputs.

The materializer index is owned by `SchedulerMaterializers` and exposed to
scheduler helper modules through the `MaterializerIndexState` interface. That
index owns both membership checks and write-envelope lookup; consumers do not
thread separate `isMaterializer` callbacks through scheduler state.

When a materializer's inputs change, broad dirtying through the materializer
envelope stops at the materializer. It is queued for the idle pull loop,
coalescing repeated source changes and honoring manual debounce/throttle
settings. If the same action also has normal declared or current-known outputs,
those outputs still participate in the ordinary dependency graph, so demand for
them can pull the action before idle. That run satisfies the coalesced
materializer work rather than causing a duplicate idle run. If an effect, event
preflight, or explicit demand reads a path overlapping a dirty materializer
envelope before idle runs, that materializer is promoted into the same settle
pass and ordered before the reader. After it runs, only actual changed writes
are propagated to downstream readers.

## Execution Flow

### 1. Storage Change Notification

```
Cell X changes (value: before → after)
    ↓
Storage manager notifies scheduler
    ↓
Find actions that read X (via trigger index)
    ↓
For each triggered action:
    Effect → add to pending, queue execution
    Computation → mark dirty, propagate to dependents, schedule affected effects
    Materializer computation → mark dirty, keep ordinary dependent propagation,
        and queue idle pull work for broad side-write materialization
```

The trigger index groups actions by the cells they read, so finding affected
actions is O(1) per changed cell before path-overlap filtering.

### 2. Dependency Collection

Before an action runs for the first time, the scheduler discovers its dependencies:

```typescript
// Shown inside a pattern body.
// Scheduler calls the action's populateDependencies callback
const tx = runtime.edit();
populateDependencies(tx);  // Action reads cells it will access
const deps = txToReactivityLog(tx);  // Extract reads from transaction
tx.abort();  // Don't commit - we only wanted to capture reads
```

This happens in `execute()` before building the work set.

### 3. Building the Work Set

In pull mode, the work set starts from runnable demand roots and pulls their
dirty or stale dependencies:

```typescript
// Shown for illustration only.
workSet = new Set<Action>();

// Start with pending effects, event-blocking dependencies, and other
// special pull seeds such as first-run demand roots.
for (const effect of pending) {
  if (isEffect(effect)) workSet.add(effect);
}

// Recursively collect dirty/stale computations each seed depends on.
for (const effect of workSet) {
  collectDirtyDependencies(effect, workSet);
}
```

The `collectDirtyDependencies` function finds dirty computations that write to
cells the action reads. It also consults the materializer envelope index even
when the demand root is merely pending rather than stale, because a pending
effect or event can read a materialized target before normal stale propagation
has an exact edge.

Initial demand roots are runnable only on the first settle iteration. On later
iterations they remain traversal seeds so newly created or newly dirtied
dependencies can be pulled through the same demand path before `pull()` returns,
without rerunning the demand root unless normal scheduling also marks it
pending.

### 4. Topological Sort

Actions are sorted so dependencies run before dependents:

```typescript
// Shown for illustration only.
function topologicalSort(
  actions,
  dependencies,
  schedulingWrites,
  actionParent,
  dependents,
  getAdditionalWrites, // materializer-index envelopes in pull mode
) {
  // Build graph: action A → action B if A writes something B reads
  // In pull mode, prefer the incrementally maintained dependents graph.
  // Add materializer-envelope edges for this work set without mutating the
  // normal writer/dependent indexes.
  // Add parent → child edges only when they do not oppose data dependencies.
  // Kahn's algorithm with cycle handling
}
```

When cycles exist, the sort prefers:
1. Nodes whose parents are already visited
2. Nodes with lowest in-degree

This makes parents run before children in nested patterns when no opposing data
dependency requires the child first.

### 5. Run Actions

```typescript
// Shown for illustration only.
for (const action of sortedOrder) {
  // Skip if unsubscribed during this tick
  if (!isStillScheduled(action)) continue;

  // Skip if delayed, not demanded, or conditionally scheduled without
  // changed inputs.
  if (!isRunnable(action)) continue;

  // Clear scheduling state appropriate to the mode before running.
  clearScheduledState(action);

  // Run in the runtime harness, commit the transaction, resubscribe from the
  // resulting reactivity log, and update timing/diagnostics.
  await runSchedulerAction(action);
}
```

### 6. Settle Loop

Dependencies can change at runtime. The classic example is `ifElse`:

```typescript
// Shown inside a pattern body.
const result = ifElse(condition, branchA, branchB);
```

When `condition` changes from `true` to `false`:
1. Initial collect finds: `ifElse` depends on `branchA`
2. After `ifElse` runs, it now depends on `branchB`
3. If `branchB` is dirty, we need to run it and re-run `ifElse`

The settle loop handles this:

```typescript
// Shown inside a pattern body.
for (let iter = 0; iter < 10; iter++) {
  collectNewSubscriptionDependencies();
  const workSet = buildCurrentWorkSet();
  if (workSet.size === 0) break;  // Settled

  const order = topologicalSort(workSet);
  for (const action of order) {
    await maybeRunScheduledAction(action);
  }
}
```

Max 10 iterations prevents infinite loops from non-converging cycles.

## Cycle Handling

### Why Not Explicit Cycle Detection?

The original plan included Tarjan's algorithm to find strongly connected components (cycles) and handle them specially. This was abandoned because:

1. **Dynamic dependencies**: The dependency graph changes at runtime. Static cycle detection would miss cycles that appear only under certain conditions.

2. **Complexity**: Separate fast/slow cycle paths, convergence tracking, and cycle state management added ~200 lines of complex code.

3. **The real problem is simpler**: Most cycles are nested patterns (parent creates child, both read/write shared state). Parent-child ordering handles these naturally.

### What We Do Instead

1. **Parent-child ordering in topological sort**: When breaking ties in cycles,
   prefer nodes without unvisited parents, while still letting semantic
   read/write dependencies win over structural creation order.

2. **Settle loop**: Re-collect dependencies after running. Handles conditional patterns (ifElse) correctly.

3. **Iteration limits**: Max 10 settle iterations, max 100 runs per action. Prevents infinite loops.

4. **Cycle-aware debounce**: Eligible effects running 3+ times in pull execute
   cycles taking >100ms get adaptive debounce (2× cycle time).

### Example: Nested Lift Pattern

```
multiplyGenerator (parent)
    ↓ creates
multiply (child)
    ↓ writes result
    ↓ parent reads result
    ←←←←←←←←←←←←←←←
```

Both are triggered when input changes. Topological sort sees a cycle. By preferring the parent:
1. `multiplyGenerator` runs first
2. It may unsubscribe old child and create new one
3. Only the appropriate child runs

## Event Handlers

Event handlers (button clicks, form submissions) may depend on computed values.
In pull mode, the scheduler preflights those dependencies and the readiness of
captured inputs before dispatching the queued handler action. In push mode, the
handler dispatch path is direct.

### The traverseCells Flag

When registering a handler, the runtime provides a `populateDependencies` callback:

```typescript
// Shown for illustration only.
handler.populateDependencies = (tx, event) => {
  // Read with traverseCells to capture nested Cell dependencies
  inputsCell.asSchema(schema).get({ traverseCells: true });
};
```

The `traverseCells: true` flag tells `validateAndTransform` to recursively read into nested `Cell` objects (from `asCell: ["cell"]` in schemas), capturing all dependencies.

### Handler Execution Flow

```
Event arrives
    ↓
Scheduler calls populateDependencies(tx, event)
    ↓
Extract reads from transaction
    ↓
Check if any dependencies are dirty
    ↓
If dirty:
    Schedule dirty computations
    Keep event at queue head (will run after deps compute)
Else:
    Check captured-input readiness
        ↓
    If unavailable:
        Park event at queue head until an input read changes
    Else:
        Run handler action and commit its transaction
```

### Global FIFO Ordering

Events run in global arrival order. If event A arrives before event B, A runs first regardless of which component they target. This preserves causality from the user's perspective.

Events are serialized globally. If the head event is blocked by dirty
dependencies, those dependencies are scheduled first and the same head event is
retried after the scheduler settles enough for the handler to run.

## Current Behavior Reference

This section is the normative behavior reference for the current implementation.
It covers both pull mode and the remaining push-mode compatibility path.

### Subscription Lifecycle

`subscribe(action, populateDependencies, options)` accepts either a dependency
population callback or an already-built `ReactivityLog`. A direct log is a
backwards-compatible path that installs dependencies immediately.

Subscription always:

- Applies optional `changeGroup`, `debounce`, `noDebounce`, and `throttle`
  settings.
- Classifies the action as an effect when `options.isEffect` is true; once an
  action has been classified as an effect, `isEffectAction` preserves that
  identity for later resubscriptions and diagnostics.
- Registers a parent-child relationship when the action is created while another
  action is executing.
- Stores dependency population state or installs the immediate log.
- Marks the action directly dirty, adds it to `pending`, records it in
  `scheduledFirstTime`, emits `scheduler.subscribe`, and returns an unsubscribe
  cancel function.

Pull-mode subscription additionally:

- Seeds declared writes for newly subscribed computations before the first run
  when declared writes are available, so existing effects can discover the new
  writer.
- If a computation is created inside an active pull-demand context, records it
  in `pullDemandedFirstRunComputations` and queues execution so it can run once
  to materialize the demanded value.
- If a computation already has a scheduling write set, schedules affected
  downstream effects.

Push-mode subscription keeps the older eager behavior: new computations and
effects are both queued through `pending` and run by the push settle loop.

`resubscribe(action, log, options)` is called after an action runs. It updates
the dependency log, trigger index, writer index, change group, and parent-child
metadata from the completed run. Pull-mode resubscribe also updates the
dependents graph and marks an effect dirty if its new reads overlap an already
stale non-throttled computation.

`unsubscribe(action)` cancels storage triggers, removes dependencies, clears
change-group mappings unless `preserveChangeGroup` is set, clears pending and
dirty/stale state, removes reverse dependency edges, removes effect/computation
membership, clears write-index entries, cancels debounce state, and removes
pending dependency collection callbacks. Parent-child WeakMap edges are left in
place intentionally; they are used for cycle diagnostics and disappear with the
actions.

### Dependency and Write Tracking

Dependency collection runs `populateDependencies` in a scheduler-owned
transaction, converts the transaction to a `ReactivityLog`, aborts the
dependency transaction for reactive actions, and installs:

- Recursive reads.
- Shallow reads, which only invalidate on same-path, ancestor-path, or direct
  child writes.
- Actual writes from the transaction.
- Declared writes from action telemetry annotations.
- Materializer write envelopes from action telemetry annotations.
- Ignored scheduling writes from telemetry annotations.

Transaction `attemptedWrites` remain a storage/CFC concept for APIs that read a
path while deciding whether to write it. They are included in CFC target-side
prepare/digest inputs, but are explicitly not scheduler dependency evidence.

`setSchedulerDependencies()` sorts and compacts reads and writes, filters
ignored scheduling writes, and prunes structural ancestor writes so unrelated
shallow readers do not become dependents of overly broad ancestors.

The active scheduling write set is current-known by default:

- Use actual writes from the latest run when they exist.
- Otherwise keep the existing current-known writes if present.
- Otherwise seed from declared writes.
- Add parent writes for dynamic collection items when an actual child write
  falls under a declared collection write.

The legacy cumulative write-history behavior is still kept in
`historicalMightWrite` and selected only when the
`schedulerHistoricalMightWrite` experimental option is enabled.

The writer index maintains:

- `writersByEntity`: entity -> actions that may write it.
- `actionWriteEntities`: action -> entities it may write.
- Current and historical write maps for scheduling and diagnostics.

When an action gains writes, existing readers are backfilled into the dependents
graph. When it loses writes, stale dependents edges are pruned.

The materializer index is separate from the writer index. It maintains:

- `materializersByEntity`: entity -> materializer computations whose envelopes
  may write it.
- Action-local compacted materializer write envelopes.

Materializer envelopes are used for pull-mode dirty dependency discovery and
work-set ordering. They are not inserted into the normal writer index and do
not create broad dependents edges by themselves.

### Trigger Index and Storage Notifications

The scheduler subscribes to the storage manager during construction. On storage
notifications with `changes`, each change is recorded as a cell update for
write-propagation history and diagnostics, then matched through
`SchedulerTriggerIndex`.

The trigger index stores recursive and non-recursive read paths separately by
entity. It uses path/value overlap filtering to return only actions whose
registered read paths are affected by the concrete storage change.

Both modes skip a triggered action when:

- The change came from one of the action's own in-flight transactions.
- The commit source change group matches the action's current change group.

Push mode schedules every remaining triggered action with debounce. Pull mode:

- Schedules triggered effects with debounce.
- Marks triggered computations dirty/stale.
- Schedules downstream effects that transitively depend on the dirty
  computation.
- For materializer computations, also queues idle execution, but only the
  ordinary dependency graph is used for downstream scheduling; broad
  materializer envelopes are not used as fanout evidence.

When trigger tracing is enabled, each matched change records a bounded
`TriggerTraceEntry` with the notification type, change index, before/after value
summary, scheduler mode, optional writer action ID, and one decision record per
triggered action. Decisions include `schedule-push`, `schedule-effect`,
`mark-dirty`, `already-dirty`, `skip-own-commit-source`, and
`skip-same-change-group`.

### Pull Demand

Pull mode distinguishes direct dirty and stale:

- Direct dirty means the action itself was invalidated by a storage change or
  explicit scheduling.
- Stale means the action is direct dirty or has an upstream stale writer.

`SchedulerStaleness` propagates stale transitions through the dependents graph.
Clearing direct dirty recomputes whether the action is still stale because of
upstream writers.

Runnable pull seeds include:

- Pending effects.
- Dirty effects skipped by throttling or cycle handling.
- Newly subscribed non-effect actions with no known writes.
- Dirty dependencies that block the head event.
- Computations whose debounce trailing flush has become ready.
- Computations demanded through a live effect, a demanded parent context, or
  `pullDemandedFirstRunComputations`.
- Computations marked as pull-demand continuations after a child computation
  writes data that a scheduler-parent ancestor read earlier in the same pull.
  This is deliberately based on `actionParent`, not arbitrary dependency edges:
  normal reader/writer edges already schedule downstream readers, while
  continuations let an already-run parent converge when its dynamically created
  child produces data the parent sampled.

A computation is demanded when it has a transitive live-effect dependent or is
inside a demanded parent context. An effect with no scheduling writes is a pull
demand root while it runs; computations run under active pull demand are also
temporarily treated as demand contexts.

Dirty dependency collection first uses the maintained reverse dependency graph.
If an action has no reverse-dependency entry, it falls back to writer-index
lookup over the action's current read log. The collector memoizes traversal,
guards recursive cycles with `collectStack`, and can collect detailed event
preflight stats when tracing is active.

### Settle Loops

Both modes use up to 10 settle iterations per execute cycle.

Pull mode:

- Collects dependency logs for newly subscribed actions before each iteration.
- Builds an iteration seed set, then recursively pulls dirty computations needed
  by those seeds.
- Keeps initial demand roots as traversal-only seeds after the first iteration
  so dynamic child computations can trigger ancestor continuations before the
  original pull resolves.
- Topologically sorts the work set using dependencies, current scheduling
  writes, parent-child edges, the dependents graph, and pull-only materializer
  envelope edges for the current work set.
- Clears dirty flags for effects up front; if an effect is re-dirtied before it
  runs, it is treated as part of a cycle and skipped until a future tick.
- Before an effect runs, rechecks for dirty materializer dependencies that may
  have appeared after the work set was built. If any overlap the effect reads,
  the effect remains pending and the materializer is run first.
- Skips unsubscribed actions, non-runnable pull actions, debounced computations,
  throttled actions, and conditionally scheduled effects whose inputs did not
  actually change.
- Clears pending/dirty state before running, records filter stats, records loop
  counts, and runs the action in an active pull-demand context when appropriate.

Push mode:

- Uses the mutable `pending` set as the work set.
- Topologically sorts using dependencies, scheduling writes, and parent-child
  edges, without the pull dependents graph.
- Skips actions that are no longer pending, debounced computations, and
  throttled actions.
- Removes skipped delayed actions from `pending`, preserving the older eager
  behavior.

Every attempted settle action increments the per-execute loop counter. If an
action is selected more than `MAX_ITERATIONS_PER_RUN` times in one execute
cycle, the scheduler reports an error and stops running that action for the
cycle.

### Pull Cycle Break

If pull mode reaches the 10-iteration settle limit with remaining work, the
cycle breaker:

1. Clears non-throttled computations that appeared in early iterations, remain
   in the last work set, are still dirty, and ran more than once in the current
   execute cycle.
2. Runs remaining non-throttled dirty effects so they are not lost.

Throttled computations and effects remain dirty so they can run later when
eligible.

### Action Run and Commit

`run(action)` and settle-loop execution both call `runSchedulerAction()`.

An action run:

- Emits `scheduler.run` with the action ID and optional telemetry metadata.
- Waits for any already-running action promise.
- Creates a runtime edit transaction using the action change group, if present.
- Marks the transaction with `debugActionId`.
- Records the transaction as an in-flight source so the scheduler can ignore the
  action's own commit notification.
- Invokes the action inside the runtime harness while tracking
  `executingAction` for parent-child registration.
- Records elapsed time, action timing stats, auto-debounce eligibility, and
  action-has-run state.
- Starts commit immediately after the action returns.
- Converts the transaction to a reactivity log, resubscribes the action from
  that log, records changed computation writes, and marks readers dirty for
  changed computation outputs.
- Optionally appends action-run trace and diagnosis records.
- Optionally performs an inline idempotency re-run for computations.

Reactive action commits are optimistic. The scheduler continues after starting
the commit, assuming success. If the commit resolves with an error, the action
is always resubscribed from the captured log so later input changes re-trigger
it. A **conflict** (`ConflictError`, a stale read) means the authoritative
version is ahead of this replica: the action re-arms its subscription, waits for
the conflict's `readyToRetry` catch-up, then re-queues itself (mark dirty, add to
`pending`, queue execution) so it re-runs against the fresh state. A conflict is
a wait-for-catch-up, not a failure, so it does **not** consume the retry budget —
the budget cannot be exhausted by a contended compute and strand it as a zombie
against rolled-back data. Reader-dirty propagation may also re-trigger the action
when the catch-up write lands as a fresh notification, but that is a redundant
fast path, not the recovery mechanism: it does not cover a conflict whose
triggering write has already been delivered (no further dirty arrives), so the
re-queue is what guarantees re-evaluation. Other non-permanent errors are not
recovered that way, so they are retried up to `MAX_RETRIES_FOR_REACTIVE` times by
marking the action dirty, adding it to `pending`, and queuing execution;
permanent (precondition) rejections are not retried. Retry state is cleared after
a successful commit. The in-flight source record is removed after the commit
promise settles.

If an action throws, the scheduler reports it through registered error handlers,
still finalizes commit/resubscription state for the transaction, and resolves
the running promise.

### Changed Writes and Conditional Effects

When computations write changed data, the scheduler records the changed write
addresses in `changedWritesHistory`. After the run, the scheduler finds readers
of those changed writes through the trigger index. Reader effects are scheduled
directly. Reader computations are marked dirty and their affected downstream
effects are scheduled. If a reader computation is itself a materializer, it is
also queued/coalesced for idle materialization, but downstream effects that
depend on its ordinary outputs are still scheduled. The materializer envelope
itself is not used as downstream fanout evidence.

Pull-mode storage notification handling can also conditionally schedule
downstream effects and remember the history index at which the effect was
scheduled.

Before a conditionally scheduled effect runs, the scheduler compares only the
changed writes that happened after the effect was scheduled against the effect's
current recursive and shallow reads. If none overlap, the effect is filtered out
and the filter stat is incremented. This prevents downstream effects from
running only because a computation somewhere in the transitive graph was marked
dirty, when the effect's actual inputs did not change.

`changedWritesHistory` is cleared when the scheduler reaches quiescence and no
effects remain conditionally scheduled.

### Event Queue and Handler Dispatch

`queueEvent()` matches the event link against registered handlers. For every
matching handler it pushes a `QueuedEvent`, queues execution, and preserves
global FIFO ordering. If no handler is registered and
`doNotLoadPieceIfNotRunning` is false, the scheduler starts a background
`ensurePieceRunning()` task and requeues the event once if the piece starts.
`idle()` waits for those background tasks before resolving.

`addEventHandler()` registers a handler for a link and optionally attaches a
`populateDependencies(tx, event)` callback. A handler may also carry an
`inputReadiness(tx, event)` check for unaccepted unavailable captured inputs
which can become usable later. The cancel function removes the exact
handler/ref pair.

Pull mode preflights the head event before dispatch when the handler has a
`populateDependencies` callback or an `inputReadiness` check:

- Runs `handler.populateDependencies` in a read-only runtime transaction.
- Runs `handler.inputReadiness` in that same transaction so its reads become
  wake dependencies.
- Converts that transaction to a reactivity log.
- Commits the read-only inspection transaction as a no-op so dependency
  discovery does not participate in CFC prepare/commit gating.
- Collects dirty computations needed by the handler's reads.
- If runnable dirty dependencies exist, adds them to `pending` and
  `eventBlockingDeps`, skips dispatch, and preserves the head event.
- If dependencies are dirty but delayed by debounce/throttle, parks the head
  event with `notBefore`, schedules the event wake timer, and preserves FIFO
  ordering.
- If dependencies are settled but `inputReadiness` returns false, subscribes a
  one-shot wake action to the preflight reads and parks the original event at
  the FIFO head. No handler transaction, receipt, or `onCommit` callback is
  produced until a later input change makes the check pass.
- Optionally emits `scheduler.event.preflight` with timing and dirty-dependency
  stats.

Readiness checks exclude the immutable event payload. A malformed `$event`
cannot improve while queued, so dispatch treats its schema failure as a final
no-op outcome, settles the event, and continues to the next queue entry.

Push mode dispatches the head event directly.

Dispatching a queued event:

- Emits `scheduler.invocation` for the handler.
- Removes the head event from the queue.
- Runs the handler in an immediate runtime transaction.
- Records trusted event policy inputs from annotated writes and from actual
  transaction write candidates.
- Calls `runtime.prepareTxForCommit(tx)` and starts the commit without awaiting
  server confirmation. The transaction is applied locally before the commit
  promise resolves, so the scheduler can continue against speculative local
  state; if the server rejects the commit, dependent speculative transactions are
  rejected and the normal retry path reruns the event.
- On commit error, retries by unshifting the event back to the head of the queue
  while retries remain.
- Runs the internal `onCommit` callback after the final commit result, including
  exhausted failure. This callback must not perform external side effects.

### Debounce, Throttle, and Timers

Manual debounce is stored per action. Scheduling an action with debounce cancels
any existing debounce timer and schedules a new one that adds the action to
`pending` and queues execution.

Pull computations are debounced differently after they have run at least once.
When a dirty computation with manual debounce is demanded, the scheduler records
its next ready time and schedules a trailing flush. When the timer fires, the
computation is marked ready, added to `computationDebounceFlushSeeds`, added to
`pending`, and execution is queued.

Throttle uses action timing stats. An action is throttled while
`lastRunTimestamp + throttleMs` is in the future. Pull-mode throttled actions
stay dirty so they can be pulled later. Push-mode throttled actions are removed
from `pending` in the compatibility path.

Auto-debounce applies only to effects that are not pull demand roots and have
not opted out with `noDebounce`. Once such an effect has at least
`AUTO_DEBOUNCE_MIN_RUNS` timing samples and an average runtime at or above
`AUTO_DEBOUNCE_THRESHOLD_MS`, the scheduler assigns
`AUTO_DEBOUNCE_DELAY_MS` unless a manual debounce already exists. Computations
are not auto-debounced.

Cycle-aware debounce runs after pull settle. If an effect ran at least
`CYCLE_DEBOUNCE_MIN_RUNS` times in an execute cycle that took at least
`CYCLE_DEBOUNCE_THRESHOLD_MS`, the scheduler raises its debounce to
`CYCLE_DEBOUNCE_MULTIPLIER * elapsedMs` when that is higher than its current
debounce and the action is eligible for auto-debounce.

`dispose()` cancels active debounce timers, the queued execute timer, the event
wake timer, and diagnosis timeout state.

### Execution Continuation and Idle

`queueExecution()` coalesces work into a queued task. If an execute cycle is
already scheduled and no queue task timer is pending, it sets
`rerunAfterCurrentExecute` so continuation can schedule a follow-up tick.

After each execute cycle, pull-mode continuation queues another tick when:

- A rerun was requested during the cycle and no future dirty-work wake is known.
- Runnable pending pull work exists.
- Runnable dirty pull work exists.
- The event queue has a head event ready now.

If dirty pull work is only waiting for a future debounce/throttle time,
continuation schedules the event wake timer for that time and marks the
scheduler not scheduled. If the future wake is only for non-effect dirty
computation work and no parked event is present, idle promises may resolve
because no live demand root is waiting.

Push-mode continuation queues another tick when `pending` is non-empty, a rerun
was requested, or a head event is ready now.

At quiescence, continuation resolves idle promises, marks the scheduler not
scheduled, resets the non-settling tracker, clears `scheduledFirstTime`, and
clears changed-write history when no conditional effects remain.

`idle()` resolves only when:

- No action is currently running.
- No background event-start task is pending.
- No scheduled execute cycle is pending.
- No parked head event or deferred dirty effect is waiting on an event wake
  timer.
- In pull mode, no runnable pull work exists.

Pending computations alone do not keep `idle()` open in pull mode unless they
are demanded by an effect, event preflight, explicit first-run demand, or a
trailing debounce flush.

### Diagnostics, Telemetry, and Debugger State

Action IDs are derived from scheduler telemetry annotations or generated
anonymous IDs. They are used for logging, breakpoints, action stats, settle
stats, trigger traces, graph snapshots, and diagnosis.

The scheduler emits these telemetry markers directly:

- `scheduler.mode.change`
- `scheduler.subscribe`
- `scheduler.dependencies.update`
- `scheduler.run`
- `scheduler.invocation`
- `scheduler.event.commit`, with counts and a capped sample of written paths
- `scheduler.event.preflight` when event preflight telemetry is enabled
- `scheduler.non-settling`

`scheduler.graph.snapshot` exists as a telemetry marker type for consumers, but
the scheduler's own graph data is normally retrieved through
`getGraphSnapshot()` / `RuntimeClient.getGraphSnapshot()`.

`getGraphSnapshot()` returns:

- Effect, computation, input, and inactive nodes.
- Dirty, pending, demanded, live-effect, pull-demand-root, conditional schedule,
  debounce, and throttle status.
- Reads, shallow reads, scheduling writes, timing stats, debounce/throttle
  values, parent IDs, child counts, previews, and pattern IDs.
- Dependency edges, input edges, and parent-child edges.
- Current `pullMode` and timestamp.

Settle stats are opt-in. When enabled, each execute records per-iteration work
set size, ordered action count, action run count, action IDs/types, duration,
total settle duration, whether it settled early, and initial seed count.
History is bounded by `MAX_SETTLE_STATS_HISTORY`.

Action-run trace is opt-in and bounded by `MAX_ACTION_RUN_TRACE_HISTORY`.
Entries include action ID, action type, parent action ID, duration, declared
writes, and actual writes.

Trigger trace is opt-in and bounded by `MAX_TRIGGER_TRACE_HISTORY`.

Non-settling detection tracks scheduler busy time over a rolling window. When
the window is longer than 5 seconds, busy ratio is above 0.3, and total busy
time is above 1 second, the scheduler emits `scheduler.non-settling` once and
can start diagnosis automatically when `setAutoTriggerDiagnosis(true)` is set.
The window is rolled after 10 seconds without quiescence and reset on idle.

Diagnosis can collect read/write records for non-idempotency, causal edges from
writer change groups to triggered actions, and cycle reports. Inline
idempotency check mode re-runs computations after normal execution and stores
violations.

## Debounce and Throttle

### Debounce: "Wait then run"

Delays execution until triggers stop arriving:

```typescript
// Shown for illustration only.
scheduler.setDebounce(action, 100);  // Wait 100ms after last trigger
```

Each trigger resets the timer. Good for search-as-you-type.

### Auto-Debounce

Eligible effects averaging >50ms (after 3 runs) automatically get 100ms
debounce. Pull demand-root effects and computations are not auto-debounced. Opt
out with `{ noDebounce: true }` in subscription options.

### Throttle: "Stale by T ms"

Limits execution frequency:

```typescript
// Shown for illustration only.
scheduler.setThrottle(action, 1000);  // Max once per second
```

Unlike debounce, throttled actions stay dirty and will run when:
1. The throttle period expires, AND
2. An effect pulls them

Queued events whose head dependency is throttled are parked until the earliest
eligible wake time instead of being polled in a tight loop. FIFO ordering is
preserved while the head event is parked.

### Cycle-Aware Debounce

Eligible effects running 3+ times in pull execute cycles taking >100ms get
adaptive debounce:

```
debounce = 2 × cycle_time
```

This slows down problematic effect cycles without manually assigning a debounce.

## Key Data Structures

```typescript
// Shown for illustration only.
class Scheduler {
  // Action classification and scheduling state
  private effects = new Set<Action>();
  private computations = new Set<Action>();
  private pending = new Set<Action>();
  private staleness = new SchedulerStaleness(...);

  // Dependency tracking
  private dependencies = new WeakMap<Action, ReactivityLog>();
  private dependents = new WeakMap<Action, Set<Action>>();
  private reverseDependencies = new WeakMap<Action, Set<Action>>();
  private triggerIndex = new SchedulerTriggerIndex();
  private writeIndex = new SchedulerWriteIndex(...);
  private materializers = new SchedulerMaterializers(...);

  // Parent-child relationships for nested patterns
  private actionParent = new WeakMap<Action, Action>();
  private actionChildren = new WeakMap<Action, Set<Action>>();

  // Timing, debounce, throttle, and diagnostics
  private delays = new SchedulerDelays(...);
  private actionStats = new Map<string, ActionStats>();
  private filterStats = { filtered: 0, executed: 0 };
}

interface ReactivityLog {
  reads: Address[];
  shallowReads: Address[];
  writes: Address[];
}

interface TransactionReactivityLog extends ReactivityLog {
  attemptedWrites?: Address[];  // CFC/security target evidence, not scheduling evidence
}

interface ActionStats {
  runCount: number;
  totalTime: number;
  averageTime: number;
  lastRunTime: number;
  lastRunTimestamp: number;
}
```

The scheduler class owns the long-lived state. Most work is factored into
modules under `packages/runner/src/scheduler/`, including:

- `pull-execution.ts` and `push-execution.ts` for mode-specific settle loops
- `pull-scheduling.ts` for demand-root and affected-effect scheduling
- `events.ts`, `pull-events.ts`, and `push-events.ts` for queued handlers
- `materializers.ts` for the pull-mode materializer index and write-envelope
  lookup
- `scheduling-writes.ts`, `trigger-index.ts`, and `dependency-graph.ts` for
  dependency indexes
- `delays.ts` and `delay-control.ts` for debounce/throttle state

## Constants

```typescript
// Shown as interface or class members.
MAX_ITERATIONS_PER_RUN = 100       // Max runs per action per execute cycle
MAX_SETTLE_STATS_HISTORY = 20      // Max settle stats entries retained
MAX_TRIGGER_TRACE_HISTORY = 400    // Max trigger trace entries retained
MAX_ACTION_RUN_TRACE_HISTORY = 2000 // Max action-run trace entries retained
AUTO_DEBOUNCE_THRESHOLD_MS = 50    // Avg time to trigger auto-debounce
AUTO_DEBOUNCE_MIN_RUNS = 3         // Runs before auto-debounce kicks in
AUTO_DEBOUNCE_DELAY_MS = 100       // Debounce delay for slow actions
CYCLE_DEBOUNCE_THRESHOLD_MS = 100  // Cycle time to trigger adaptive debounce
CYCLE_DEBOUNCE_MIN_RUNS = 3        // Runs in cycle to be considered cycling
CYCLE_DEBOUNCE_MULTIPLIER = 2      // Debounce = multiplier × cycle time
MAX_RETRIES_FOR_REACTIVE = 10      // Retry count for reactive actions
```

## Debugging

### Enable Logging

```typescript
// Shown inside a pattern body.
// packages/runner/src/scheduler.ts and scheduler helper modules
const logger = getLogger("scheduler", {
  enabled: true,
  level: "warn",
});
```

For browser-side debugging, prefer changing the worker logger through
`RuntimeClient` instead of editing code:

```javascript
// Shown inside a pattern body.
await commonfabric.rt.setLoggerEnabled(true, "scheduler")
await commonfabric.rt.setLoggerLevel("debug", "scheduler")
```

Logs show:
- Storage notifications and triggered actions
- Work set construction and topological sort order
- Settle loop iterations
- Cycle detection and debounce decisions

### Diagnostic API

```typescript
// Shown for illustration only.
// Overall state
scheduler.getStats()              // { effects, computations, pending }

// Action queries
scheduler.isEffect(action)
scheduler.isComputation(action)
scheduler.isDirty(action)
scheduler.getDependents(action)
scheduler.getActionStats(action)  // { runCount, avgTime, lastRunTime, ... }

// Debounce/throttle
scheduler.getDebounce(action)
scheduler.getThrottle(action)
scheduler.setDebounce(action, ms)
scheduler.setThrottle(action, ms)

// Filter stats (pull vs push efficiency)
scheduler.getFilterStats()        // { filtered, executed }
```

### Common Issues

**Computation not running:**
- Verify an effect, event handler preflight, or explicit pull depends on it
  (check `getDependents` for the effect case)
- Check if it's dirty: `isDirty(action)`
- If throttled, wait for period to expire

**Action running too many times:**
- Check for commit conflicts causing retries
- Look for rapidly-changing dependencies creating cycles
- Add debounce: `setDebounce(action, 100)`

**Seeing stale values:**
- Check throttle settings
- Ensure the reading action is marked as an effect
- Verify dependencies are correctly declared
- Effects currently run eagerly/speculatively and are assumed to be UI-safe;
  irreversible side effects should not rely on that behavior

**Max iterations hit:**
- Action has self-referential dependency (writes to what it reads)
- Add debounce to slow down the cycle
- Consider restructuring the pattern to break the cycle

## API Reference

### Scheduling

```typescript
// Shown for illustration only.
scheduler.subscribe(
  action: Action,
  populateDependencies: ((tx: Transaction) => void) | ReactivityLog,
  options?: {
    isEffect?: boolean,     // Mark as effect / demand root
    debounce?: number,      // Delay in ms before running
    noDebounce?: boolean,   // Opt out of auto-debounce
    throttle?: number,      // Min ms between runs
    changeGroup?: ChangeGroup,
  }
): Cancel

scheduler.resubscribe(
  action: Action,
  log: ReactivityLog,
  options?: {
    isEffect?: boolean,
    changeGroup?: ChangeGroup,
  }
): void

scheduler.unsubscribe(
  action: Action,
  options?: { preserveChangeGroup?: boolean },
): void

scheduler.run(action: Action): Promise<any>
scheduler.queueExecution(): void
scheduler.idle(): Promise<void>
```

### Events

```typescript
// Shown for illustration only.
scheduler.queueEvent(
  eventLink: NormalizedFullLink,
  event: any,
  retries?: number,
  onCommit?: (tx: IExtendedStorageTransaction) => void,
  doNotLoadPieceIfNotRunning?: boolean,
): void

scheduler.addEventHandler(
  handler: EventHandler,
  ref: NormalizedFullLink,
  populateDependencies?: (
    tx: IExtendedStorageTransaction,
    event: any,
  ) => void,
): Cancel
```

### Console and Error Hooks

```typescript
// Shown for illustration only.
scheduler.onConsole(fn: ConsoleHandler): void
scheduler.onError(fn: ErrorHandler): void
```

### Timing Controls

```typescript
// Shown for illustration only.
scheduler.setDebounce(action, ms)
scheduler.getDebounce(action)
scheduler.clearDebounce(action)
scheduler.setNoDebounce(action, optOut)

scheduler.setThrottle(action, ms)
scheduler.getThrottle(action)
scheduler.clearThrottle(action)
```

### Breakpoints and Basic Queries

```typescript
// Shown for illustration only.
scheduler.setBreakpoints(actionIds)
scheduler.getBreakpoints()
scheduler.hasBreakpoint(actionId)

scheduler.getStats()
scheduler.isEffect(action)
scheduler.isComputation(action)
scheduler.isDirty(action)
scheduler.getDependents(action)
scheduler.getMightWrite(action)    // Active scheduling writes despite legacy name
scheduler.getActionStats(actionOrId)
scheduler.getFilterStats()
scheduler.resetFilterStats()
```

### Graph and Trace Diagnostics

```typescript
// Shown for illustration only.
scheduler.getGraphSnapshot()

scheduler.enableSettleStats()
scheduler.setSettleStatsEnabled(enabled)
scheduler.getSettleStats()
scheduler.getSettleStatsHistory()

scheduler.setActionRunTraceEnabled(enabled)
scheduler.getActionRunTrace()

scheduler.setTriggerTraceEnabled(enabled)
scheduler.getTriggerTrace()

scheduler.setEventPreflightTelemetryEnabled(enabled)
scheduler.isEventPreflightTelemetryEnabled()
```

### Non-Settling and Idempotency Diagnosis

```typescript
// Shown for illustration only.
scheduler.isNonSettling()
scheduler.setAutoTriggerDiagnosis(enabled)
scheduler.runDiagnosis(durationMs)

scheduler.enableIdempotencyCheck()
scheduler.disableIdempotencyCheck()
scheduler.getIdempotencyViolations()
scheduler.runIdempotencyCheck()
```

### Lifecycle

```typescript
// Shown for illustration only.
scheduler.dispose()
```

### Internal Orchestration Hooks

These are public on the class for runtime integration, but are not general
pattern APIs:

```typescript
// Shown for illustration only.
scheduler.runningPromise
scheduler.withExecutingAction(action, fn)
```

### Scheduler Module Re-exports

The scheduler module also re-exports:

```typescript
// Shown inside a pattern body.
txToReactivityLog
allowMutableTransactionRead
ignoreReadForScheduling
markReadAsAttemptedWrite
```

## Tests

The scheduler has focused test coverage in `packages/runner/test/`, especially
`scheduler-core.test.ts`, `scheduler-pull.test.ts`,
`scheduler-pull-array.test.ts`, `scheduler-pull-references.test.ts`,
`scheduler-pull-handlers.test.ts`, `scheduler-pull-idempotency.test.ts`,
`scheduler-events.test.ts`, `scheduler-effects.test.ts`,
`scheduler-ordering.test.ts`, `scheduler-convergence.test.ts`,
`scheduler-retries.test.ts`, `scheduler-throttle.test.ts`, and
`scheduler-timing.test.ts`, covering:
- Effect vs computation classification
- Dirty propagation and pull mechanics
- Topological ordering
- Debounce and throttle behavior
- Cycle handling and iteration limits
- Event handler dependencies
