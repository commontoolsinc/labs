---
status: historical
created: 2026-08-12
archived: 2026-08-12
reason: "Investigation of the 10 August 2026 benchmark step, traced to two chains of zero-delay timers and the cost of waking Deno's event loop for one."
---

# What a loopback frame was spending its time on, August 2026

## Result

The dashboard's benchmark index stepped 22.6% on the AMD EPYC 7763 across one
commit boundary on 10 August 2026, and 17.0% on the Intel Xeon Platinum 8573C.
The commit is
[b96b47a24](https://github.com/commontoolsinc/labs/commit/b96b47a2401df365adf56281616c40e13bb40570),
"feat(memory,runner): loopback delivers on timer turns; delete the flush-on-send
nudge (CT-1962)" (#5550). The machine calibration moved 0.8% and -1.3% across
the same step, so the step was code.

The cost was the price of waking Deno's event loop for a zero-delay
`setTimeout`, which is about 2.3 milliseconds on the machine these measurements
were taken on, paid twice per round trip. Once in the loopback transport, which
took a timer per server frame. Once in the memory server, whose subscription
refresh the same commit moved onto a zero-delay timer of its own. Nothing about
the work the runtime did changed: the same run exchanges the same number of
frames before and after, and spends about 2.5 extra milliseconds on each of
them doing nothing.

The fix keeps the delivery model the commit was buying and takes the waiting
out of it. Both places now schedule through one helper, `armTurn` in
`packages/memory/v2/turn.ts`, which claims a zero-delay turn two ways at once:
a `setTimeout`, because that is the claim every host offers and the one a
fake-clock test harness accounts for, and a `setImmediate`, which is the same
turn for about a microsecond. Whichever arrives first runs the handler and
cancels the other.

After the fix, the benchmark that stepped hardest is back to the wall clock it
had before the commit, to within a tenth of a millisecond.

## What the commit changed

Before it, `loopback` handed each server frame straight to the client's
receiver, synchronously, inside the server call that produced it. A response
could therefore be observed inside the sender's own await cascade, which no
real socket can do. The commit made delivery honest: frames queue, and a pump
delivers one per event-loop task, so nothing arrives until the sender yields.

```ts
const drainOne = () => {
  pump = null;
  if (closed) return;
  const frame = queue.shift();
  if (frame === undefined) return;
  receiver(frame);
  if (queue.length > 0) schedule();
};
const schedule = () => {
  pump ??= setTimeout(drainOne, 0);
};
```

Two properties come out of that, and both are wanted. No response or push
arrives inside the sender's await cascade, so code that depends on "nothing
arrives until I yield" fails against loopback the way it would against a
deployment. And one frame per task means a frame's whole microtask cascade —
response resolution, the `request()` continuation, the caller's continuation —
finishes before the next frame lands, which `SpaceSession`'s single-flight
watch-apply path relies on by name.

In the same change, the single-manager `StorageManager.emulate()` harness lost
its flush-on-send nudge — a `queueMicrotask` that flushed the server's session
fan-out after every request — and gained a server built with
`subscriptionRefreshDelayMs: 0` instead. A commit's promise resolves at marker
coverage, and the marker rides that fan-out, so every awaited commit now waits
for a zero-delay refresh timer where it used to wait for a microtask.

Traffic through both is strictly serialized: a request goes out, its response
frame comes back, the client continues, and only then does the next request go
out. Neither the pump nor the refresh ever has two turns outstanding. Every
frame arms its own timer, waits for it, and arms the next.

## Waking Deno's event loop for a zero-delay timer

The whole regression is the cost of that wait. Measured on Deno 2.9.4,
aarch64-apple-darwin, as the average over a chain of 500:

| How the turn is taken | Cost per turn |
| --- | ---: |
| `setTimeout(fn, 0)`, one after another | 2308 µs |
| `setTimeout(fn, 1)`, one after another | 2295 µs |
| `setTimeout(fn, 2)`, one after another | 2319 µs |
| `setTimeout(fn, 4)`, one after another | 4578 µs |
| 500 zero-delay timers armed together | 7.7 µs |
| `setImmediate`, one after another | 0.95 µs |

This is not the nested-timer clamp browsers apply, which would show up as a
step at the fifth level of nesting and a 4 ms floor. The first ten gaps in a
chain are 1.59, 2.33, 2.32, 2.30, 2.32, 2.33, 2.32, 2.32, 2.32, 2.31
milliseconds — flat from the second one on. Nor is it the delay being rounded
up, since 1 ms and 2 ms cost the same as 0 ms while 4 ms costs its own 4 ms.
It is how long it takes this Deno build to park and wake the event loop for a
timer that is the only thing pending. Timers armed together do not pay it,
because one wake-up serves all of them; a chain pays it once per link.

A chain of `setImmediate` does not starve timers. With a 1 ms interval armed,
the interval fires after 670 hops of an immediate chain, 1.2 ms in; a
zero-delay timeout armed alongside fires after 2136 hops, which is the same
2.3 ms wake-up measured above.

## Frames, timers, and where the wall clock went

A standalone reproduction of the `scheduler-demand-roots` effect benchmark —
a 24-effect graph driven through ten rounds, counting frames and pump timers
inside `loopback`:

| Tree | Wall clock | Frames | Pump timers |
| --- | ---: | ---: | ---: |
| e8714f36d, the parent | 141 ms | 560 | 0 |
| b96b47a24, the commit | 1525 ms | 588 | 588 |
| b96b47a24 plus the transport fix | 150 ms | 550 | 550 |

The frame count is the same in all three. The commit added 1384 ms across 588
frames, which is 2.4 ms a frame, and the timer measurement above says a frame's
timer costs 2.3 ms. There is no other cost in it.

The second timer shows up in the benchmark that does nothing but commit —
`Cell.set() - multiple transactions, one set each`, a hundred `await
tx.commit()` calls one after another. With only the transport fixed it ran in
273 ms, which is 2.7 ms a commit: one wake-up, for the server's refresh.

## The benchmarks

Three measurements on one machine, taken one run after another rather than
side by side. Only entries that moved by more than a tenth are listed.

Across the commit, its parent against itself:

| Benchmark | Parent | Commit | Step |
| --- | ---: | ---: | ---: |
| `cell-set`, transaction, multiple transactions one set each | 34.9 ms | 943.0 ms | 27.0x |
| `scheduler-demand-roots`, effect demand root | 125.2 ms | 1461.3 ms | 11.7x |
| `scheduler-demand-roots`, parent clears generated children | 66.0 ms | 672.7 ms | 10.2x |
| `scheduler-demand-roots`, mixed effect and event roots | 188.0 ms | 1583.3 ms | 8.4x |
| `scheduler-demand-roots`, event demand root | 98.2 ms | 334.9 ms | 3.4x |
| `cell-set`, update-vs-set, set() for partial changes | 4.7 ms | 15.2 ms | 3.3x |
| `cell-set`, writes, ~50 writes | 3.8 ms | 8.8 ms | 2.3x |
| `cell-set`, single transaction many sets | 0.56 ms | 0.89 ms | 1.6x |

The steps are larger here than the ones CI reported — 27x against 5.8x for the
first row — because the ratio is a fixed cost divided by a variable one. The
per-turn wait is roughly the same everywhere; what differs is how fast the host
is at the work the benchmark is actually for. A faster host does the work
sooner and so spends a larger share of the run waiting.

Which benchmarks moved follows directly from how many round trips they make.
The three slowest `cell-set` entries by wall clock — the array cases at 88 ms,
646 ms and 876 ms — did not move at all, because they are one transaction's
worth of frames wrapped around a lot of local work. The transaction-per-set
case moved 27 times, because it is almost nothing but round trips.

Then the fix, against `main` at 95aef62e0, over eight benchmark files. The
worst-hit entries:

| Benchmark | `main` | Fixed | Ratio |
| --- | ---: | ---: | ---: |
| `cell-set`, transaction, multiple transactions one set each | 926.4 ms | 34.8 ms | 0.04x |
| `storage-source-topology-refresh`, pattern-linked roots | 696.4 ms | 41.4 ms | 0.06x |
| `storage-source-topology-refresh`, plain roots | 687.7 ms | 41.6 ms | 0.06x |
| `scheduler-stale-propagation`, wide fanout | 2982.1 ms | 222.9 ms | 0.07x |
| `storage-subscription-filter`, path-scoped schema refresh | 678.8 ms | 55.2 ms | 0.08x |
| `scheduler-demand-roots`, effect demand root | 1496.3 ms | 125.5 ms | 0.08x |
| `scheduler-demand-roots`, mixed effect and event roots | 1583.3 ms | 155.8 ms | 0.10x |
| `scheduler-demand-roots`, parent clears generated children | 653.9 ms | 72.1 ms | 0.11x |

Across all 52 benchmarks in those files the median ratio is 0.284, and the
slowest entry is 0.99x, so nothing regressed.

And the fix against the parent of the offending commit, which is the question
of whether the regression is gone rather than merely reduced. Every entry is at
or below where it was, except one 66 ms benchmark 9% above, which is run-to-run
movement:

| Benchmark | Parent | Fixed | Ratio |
| --- | ---: | ---: | ---: |
| `scheduler-demand-roots`, parent clears generated children | 66.0 ms | 72.1 ms | 1.09x |
| `scheduler-demand-roots`, effect demand root | 125.2 ms | 125.5 ms | 1.00x |
| `cell-set`, transaction, multiple transactions one set each | 34.9 ms | 34.8 ms | 1.00x |
| `scheduler-demand-roots`, event demand root | 98.2 ms | 92.0 ms | 0.94x |
| `scheduler-demand-roots`, mixed effect and event roots | 188.0 ms | 155.8 ms | 0.83x |

Most other entries sit well below 1.0 because three days of unrelated work
landed between the parent and `main`.

## The fix

`packages/memory/v2/turn.ts` is new, and holds the rule once:

```ts
export const armTurn = (handler: () => void, delayMs = 0): ArmedTurn => {
  // ...
  timer = setTimeout(run, delayMs);
  if (delayMs === 0) {
    immediate = immediates.setImmediate?.(run) ?? null;
  }
  return { cancel };
};
```

The loopback pump calls it per frame, and the server's `scheduleRefresh` calls
it per fan-out, passing its configured delay. A delay above zero asks for a
real wait, and only a timer can give one, so the deployed server's 5 ms
coalescing window is untouched.

Keeping the timer armed is not belt and braces. The runner's fake-clock harness
in `packages/test-support/test/clock-preload.ts` decides that a test has
settled by looking for zero-delay timers that are armed and have not yet run;
`clock.settle()` returns when it finds none. A turn carried only by
`setImmediate` would arrive just as promptly and leave `settle()` with nothing
to wait on, so a test could observe a state with a frame still in flight. The
server's `idle()` reads the same signal to decide whether fan-out is owed.
Where `setImmediate` does not exist — a browser — the timer carries the turn on
its own, as it did before this change.

That harness also had to learn about `setImmediate`, and finding out why cost
three failing tests in `packages/runner`. The harness replaces `setTimeout` and
fires every zero-delay timer from one `kick()`, in registration order, in a
single real task. An unpatched `setImmediate` runs beside all of that, on the
real event loop, so a turn taken through one arrived ahead of every turn the
harness was holding — a reordering, and one no `clock.tick()` or `settle()`
could hold back. The harness now registers an immediate as a zero-delay timer,
which puts it back in the same batch and the same census. Under the fake clock
the two claims are therefore both harness timers and the scheduling is
identical to what it was before this change; the cheap turn is what a run with
no harness — a benchmark — gets.

Making them both harness timers then exposed a second thing, and cost two more
failing tests. `kick()` iterates a snapshot of the batch, so a callback that
cleared a later one in the same batch did not stop it: the cleared entry was
still in the snapshot and ran anyway. `armTurn` clears the losing claim from
the winner's callback, and both claims sit in one batch, so its handler ran
twice — two frames on one turn, and one fan-out flushed twice. A real clock
does not fire a cleared timer, and `kick()` now re-checks membership before
firing, so it does not either. `armTurn` also refuses a second run outright,
which makes "the handler runs once" true by construction rather than by the
scheduler underneath behaving.

### Why not a posted message

A `MessageChannel` is the usual cheap macrotask, and `yieldToEventLoop` in
`packages/utils/src/sleep.ts` already uses one. It does not work here. As soon
as anything in the process loads Deno's Node compatibility layer — which
`packages/memory/v2/client.ts` does, through its own dependencies — the global
`MessageChannel` is replaced by Node's, and Node's ports deliver inside a
microtask cascade rather than on a turn of their own.

Measured by posting a message and then running a 200-deep `queueMicrotask`
chain, checking at each hop whether the handler has run:

| Global in effect | Handler runs at |
| --- | --- |
| Web `MessageChannel` | not within the cascade |
| Node `MessageChannel`, after importing `../v2/client.ts` | hop 1 of the cascade |

A pump built on that would have delivered frames inside the sender's own await
cascade, which is precisely the property the commit was written to establish.
The first version of this fix did exactly that, and the delivery-model test
caught it. `setImmediate` was measured the same way and does not interleave.

The same measurement says `yieldToEventLoop`'s macrotask premise does not hold
in a process that has loaded node compatibility, and its ports are also the
reason `MessagePort.close()` was observed running a queued handler
synchronously. That is a separate defect in a separate subsystem with its own
callers, and it is not addressed here.

## What guards this

`packages/memory/test/v2-turn.test.ts` pins `armTurn`: the handler runs on a
later turn rather than inside a microtask cascade, it runs once when both
claims are live, a zero-delay turn keeps a timer armed until it arrives, the
turn still arrives with `setTimeout` stubbed out and separately with
`setImmediate` absent, a delayed turn is claimed by the timer alone, and
`cancel()` stops it.

`packages/runner/test/fake-clock-zero-delay-batch.test.ts` pins the two harness
properties the fix stands on: a `setImmediate` runs in registration order among
the zero-delay timers around it rather than ahead of them, and a zero-delay
callback cleared by an earlier one in the same batch — timer or immediate —
does not run.

`packages/memory/test/v2-loopback-delivery.test.ts` pins the transport's
delivery model through the real pump, in the two directions that can break:

- No frame arrives inside the sender's own await cascade.
- A frame's microtask cascade runs out before the next frame arrives.
- A queued frame always has a zero-delay timer armed. Against a pump with the
  timer claim removed, this fails.
- With `setTimeout` stubbed to never fire, a frame is still delivered. Against
  the pump as the commit left it, this wait never resolves and Deno fails the
  test.

Benchmark numbers themselves are not gated, and this change does not add a
gate. `docs/development/BENCHMARKS.md` says why: the only per-pull-request gate
is the coverage-debt ratchet, which never reads benchmark results, so a
benchmark regression shows up as trend drift on the dashboard rather than as a
failing check. The three benchmarks the dashboard named here — the two
`scheduler-demand-roots` cases and the `cell-set` transaction-per-set case —
already existed and already moved on the run that introduced the regression.
Nothing read them.

## Method

Local, no CI. Each tree was checked out into its own worktree and measured with
the repository's pinned Deno:

```sh
export PATH="$HOME/.local/share/mise/installs/deno/2.9.4/bin:$PATH"
CF_LOG_LEVEL=silent deno bench --json -A --v8-flags=--expose-gc \
  packages/runner/test/scheduler-demand-roots.bench.ts \
  packages/runner/test/cell-set.bench.ts
```

Runs were taken one after another rather than side by side; two `deno bench`
processes on one machine contend, and an early side-by-side pair disagreed with
the sequential pair by enough to matter. Benchmarks were matched on origin,
group and name, and the number compared is `results[0].ok.avg`, which is what
the dashboard reads.
