# Scheduler: Fire-and-Forget Commit Causes Action Timeouts

## TL;DR

`scheduler.run()` calls `tx.commit()` without awaiting it. During a single
`execute()` cycle, 60-80 of these fire-and-forget commits pile up. Their
`.then()` callbacks all run *after* `execute()` finishes, blocking the event
loop for 6-10 seconds and preventing `idle()` from resolving.

**Symptom**: Any action that triggers enough reactive work (e.g. pushing 2+
sub-pattern instances into an array) times out at 5s even though `execute()`
finishes in ~2s.

**Fix**: Await the commit in `run()` before resolving `runningPromise`. This
serializes commit processing per-action within the settle loop, eliminating
the callback backlog.

## The Problem

### How `run()` works today

In `scheduler.ts`, the `run()` method executes a single reactive action. At the
end of each action, it commits the transaction:

```typescript
// scheduler.ts — run(), inside finalizeAction()

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

Await `tx.commit()` in `run()` before resolving `runningPromise`:

```typescript
// scheduler.ts — run(), inside finalizeAction() — AFTER fix

const commitResult = await tx.commit();       // wait for commit
const log = txToReactivityLog(tx);

if (commitResult.error) {                     // handle inline, not in .then()
  this.retries.set(action, (this.retries.get(action) ?? 0) + 1);
  if (this.retries.get(action)! < MAX_RETRIES_FOR_REACTIVE) {
    this.resubscribe(action, log);
    this.dirty.add(action);
    this.pending.add(action);
    this.queueExecution();
  }
} else {
  this.retries.delete(action);
}

this.resubscribe(action, log);
resolve(result);                              // resolves only after commit
```

This means `execute()` now waits for each action's commit to finish before
moving to the next action. No commit callbacks accumulate.

### Tradeoffs

**Positive:**
- Eliminates the callback backlog entirely
- `idle()` resolves promptly after `execute()` finishes
- The multi-push timeout goes away (tested: 94/94 notes tests pass)
- Simpler code — no floating `.then()`, no split between sync and async paths

**Potential concerns:**
- Commits are now serialized within the settle loop. Previously, commit I/O
  for action N could overlap with execution of action N+1. In practice this
  matters most for remote commits over the network; in emulated/local storage
  the commit is near-instant.
- There's a second fire-and-forget commit in the event handling path
  (`execute()` around line 2071) which has the same pattern but is less
  critical since events only fire once per `execute()` cycle.

### Alternative approaches considered

1. **Batch commits** — one commit per settle iteration instead of per action.
   More complex, changes transactional semantics.

2. **Optimize resubscribe()** — profile the callback work, reduce cost.
   Treats the symptom; backlog would still exist.

3. **queueMicrotask for idle resolution** — run idle callbacks before commit
   callbacks. Fragile, depends on microtask ordering assumptions.

4. **Track outstanding commits, drain before idle** — keep fire-and-forget
   but collect promises, `Promise.all()` before resolving idle. Preserves
   parallelism but adds bookkeeping.

We went with option 1 (await in-line) for simplicity and correctness. If
commit serialization turns out to regress latency in production, option 4
would be the next thing to try.

## Test Results

With the fix applied:
- `packages/runner/test/scheduler.test.ts`: 107 steps, all pass
- `packages/runner/test/` (full suite, excluding benchmarks): 163 passed, 1
  pre-existing failure (unrelated import in `derive-type-inference.test.tsx`)
- `packages/patterns/notes/` (full test suite): 94 passed, 0 failed — up
  from 93, because the bulk `createNotes` test that was commented out as
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
