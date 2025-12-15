# Userland Handler Pull: Ensuring Handler Inputs Are Current

## Problem Statement

Event handlers in CommonTools are **synchronous** - they can't use `await pull()`. But their inputs may be the result of lifted computations that haven't run yet in pull mode. This creates a gap: handlers can see stale data when their computed inputs haven't been pulled.

### Core Issues

1. **Handlers are sync, pull is async**: Userland handlers are written as synchronous functions. They can't call `await cell.pull()`.

2. **Declarative dependencies from schema**: We know what a handler *will* read from its schema, but dependencies can be dynamic (data-dependent).

3. **Nested Cell traversal**: `validateAndTransform` creates `Cell` wrappers for `asCell` fields. A `.get()` on the parent doesn't traverse into these cells to pull their values.

### Example Scenario

```typescript
// Pattern code
const expensiveComputation = derive(input, (data) => { /* CPU intensive */ });

const myHandler = handler(
  { type: "object", properties: { button: { type: "string" } } },
  { type: "object", properties: { computed: { asCell: true } } },
  (event, { computed }) => {
    // In pull mode: `computed` is a Cell, but its upstream `expensiveComputation`
    // may not have run yet!
    const value = computed.get(); // Could be stale!
    doSomethingWith(value);
  }
);
```

When the handler runs:
- The event triggers handler invocation
- `validateAndTransform` creates a Cell for `computed` (due to `asCell: true`)
- But `expensiveComputation` hasn't been pulled yet
- Handler sees stale data

---

## Current Architecture

### Event Handler Flow

```
[User clicks button]
        ↓
scheduler.queueEvent(eventLink, event)
        ↓
eventQueue.push({ action: (tx) => handler(tx, event) })
        ↓
execute() runs events from queue FIRST
        ↓
handler(tx, event) called SYNCHRONOUSLY
        ↓
validateAndTransform() creates input object
        ↓
Handler fn runs with inputs
```

### Where Handler Inputs Are Created

```typescript
// runner.ts:1006-1016
const inputsCell = this.runtime.getImmutableCell(
  processCell.space,
  eventInputs,
  undefined,
  tx,
);

const argument = module.argumentSchema
  ? inputsCell.asSchema(module.argumentSchema).get()  // <-- sync .get()
  : inputsCell.getAsQueryResult([], tx);
const result = fn(argument);  // <-- handler runs
```

### How validateAndTransform Creates Nested Cells

When schema has `asCell: true`:
```typescript
// schema.ts:441-453
return createCell(runtime, link, getTransactionForChildCells(tx));
```

These nested cells are **proxies** to computed values. In pull mode, the underlying computation may be dirty.

---

## Proposed Solution: Handlers as One-Time Actions

Instead of a separate event queue with explicit pull-before-run logic, treat event handlers as **one-time actions** in the regular scheduler loop. This unifies the scheduling model and lets topological sort naturally order handler inputs before handlers.

### Architecture Overview

```
execute() {
  // 1. Promote queued events to one-time actions
  promoteEventsToActions()

  // 2. Single unified loop
  while (pending.size > 0 || hasDirtyActions()) {
    const sorted = topologicalSort() // Handlers included!

    for (action of sorted) {
      if (isOneTimeHandler(action)) {
        // Re-validate: did dependencies change during this cycle?
        if (!shouldRunHandler(action)) {
          continue // Rescheduled with new deps
        }
      }

      run(action)

      if (isOneTimeHandler(action)) {
        onHandlerComplete(action)
      }
    }
  }
}
```

### Key Mechanisms

#### 1. Event Handler Registration with Dependency Callback

When registering an event handler, also register a callback that populates a transaction with the handler's read dependencies. This keeps schema knowledge in the runner, not the scheduler:

```typescript
// In scheduler.ts - schema-agnostic interface
interface EventHandler {
  (tx: IExtendedStorageTransaction, event: any): any;
  // Callback that reads all dependencies into a transaction
  // Scheduler calls this, then extracts reads from tx
  populateDependencies?: (tx: IExtendedStorageTransaction) => void;
}

addEventHandler(
  handler: EventHandler,
  ref: NormalizedFullLink,
  populateDependencies?: (tx: IExtendedStorageTransaction) => void
): Cancel {
  handler.populateDependencies = populateDependencies;
  // ...
}
```

