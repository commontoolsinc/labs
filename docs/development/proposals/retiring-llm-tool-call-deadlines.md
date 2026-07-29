# Retiring the LLM Tool-Call Deadline

_Replacing the wall-clock deadline on LLM tool calls with a quiescence barrier
scoped to a single pattern run, so a tool call ends because the work finished or
because it was cancelled — never because a timer fired._

**Status:** proposed · **Updated:** 2026-07-28

---

## Why

`packages/runner/src/builtins/llm-dialog.ts` carries two wall-clock deadlines,
and they are not the same kind of thing.

`TOOL_CALL_TIMEOUT` (120 seconds) races every tool call. A tool that has not
produced a result by then is abandoned, and the model is handed
`{ type: "error-text", value: "Tool call timed out" }` in place of the tool's
output. It bounds how long a **local computation** may take, which is a question
the runtime can answer exactly. This document is about removing it.

`REQUEST_TIMEOUT` (5 minutes) bounds how long to keep believing a **different
replica** is still working on a dialog. That is failure detection, and it cannot
be made exact — see
[phase 4](#phase-4--narrow-the-message-drop-heuristic-which-cannot-be-removed).
Do not delete it on the strength of the argument for the first.

`TOOL_CALL_TIMEOUT` is the shape `AGENTS.md` rules out: a bound on how long
success may take. By the test in
[`waiting-in-tests.md`](../waiting-in-tests.md#wall-clock-time-is-not-a-measure-of-progress)
— "is firing early safe?" — it is not. Firing early discards a real result and
misreports it to the model as a failure.

It is not there out of carelessness. Before it existed the code was a bare
`await` on the tool's result cell, and a userland pattern that never writes a
result hangs that await forever. The deadline stands in for a completion signal
the runtime cannot currently produce, and for a cancellation path that does not
reach tool calls. Both are buildable.

## What a tool call is actually waiting for

`executeToolCall` creates a result cell, starts the tool, and waits:

- a **handler** tool resolves from the callback its `send` is given, which fires
  when the handler's transaction completes. This half is already event-driven.
- a **pattern** tool calls `runtime.run(tx, pattern, args, result)` and waits on
  `result.sink(r => r !== undefined && resolve(r))`.

The pattern case is the problem, and the reason is that the signal is
value-shaped. "The result cell became defined" conflates two questions — has the
run finished, and did it produce anything — so a run that finishes having
written nothing is indistinguishable from one still working. There is no moment
at which the wait can conclude that nothing is coming, and a timer fills the gap.

## The barrier that exists, and why it cannot be used directly

`Runtime.trackAsyncWork(promise)` registers in-flight asynchronous builtin work
and `Runtime.settled()` waits for scheduler quiescence, storage sync, and every
registered promise, re-checking until all three hold together.

It cannot serve the tool call: the tool call runs *inside* tracked work. The
dialog turn is registered with `trackAsyncWork`, and the tool call happens within
that turn's promise, so awaiting `settled()` would await the promise the caller
is inside. A variant that awaited everything except its own promise would make a
tool call depend on unrelated activity anywhere in the runtime. The barrier has
to be **scoped to the run**.

## The scoping already exists

Scoping needs work attributed to the run that started it, and the link is
already threaded everywhere. `Runner.instantiateNode` is called once per node
with the **same** `resultCell` — the pattern instance's own cell
(`runner.ts`, the `for (const node of pattern.nodes)` loop) — and that cell is
handed to every raw builtin as its `parentCell` argument (`module.ts`). So a
builtin already knows the run it belongs to, and the tool call already holds the
same cell: it is the one it passed to `runtime.run`.

No scheduler change, no action-to-run map, and no asynchronous context
propagation is needed. (The last would not have worked anyway: a child's model
call is issued from a scheduler action dispatched long after the tool call's
stack has unwound.)

**Nesting composes without a lineage graph.** A tool call waits on the run it
started. If that child itself calls a tool, the child's own wait sits inside the
child's tracked promise, so waiting on the child transitively covers the
grandchild. Each level only needs to know its own direct child.

## Phase 1 — make the existing barrier truthful (landed)

`startRequest` chained response handling off the model call as a bare statement
and never returned it, so the promise handed to `trackAsyncWork` was its own
setup; the continuation turn after tool calls recursed without being awaited, so
each hop escaped the previous hop's promise. `settled()` therefore returned while
a request was in flight. No test caught it, because a mocked response arrives
within a microtask and `settled()` loops until no tracked work remains — the gap
only opens at real latency.

`startRequest` now returns its chain and awaits its continuation.
`setMockResponseGate` holds a mock response open so a test can observe the system
while a request is genuinely outstanding, which is what
`packages/runner/test/llm-dialog-settled.test.ts` pins.

A scoped barrier built on a registry that did not see this work would inherit the
same hole, so this comes first.

## Phase 2 — make cancellation reach tool calls

Ordered before the barrier deliberately: it fixes a live bug on its own, and it
is what makes removing the deadline safe rather than merely correct.

A reactive action already aborts a turn when the durable `pending` cell goes
false or a newer request supersedes it, and `cancelGeneration` sets `pending`
false so the effect reaches every replica. That trigger side is event-driven
already.

The consumption side is narrow. `abortSignal` reaches exactly one consumer, the
model call; `executeToolCalls` takes no signal at all. **So cancelling a turn
that is inside a tool call stops nothing.** The tool call runs to its deadline,
and the `requestId` guard then discards the writeback — the effect is suppressed,
the work never was.

Two changes:

- Thread the turn's `abortSignal` into `executeToolCalls`/`executeToolCall`, and
  race the tool wait against it. Structurally the same race as today, against an
  event rather than a clock.
- Stop the child run on abort. Racing alone only stops *waiting*; the child
  pattern keeps computing and keeps its own model calls in flight.
  `Runner.stop(resultCell)` takes exactly the cell the tool call created.

## Phase 3 — a barrier scoped to one pattern run

**Blocked, and the blocker is not the one this document first assumed.** The
attribution mechanism works and is cheap. What does not hold is the premise
underneath it: that the async builtins register their work at all.

An instrumented run of the dynamic-schema subagent tests logged every
`trackAsyncWork` call. Across the whole suite of them the only registrations
were four commit promises from `finalizeReactiveActionCommit`
(`scheduler/run.ts`), with no owner. The `generateObject` path registered
nothing. So a barrier scoped by owner sees an empty set for those runs and
reports quiescence immediately, and the tool call reads a result cell that
nothing has written yet. Wired up as described below, it turned a passing
subagent case red by handing the model an empty tool result.

That failure mode is worse than the deadline it replaces. A deadline that fires
early reports a failure; a barrier that returns early reports a *success* with
missing data, and does it silently. So this phase does not land until
registration coverage is established first:

1. Audit every async builtin path for whether it registers its work, and fix the
   ones that do not — `generateObject` first, since it is the one the tool-call
   path runs.
2. Add a check that fails when an async builtin completes work it never
   registered, so coverage cannot silently regress. Without it, a builtin added
   later reintroduces exactly this hole and the barrier starts truncating
   results again.
3. Only then scope the registry and switch the tool wait over.

The design below is what to build once that groundwork is in place, and it is
recorded because the mechanism was proven — it was the inputs that were missing.

`trackAsyncWork` gains an owner — the `parentCell` the builtin already has — and
`Runtime.settledFor(cell)` waits for scheduler quiescence including in-flight
commits, then for the tracked work owned by that cell, re-checking until both
hold.

The tool wait then races three event-driven outcomes: the result landing, the run
quiescing, and the turn being cancelled. A pattern that produced nothing resolves
via the second, with the cell still undefined — a determinate answer rather than
a guess. `TOOL_CALL_TIMEOUT` has nothing left to do and goes.

`settledFor` uses `idleWithPendingCommits()` rather than plain `idle()`, because
a child's result writeback travels through a commit and the commit promise
registered by the scheduler carries no owner.

**What still hangs, and why that is the right trade.** A userland pattern that
spins forever with nobody watching leaves its turn pending indefinitely. Today
that turn is abandoned after two minutes and the model is told the tool failed.
Removing the deadline trades "we misreport a healthy tool as failed after two
minutes" for "the turn stays pending until the work finishes or someone cancels."
The second is truthful, and phase 2 is what makes "someone cancels" a real
option. It is also more visible, which is a product consequence worth stating
rather than discovering.

## Phase 4 — narrow the message-drop heuristic, which cannot be removed

`pending` and `internal` are durable cells and a dialog runs in more than one
replica. `safelyPerformUpdate` refreshes `internal.lastActivity` on every durable
write of a turn, guarded by a `requestId` match, so only the replica owning the
turn refreshes it. `lastActivity` is a **heartbeat** and `REQUEST_TIMEOUT` is its
staleness bound: the question is whether some *other* replica is still working,
or whether the tab that started it went away. Nothing distinguishes a crashed
peer from a slow one without a timing bound.

An early fire lets a second request start alongside a live one; the `requestId`
guard then rejects the older turn's writes, so the cost is a wasted model call
rather than corrupted state.

Narrow it rather than remove it. When *this* replica holds the turn no detection
is needed — it knows. After phase 1 the turn is a single promise spanning the
whole conversation, so a flag set when it starts and cleared when it settles
answers exactly, and the heartbeat is consulted only for a turn belonging to
another replica.

That also fixes a live bug: a turn running longer than five minutes without a
durable write stops refreshing the heartbeat, so today the replica running it
accepts a new message and starts a second request **against itself**.

## Phase 5 — retire the real-clock exemptions

With no deadline in the tool call, the three cases in
`generate-object-tools-dynamic-subagent.test.ts` and
`llm-dialog-dynamic-subagent.test.ts` have nothing the auto-advance pump can fire
early. Fold them back into their parent files, drop both entries from
`REAL_CLOCK_FILES`, and remove the "dynamic-schema subagent shape" section from
[`waiting-in-tests.md`](../waiting-in-tests.md), leaving the two exemptions that
are on the list for unrelated reasons.

Each case asserts on the delegate's own tool result, so this step proves itself:
if a deadline still fires, they go red rather than passing quietly.

## What this does not cover

`fetch-utils.ts` and `fetch-program.ts` carry their own request deadlines (5 and
10 seconds). Those bound a network call rather than userland computation, so they
raise a different question — what to do when a remote peer never answers — and
are out of scope. A run-scoped barrier is the groundwork; the policy is separate.
