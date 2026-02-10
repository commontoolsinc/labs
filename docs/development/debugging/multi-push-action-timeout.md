# Scheduler: Fire-and-Forget Commit Causes Action Timeouts

## TL;DR

`scheduler.run()` calls `tx.commit()` without awaiting it. During a single
`execute()` cycle, 60-80 of these fire-and-forget commits pile up. Their
`.then()` callbacks all run *after* `execute()` finishes, blocking the event
loop for 6-10 seconds and preventing `idle()` from resolving.

**Symptom**: Any action that triggers enough reactive work (e.g. pushing 2+
sub-pattern instances into an array) times out at 5s even though `execute()`
finishes in ~2s.

**Fix**: Track outstanding commit promises and drain them via `Promise.all()`
in `execute()` before resolving idle promises. This preserves the original
fire-and-forget parallelism in `run()` while ensuring all commit callbacks
complete before `idle()` resolves.

## The Problem

### How `run()` works

In `scheduler.ts`, the `run()` method executes a single reactive action. At the
end of each action, it commits the transaction:

```typescript
// scheduler.ts — run(), inside finalizeAction() — BEFORE fix

const commitPromise = tx.commit();           // fire-and-forget
commitPromise.then(({ error }) => {          // callback queued for later
  if (error) {
    // retry logic...
    this.resubscribe(action, log);
    this.dirty.add(action);
    this.pending.add(action);
    this.queueExecution();
  } else {
    this.retries.delete(action);
  }
});
const log = txToReactivityLog(tx);
this.resubscribe(action, log);              // sync resubscribe runs now
resolve(result);                            // resolves runningPromise immediately
```

The `resolve(result)` runs **without waiting for `tx.commit()` to complete**.
This is intentional — the comment says the code "assumes the commit will be
successful" and continues optimistically. The `.then()` callback is just error
handling.

### How `execute()` uses `run()`

The settle loop in `execute()` calls `run()` for each action and awaits it:

```typescript
// scheduler.ts — execute(), settle loop

for (const fn of order) {
  // ...validity checks...
  await this.run(fn);    // awaits runningPromise, NOT the commit
}
```

Since `run()` resolves before the commit completes, `execute()` moves on to
the next action immediately. Each action leaves a dangling commit promise
behind.

### What goes wrong

After the settle loop finishes, `execute()` resolves the idle promises:

```typescript
// scheduler.ts — execute(), after settle loop

const promises = this.idlePromises;
for (const resolve of promises) resolve();   // resolves idle promises
```