```typescript
// In runner.ts - schema-aware implementation
const populateDependencies = (tx: IExtendedStorageTransaction) => {
  // This reads all the cells the handler will access,
  // populating tx with read dependencies
  const inputsCell = this.runtime.getImmutableCell(
    processCell.space,
    inputs,
    undefined,
    tx,
  );
  // Use traverseCells flag to also read into each Cell that validateAndTransform creates
  inputsCell.asSchema(module.argumentSchema).get({ traverseCells: true });
};

this.runtime.scheduler.addEventHandler(
  wrappedHandler,
  streamLink,
  populateDependencies
);
```

#### Note: validateAndTransform traverseCells Flag

Normal `.get()` returns Cells for `asCell` fields without reading into them. With `traverseCells: true`, `validateAndTransform` also calls `.get()` on each Cell it creates, ensuring the transaction captures all nested reads:

```typescript
// In schema.ts - validateAndTransform modification
function validateAndTransform(
  runtime: Runtime,
  tx: IExtendedStorageTransaction | undefined,
  link: NormalizedFullLink,
  synced: boolean = false,
  seen: Array<[string, any]> = [],
  options?: { traverseCells?: boolean }  // NEW
): any {
  // ... existing code ...

  // When creating a Cell for asCell field:
  if (isObject(schema) && schema.asCell) {
    const cell = createCell(runtime, link, getTransactionForChildCells(tx));

    // NEW: If traverseCells, also read the cell's value to capture dependencies
    if (options?.traverseCells) {
      cell.withTx(tx).get({ traverseCells: true }); // Recursive
    }

    return cell;
  }

  // ... rest of existing code ...
}
```

This ensures the dependency callback captures ALL reads the handler will perform, including nested Cell accesses.

#### 2. Event to Action Conversion

Scheduler creates a one-time action, using the callback to discover dependencies:

```typescript
// In scheduler.ts
function createOneTimeAction(event: QueuedEvent): OneTimeAction {
  const handler = event.handler;

  // Use callback to populate a tx with reads
  const tx = this.runtime.edit();
  if (handler.populateDependencies) {
    handler.populateDependencies(tx);
  }
  const deps = txToReactivityLog(tx).reads;
  tx.rollback();

  const action: OneTimeAction = (tx) => handler(tx, event.data);
  action.isOneTime = true;
  action.declaredDeps = deps;

  return action;
}
```

This separation means:
- **scheduler.ts**: Only knows about addresses, transactions, actions
- **runner.ts**: Knows about schemas, cells, validateAndTransform
- **Callback**: Bridge that lets scheduler discover deps without schema knowledge

#### 3. Global FIFO Event Ordering

Events run in arrival order globally:

```typescript
// Global event queue preserving arrival order
private eventQueue: QueuedEvent[] = [];
private activeHandler: OneTimeAction | null = null;

// Only the FIRST event globally enters the work set
function promoteEventsToActions() {
  if (this.eventQueue.length > 0 && !this.activeHandler) {
    const event = this.eventQueue[0]; // First only
    const action = createOneTimeAction(event);
    pending.add(action);
    setDependencies(action, { reads: action.declaredDeps, writes: [] });
    this.activeHandler = action;
  }
}

// After handler completes, promote next event
function onHandlerComplete(action: OneTimeAction) {
  this.eventQueue.shift(); // Remove completed
  this.activeHandler = null;
  unsubscribe(action); // Don't re-run on input changes
  // Next execute() iteration will promote the next event
}
```

This serializes event handlers globally while their dependencies can still compute in parallel.

#### 4. Dependency Re-validation

Before running a handler, re-run the callback to check if dependencies changed:

