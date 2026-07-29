# Retiring the LLM Tool-Call Deadline

_Replacing the wall-clock deadline on LLM tool calls with a quiescence barrier
scoped to a single pattern run, so a tool call ends because the work finished or
because it was cancelled — never because a timer fired._

**Status:** phases 1, 2, 3 and 5 landed; phase 4 outstanding · **Updated:**
2026-07-29

---

## Why

`packages/runner/src/builtins/llm-dialog.ts` carried two wall-clock deadlines,
and they were not the same kind of thing.

`TOOL_CALL_TIMEOUT` (120 seconds) raced every tool call. A tool that had not
produced a result by then was abandoned, and the model was handed
`{ type: "error-text", value: "Tool call timed out" }` in place of the tool's
output. It bounded how long a **local computation** may take, which is a
question the runtime can answer exactly. This document is about removing it, and
it is now gone.

`REQUEST_TIMEOUT` (5 minutes) bounds how long to keep believing a **different
replica** is still working on a dialog. That is failure detection, it cannot be
made exact, and it stays — see
[phase 4](#phase-4--narrow-the-message-drop-heuristic-which-cannot-be-removed).
Do not delete it on the strength of the argument for the first.

`TOOL_CALL_TIMEOUT` was the shape `AGENTS.md` rules out: a bound on how long
success may take. By the test in
[`waiting-in-tests.md`](../waiting-in-tests.md#wall-clock-time-is-not-a-measure-of-progress)
— "is firing early safe?" — it is not. Firing early discards a real result and
misreports it to the model as a failure.

It was not there out of carelessness. Before it existed the code was a bare
`await` on the tool's result cell, and a userland pattern that never writes a
result hangs that await forever. The deadline stood in for a completion signal
the runtime could not produce, and for a cancellation path that did not reach
tool calls. Both turned out to be buildable, and the phases below build them.

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

## Phase 2 — make cancellation reach tool calls (landed)

Ordered before the barrier deliberately: it fixes a live bug on its own, and it
is what makes removing the deadline safe rather than merely correct.

A reactive action already aborts a turn when the durable `pending` cell goes
false or a newer request supersedes it, and `cancelGeneration` sets `pending`
false so the effect reaches every replica. That trigger side is event-driven
already.

The consumption side was narrow. `abortSignal` reached exactly one consumer, the
model call, and `executeToolCalls` took no signal at all. **So cancelling a turn
that was inside a tool call stopped nothing.** The tool call ran to its deadline,
and the `requestId` guard then discarded the writeback — the effect was
suppressed, the work never was.

Two changes:

- Thread the turn's `abortSignal` into `executeToolCalls`/`executeToolCall`, and
  race the tool wait against it. Structurally the same race as today, against an
  event rather than a clock.
- Stop the child run on abort. Racing alone only stops *waiting*; the child
  pattern keeps computing and keeps its own model calls in flight.
  `Runner.stop(resultCell)` takes exactly the cell the tool call created.

## Phase 3 — a barrier scoped to one pattern run (landed)

**The blocker was not the one this document first assumed.** The attribution
mechanism works and is cheap. What did not hold was the premise underneath it:
that the async builtins registered their work at all.

An instrumented run that logged every `trackAsyncWork` call while driving the
dynamic-schema subagent tests recorded four registrations across the whole file,
all of them commit promises from `finalizeReactiveActionCommit`
(`scheduler/run.ts`), with no owner. `generateObject` registered nothing. So a
barrier scoped by owner saw an empty set for those runs and reported quiescence
immediately, and the tool call read a result cell that nothing had written yet.
Wired up before that was fixed, it turned a passing subagent case red by handing
the model an empty tool result.

That failure mode is worse than the deadline it replaces. A deadline that fires
early reports a failure; a barrier that returns early reports a *success* with
missing data, and does it silently.

**What the audit found.** Re-running the instrumentation confirmed the count
exactly: four commit promises, nothing from `generateObject`. Both of its paths
built a promise spanning the model call and the writeback and then attached only
a `.catch()` to it, so neither ever reached the registry. The direct path needed
more than an added call, because its writeback hangs off a `.then()` on the
request promise — the chain rather than the request is what spans the operation.
Every other async builtin already registered: `llm`, `generateText` and
`llmDialog` register their request chain; `fetch` and `fetchProgram` register
their claim-and-fetch promise; `navigateTo` registers its callback. Two builtins
enqueue post-commit effects and deliberately do not register, both for good
reasons: the sqlite query awaits its RPC and writeback inside the flush, so the
transaction's own commit promise spans them, and `streamData` is an open-ended
subscription whose read loop has no completion for a barrier to wait for.

**The tripwire.** `packages/runner/test/async-work-registration.test.ts` guards
the registry in two halves. Each async builtin runs there with its response held
open by the mock gate; both barriers must stay open while it is held, and a
barrier scoped to an unrelated cell must return, so the pair pins that the work
was registered and that it was attributed to its own run rather than to nobody.
A source scan in the same file fails when a builtin file grows a post-commit
side effect without registering async work, so a builtin added later has to
either register or record in the file's exemption list why it does not have to.
Both halves were checked against the defect: removing the `generateObject`
registrations turns the first half red, and dropping the owner turns all four
cases red.

`trackAsyncWork` gained an owner — the `parentCell` the builtin already has —
and `Runtime.settledFor(cell)` waits for scheduler quiescence including
in-flight commits, then for the tracked work owned by that cell, re-checking
until both hold.

The tool wait now races three event-driven outcomes: the result landing, the run
quiescing, and the turn being cancelled. A pattern that produced nothing resolves
via the second, with the cell still undefined — a determinate answer rather than
a guess. `TOOL_CALL_TIMEOUT` had nothing left to do and is gone.

`settledFor` uses `idleWithPendingCommits()` rather than plain `idle()`, because
a child's result writeback travels through a commit and the commit promise
registered by the scheduler carries no owner. It also waits for tracked work
with no owner, which the design as first written did not call for and which
turns out to be load-bearing. The scheduler registers the commit promise of any
commit carrying post-commit effects, and that promise is the handoff: it spans
the outbox flush inside which a builtin registers its own work. Without waiting
for it, a run-scoped barrier slips through the gap between the commit landing
and the flush starting, and finds an empty set — the same early return by a
different route.

It also carries no round cap, where `settled()` does. On a barrier a tool call
waits on, a cap is a bound on how much work a run may do before the barrier
reports it finished anyway — the same shape as the deadline being removed, with
the same failure. Each round awaits real promises, so a run that keeps working
keeps the barrier open rather than spinning. An unbounded loop needs a way to
stop, or a race the result wins leaves it re-checking with nobody waiting, so it
takes an optional signal that the tool call aborts as it leaves the race.

**The mocks could not tell an early return from a correct one.** Every mock in
the tool-calling tests answers within a microtask, so a child agent finishes
before its tool call looks at anything, and a tool call that stopped waiting
immediately would have passed all of them. `generate-object-tools.test.ts` now
holds a delegate's child answer open across the whole wait and checks that the
parent's next request carries the child's data rather than an empty result.

**A sharp edge worth knowing, unchanged by this work.** The result-landing
racer fires on the result cell becoming defined at all. A delegate pattern that
returns the whole builtin object rather than its `.result` has a cell that is
defined the instant the request starts, as `{ pending: true }`, so the tool call
resolves on that placeholder no matter what the barrier does.

**What still hangs, and why that is the right trade.** A userland pattern that
spins forever with nobody watching now leaves its turn pending indefinitely.
Before, that turn was abandoned after two minutes and the model was told the
tool failed. Removing the deadline trades "we misreport a healthy tool as failed
after two minutes" for "the turn stays pending until the work finishes or
someone cancels." The second is truthful, and phase 2 is what makes "someone
cancels" a real option. It is also more visible, which is a product consequence
worth stating rather than discovering.

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

## Phase 5 — retire the real-clock exemptions (landed)

With no deadline in the tool call, the three cases in
`generate-object-tools-dynamic-subagent.test.ts` and
`llm-dialog-dynamic-subagent.test.ts` had nothing the auto-advance pump could
fire early. They are folded back into `generate-object-tools.test.ts` and
`llm-dialog.test.ts`, both split files are deleted, both entries are gone from
the runner preload's `realClockFiles`, and the "dynamic-schema subagent shape"
section is gone from [`waiting-in-tests.md`](../waiting-in-tests.md). Only the
resume test is left on the list, and it is there for an unrelated reason.

Each case asserts on the delegate's own tool result, so this step proves itself:
all three pass under the fake clock, which they could not do if a deadline were
still firing.

## What this does not cover

`fetch-utils.ts` and `fetch-program.ts` carry their own deadlines. Those raise a
different question — what to do when a remote peer never answers — and are out
of scope here. That question is settled separately in [The Fetch Builtins'
Request Deadlines](../fetch-request-deadlines.md), which finds that neither
deadline bounds a request at all: each is a lease on a claim held in durable
state, and it decides when the replica holding that claim is presumed gone.
Like the heartbeat bound in phase 4, both stay, because nothing reports another
replica's presence. What changed there is the same narrowing phase 4 describes:
a replica no longer applies the bound to work it is running itself, and an early
fire no longer discards a result that arrived from elsewhere.