This *calls* `resolve()` synchronously, but the caller's `.then()` callback
(e.g. the test runner's `await runtime.idle()`) is queued as a microtask. It
can't run until the current microtask queue drains.

Meanwhile, all 60-80 commit `.then()` callbacks from the settle loop are
sitting in that queue. They run first, one by one. Each one processes commit
results and runs `resubscribe()` on error. In aggregate, this takes
**6-10 seconds**.

### Timeline (measured via instrumentation)

For a `createNotes` action that pushes 2 sub-patterns:

| Event | Wall time | Notes |
|-------|-----------|-------|
| `.send()` dispatches event | 0ms | |
| `execute()` starts settle loop | ~2ms | |
| settle[0]: 49 actions | | |
| settle[1]: 22 actions | | |
| settle[2]: 8 actions | | |
| `execute()` resolves idle promises | 2,275ms | All real work done |
| Commit callbacks run | 2,275–8,700ms | ~60 stale `.then()` callbacks |
| `idle().then()` finally fires | 8,715ms | 6.4s gap |

The callbacks aren't just from this action — they include **stale callbacks
from initial pattern setup** (the first `execute()` cycle runs ~68 actions
whose commit promises hadn't resolved yet).

### Why it only affects multi-push

A single push triggers fewer settle iterations and fewer total actions.
The commit backlog stays small enough to drain quickly. Two pushes roughly
doubles the reactive work, pushing the backlog past the 5s timeout threshold.

## The Fix

Track outstanding commit promises in `run()` and drain them before resolving
idle in `execute()`:

```typescript
// scheduler.ts — run(), inside finalizeAction() — AFTER fix

// Capture the reactivity log BEFORE committing, because commit
// closes the journal and the activity log becomes unavailable.
const log = txToReactivityLog(tx);

// Fire-and-forget commit, but track the promise for draining.
const commitPromise = tx.commit();
this.outstandingCommits.add(commitPromise);
commitPromise.then(({ error }) => {
  this.outstandingCommits.delete(commitPromise);
  if (error) {
    // retry logic...
  } else {
    this.retries.delete(action);
  }
});

this.resubscribe(action, log);              // sync resubscribe (unchanged)
resolve(result);                            // resolves immediately (unchanged)
```

```typescript
// scheduler.ts — execute(), before resolving idle — AFTER fix

if (this.outstandingCommits.size > 0) {
  const commits = [...this.outstandingCommits];
  Promise.all(commits).then(() => {
    for (const resolve of this.idlePromises) resolve();
    this.idlePromises.length = 0;
  });
} else {
  for (const resolve of this.idlePromises) resolve();
  this.idlePromises.length = 0;
}
```

`run()` still resolves immediately — the settle loop proceeds at full speed.
But `idle()` now waits for all commit callbacks to drain before resolving,
so the caller sees a clean event loop.

### Why not await in `run()`?

We initially tried `const commitResult = await tx.commit()` directly in
`finalizeAction()`. This serialized commits within the settle loop, which
seemed cleaner but broke two things:

1. **Journal ordering**: `txToReactivityLog(tx)` was called after commit,
   but `tx.commit()` calls `journal.close()`, making the activity log
   unavailable. Moving `txToReactivityLog` before the await fixed unit
   tests but not the integration failure.

2. **Reactive graph rehydration**: The `await` changed the interleaving
   between actions and their commit callbacks during the settle loop.
   When rehydrating a recipe in a fresh runtime (cross-session persistence),
   `computeSum` saw `undefined` because the input data wasn't visible yet
   at the point the rehydrated action ran. The original fire-and-forget
   behavior relies on `resubscribe` running synchronously so the dependency
   graph is updated immediately for the next action in the loop.

### Tradeoffs

**Positive:**
- Eliminates the callback backlog entirely
- `idle()` resolves promptly after `execute()` finishes
- The multi-push timeout goes away (tested: 94/94 notes tests pass)
- Preserves original reactive semantics — `run()` resolves the same way
- No change to commit parallelism (commit I/O for action N still overlaps
  with execution of action N+1)

**Potential concerns:**
- Adds bookkeeping (the `outstandingCommits` Set)
- `idle()` now waits for commit I/O to finish, which could add latency
  in environments with slow remote storage. In practice, the settle loop
  itself takes longer than the commits, so they're already resolved by the
  time `execute()` finishes.
- There's a second fire-and-forget commit in the event handling path
  (`execute()` around line 2080) which has the same pattern but is less
  critical since events only fire once per `execute()` cycle.

### Alternative approaches considered

1. **Await commit in `run()`** — simpler code, but serializes commits and
   breaks reactive graph rehydration (see above).

2. **Batch commits** — one commit per settle iteration instead of per action.
   More complex, changes transactional semantics.

3. **Optimize resubscribe()** — profile the callback work, reduce cost.
   Treats the symptom; backlog would still exist.

4. **queueMicrotask for idle resolution** — run idle callbacks before commit
   callbacks. Fragile, depends on microtask ordering assumptions.

## Test Results

With the fix applied:
- `packages/runner/test/` (full suite): 163 passed, 0 failed
- `packages/runner/integration/` (full suite): 8 passed, 0 failed
- `packages/patterns/notes/` (full test suite): 94 passed, 0 failed — up
  from 92, because the bulk `createNotes` test that was commented out as
  a known bug now works within the default 5s timeout

## Reproduction

Push 2+ sub-pattern instances in a single action. For example, via the
`createNotes` handler in `packages/patterns/notes/notebook.tsx`:

```typescript
notebook.createNotes.send({
  notesData: [
    { title: "Bulk Note 1", content: "First bulk note" },
    { title: "Bulk Note 2", content: "Second bulk note" },
  ],
});
// → times out at 5s without fix, completes in ~2s with fix
```

## Discovered during

Notes pattern refactor (`patterns/notes-modernization-v2` branch). The
`notes-import-export.tsx` `performImport` function creates multiple
Notes/Notebooks and pushes them, triggering this issue.