```typescript
// In scheduler.ts - uses callback, no schema knowledge
function shouldRunHandler(action: OneTimeAction): boolean {
  const handler = action.handler;

  // Re-run callback to get current dependencies
  const tx = this.runtime.edit();
  if (handler.populateDependencies) {
    handler.populateDependencies(tx);
  }
  const currentDeps = txToReactivityLog(tx).reads;
  tx.rollback();

  const depsMatch = sameAddresses(action.declaredDeps, currentDeps);

  if (!depsMatch) {
    // Dependencies changed - a reference resolved differently
    // Update deps and reschedule
    action.declaredDeps = currentDeps;
    setDependencies(action, { reads: currentDeps, writes: [] });
    pending.add(action);
    return false; // Will be re-sorted in next iteration
  }

  // Check if any deps are dirty (excluding throttled/debounced)
  for (const dep of currentDeps) {
    if (this.isAddressDirty(dep)) {
      const producingAction = this.getActionForAddress(dep);
      if (producingAction &&
          (this.getThrottle(producingAction) > 0 ||
           this.getDebounce(producingAction) > 0)) {
        continue; // Throttled/debounced allowed to be stale
      }
      // Still dirty - shouldn't happen if topo sort is correct, but reschedule
      pending.add(action);
      return false;
    }
  }

  return true;
}
```

---

## Design Decisions

### Separation of Concerns

The scheduler remains schema-agnostic:
- **scheduler.ts**: Only knows about addresses, transactions, actions, dependency graphs
- **runner.ts**: Knows about schemas, cells, validateAndTransform
- **Callback bridge**: Handler registration includes a `populateDependencies` callback that the scheduler invokes to discover deps via transaction reads

This keeps the scheduler clean and testable without schema dependencies.

### Unified Scheduling Model

Everything is an action. Event handlers are just one-time actions with:
- Declared reads (discovered via callback)
- No writes (handlers write via cell.set() which creates separate transactions)
- One-shot semantics (unsubscribe after running)

This means topological sort naturally orders inputs before handlers.

### Handlers Are One-Time, Not Reactive

Unlike lifts/derives, handlers don't re-run when inputs change. They run once per event. After running, they're unsubscribed. This is intentional:
- Handlers are triggered by events, not data changes
- Most handlers write to state they also read (would create cycles if reactive)
- The "one-time action" model captures this perfectly

### Global FIFO Event Ordering

Events run in global FIFO order - if event A arrives before event B, A runs first regardless of which stream they're on. This preserves causality from the user's perspective.

We enforce this by:
1. Maintaining a single global event queue with arrival order
2. Only promoting the first event to the work set
3. Promoting the next after completion

This means events are serialized globally, but their *dependencies* can still be computed in parallel during the topo sort phase.

### Event Handler Priority in Pull Mode

In pull mode's topological sort, event handlers get priority: they run first among actions at the same "level" (no dependency relationship). This ensures user interactions feel responsive while still respecting data dependencies.

```typescript
function topologicalSort(workSet: Set<Action>): Action[] {
  // ... standard topo sort ...

  // When multiple actions have no dependencies left (same level),
  // prioritize event handlers
  const ready = [...workSet].filter(a => inDegree.get(a) === 0);
  ready.sort((a, b) => {
    const aIsHandler = isOneTimeHandler(a) ? 0 : 1;
    const bIsHandler = isOneTimeHandler(b) ? 0 : 1;
    return aIsHandler - bIsHandler; // handlers first
  });

  // ... continue sort ...
}
```

This is a hybrid: handlers still run after their dependencies (correctness), but before unrelated computations (responsiveness).

### Dependency Re-validation

Why re-validate before running? Because during the execute cycle:
1. Computation A runs, changes a reference in handler's input
2. The reference now points to cell X instead of cell Y
3. Cell X might be dirty and needs computing first
4. Handler's effective dependencies changed - reschedule it

This is a fixpoint: keep re-validating until deps stabilize (bounded by iteration limit).

### Throttled/Debounced Dependencies Are Allowed to Be Stale

If a dependency's producing action has `throttle` or `debounce` configured, the user has explicitly opted into staleness. We don't wait for these to be current.

---

## Implementation Plan

### Phase 1: traverseCells Flag in validateAndTransform

**Goal**: Allow dependency traversal into nested Cells

