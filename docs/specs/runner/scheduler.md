# Scheduler (Behavioral Spec)

- Scope: Define reactive execution semantics based on read/write dependencies.
  Implementations may vary internally but must preserve dependency tracking,
  invalidation, ordering, and error/console behavior described here.

Key Concepts

- Actions are synchronous or async functions executed with a fresh transaction;
  reads/writes performed within populate a journal from which dependencies are
  inferred. A reactivity log consists of read and write addresses (space, id,
  type, and value paths).

Lifecycle

- Schedule: When an action is scheduled with a known dependency log, mark the
  corresponding entities dirty and add the action to the pending set.
- Run: Execute an action with a fresh transaction. On completion, commit and
  derive the reactivity log from the journal. Register subscriptions based on
  reads observed.
- Subscribe: Group read addresses by entity and compact paths. Store as triggers
  per entity. When storage changes overlap any stored paths, queue the action.
- Execute: Drain an event queue first (if present). Determine relevant pending
  actions from the dirty set, cancel prior subscriptions for those actions, and
  run them in dependency order. If queues are empty after execution, resolve
  idle waiters; otherwise, schedule another execute pass.

Dependency Tracking

- The system must derive read and write addresses from the transaction journal
  and compact them. Reads marked with `ignoreReadForScheduling` metadata must
  not be considered dependencies.

Invalidation

- Storage must provide notifications describing which addresses changed. The
  scheduler computes overlapping subscriptions and marks those entities dirty;
  relevant actions are queued.

Ordering

- Determine relevant actions as those with no dependencies or with reads
  intersecting the dirty set. Build a graph where edges point from a writer to
  actions that read overlapping paths. Order actions using a topological
  strategy (e.g., Kahn’s algorithm). If cycles exist, break ties by selecting a
  node with the lowest in-degree to proceed. Include downstream actions that
  depend on writes of relevant actions even if they didn’t directly intersect
  the dirty set.
- Implement a loop guard to prevent unbounded reruns within a single execution
  wave; exceeding the limit constitutes an error.

Console/Error Handling

- Intercept console events originating from within actions and pass them through
  an optional console handler that can augment with metadata before forwarding.
  Wrap errors thrown by actions or event handlers with contextual metadata
  (e.g., charmId, spellId, recipeId, space) and pass to registered error
  handlers. If none are registered, log to console.

Author Guidance

- Write actions so that they synchronously read the cells they depend on; using
  the run pathway will set up subscriptions automatically from those reads. Use
  “ignore read” metadata for non-semantic reads that should not participate in
  scheduling.