**Tasks**:
- [ ] Add `options?: { traverseCells?: boolean }` parameter to `validateAndTransform` in schema.ts
- [ ] When `traverseCells` is true and creating a Cell for `asCell`, also call `.get({ traverseCells: true })` on it
- [ ] Thread options through recursive calls
- [ ] Add `options` parameter to Cell `.get()` method to pass through to validateAndTransform
- [ ] Unit tests for traverseCells behavior

### Phase 2: Dependency Callback in Handler Registration

**Goal**: Allow handlers to register a callback that populates dependencies

**Tasks**:
- [ ] Add `populateDependencies?: (tx: IExtendedStorageTransaction) => void` to EventHandler interface in scheduler
- [ ] Update `addEventHandler()` signature to accept the callback
- [ ] In runner.ts, create callback that does `inputsCell.asSchema(schema).get({ traverseCells: true })`
- [ ] Pass callback when registering handlers
- [ ] Unit tests for callback invocation

### Phase 3: Global FIFO Event Queue

**Goal**: Ensure events run in global arrival order

**Tasks**:
- [ ] Add `activeHandler: OneTimeAction | null` to Scheduler
- [ ] Add `promoteEventsToActions()` method - only promotes first event
- [ ] Add `onHandlerComplete()` method - shifts queue, clears activeHandler
- [ ] Ensure only one handler runs at a time globally

### Phase 4: One-Time Action Support

**Goal**: Support actions that run once and unsubscribe

**Tasks**:
- [ ] Add `isOneTime` flag to Action type (or separate OneTimeAction type)
- [ ] Modify `run()` to call `onHandlerComplete()` for one-time actions
- [ ] Ensure one-time actions aren't marked dirty by input changes
- [ ] Ensure unsubscribe happens after successful completion

### Phase 5: Dependency Re-validation

**Goal**: Re-validate handler deps before running

**Tasks**:
- [ ] Add `shouldRunHandler()` method to Scheduler
- [ ] Implement dependency comparison (`sameAddresses`)
- [ ] Handle reschedule when deps change
- [ ] Add iteration limit for safety
- [ ] Skip dirty check for throttled/debounced deps

### Phase 6: Integration & Testing

**Tasks**:
- [ ] Test: handler with computed input sees current value
- [ ] Test: handler with nested `asCell` properties
- [ ] Test: handler with `additionalProperties` (dynamic deps)
- [ ] Test: events run in global FIFO order
- [ ] Test: dependency re-validation reschedules correctly
- [ ] Test: throttled/debounced deps allowed stale

---

## Alternative Approaches Considered

### A: Separate Pull-Before-Handler Loop

**Idea**: Keep separate event queue, explicitly pull deps before each handler

**Problems**:
- Two scheduling models to maintain
- Pull logic duplicates what topo sort already does
- More complex mental model

### B: Make Handlers Async

**Idea**: Allow userland handlers to be async and call `pull()` themselves

**Problems**:
- Breaking API change
- Burden on pattern developers
- Easy to forget and get stale data
- Doesn't work with existing patterns

### C: Eager Pull on Every Get

**Idea**: Make `.get()` automatically pull if cell is dirty

**Problems**:
- Makes `.get()` async (breaking change) or blocking (bad for perf)
- Doesn't compose well with sync handler execution

### D: Pre-Schedule Handler Inputs

**Idea**: When handler is registered, also subscribe its input cells as computations

**Problems**:
- Wasteful - computes even when handler isn't triggered
- Doesn't capture the "on-demand" nature of pull-based scheduling

---

## Open Questions

1. **Performance**: How expensive is dependency collection from schema? Should we cache the static parts?

2. **Iteration limit**: What's the right limit for dependency re-validation iterations? 20 seems reasonable.

3. **Error handling**: If a handler throws, should the next event still run? Probably yes, with error logged.

---

## Related Files

- `packages/runner/src/scheduler.ts` - Event queue and execution
- `packages/runner/src/runner.ts` - Handler registration (lines 969-1069)
- `packages/runner/src/schema.ts` - `validateAndTransform` and schema utilities
- `packages/runner/src/cell.ts` - `createCell` and Cell class
- `packages/runner/src/builder/module.ts` - Handler/module definitions
