# Retiring the LLM Tool-Call Deadline

_Replacing the wall-clock deadline on LLM tool calls with a quiescence barrier
scoped to a single pattern run, so a tool call ends because the work finished or
because it was cancelled — never because a timer fired._

**Status:** proposed · **Updated:** 2026-07-29

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

## Phase 4 — narrow the message-drop heuristic, which cannot be removed (landed)

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

The bound stays, and the set of turns it is asked about got smaller. When *this*
replica holds the turn no detection is needed — it knows. Phase 1 made the turn
a single promise spanning the whole conversation, and `llmDialog` now keeps the
request id of the turn it is running in a closure variable,
`localTurnRequestId`. It is set alongside the `trackAsyncWork` registration and
cleared in a `finally` on the same promise, so its lifetime is exactly the
turn's, and `startRequest` is an `async function`, so it cannot throw before the
`finally` is attached. Setting the variable in the `addMessage` handler instead
would leak it whenever the post-commit callback returns early and creates no
promise for the `finally` to hang on — not in the supersede case that check is
named for, where the next handler has already overwritten the variable with its
own id, but when the reactive action has set `requestId` to `undefined` because
`pending` went false in between. A superseded turn can also settle after a newer
one has claimed the variable, so the clear only fires for the turn that still
holds it.

`addMessage` reads the durable `requestId` alongside `pending`. A pending turn
whose id is the one this replica is running is dropped outright; only a turn with
some other id reaches the heartbeat read. Comparing against the durable id rather
than the closure's own `requestId` matters: the reactive action clears
`requestId` as soon as `pending` goes false, while the local turn is still
winding down, and the durable id changes exactly when a different turn becomes
the canonical one.

That fixes the live bug the heuristic had: a turn running longer than five
minutes without a durable write stops refreshing the heartbeat, so the replica
running it used to accept a new message and start a second request **against
itself**. The durable writes bracket a round of tool calls rather than falling
between them, so the gaps that can reach five minutes are a single model call
that runs that long, and a round of several tool calls, which `executeToolCalls`
runs one after another before writing their results. Once phase 3 retires
`TOOL_CALL_TIMEOUT`, a single tool call can reach it too.

`packages/runner/test/llm-dialog-message-drop.test.ts` covers four cases. The
second is the fix: a turn held open at `setMockResponseGate` while `clock.tick`
moves logical time past the bound, after which a second message must reach
neither the conversation nor the model. It counts requests at the mock gate, and
against the previous code that count is two — the replica racing itself, which
is the bug stated as an observation. The first is the everyday case the block
existed for before any of this, a local turn young enough that the heartbeat
would have caught it too; it passes either way today and is what a later
refactor of the block would break silently.

The last two hold the heartbeat where it still belongs, by putting `pending`
back to true with no local turn running: within the bound the message is
dropped, past it the message is taken. They are not a symmetric pair. The
within-the-bound case is what proves the `pending` write reaches the dialog's own
durable cell, since a dialog reading `pending` as false would have taken the
message; the past-the-bound case rests on that and also guards the `finally`,
failing if the clear is removed.

**What the local branch gives up: nothing bounds a turn on it.** The old bound
fired on a local turn whether that turn was healthy and long or genuinely stuck,
and firing was the automatic repair for the stuck case — it aborted the wedged
turn and started a fresh one. `startRequest` has waits that can hang with no
abort coverage: `inputs.pull()` and the pinned-cell pulls at its head, a queue
held by an earlier item, and the model call's own `fetch` and stream read, which
carry no read deadline. A turn stuck in one of those now drops messages for as
long as the tab lives.

Taken deliberately, on two grounds. The repair was a guess, and it fired wrongly
on exactly the case this phase is about, so keeping it means keeping the bug. And
the determinate replacement is already present and already works: `pending`
staying true is what makes `cf-prompt-input` show a stop button in place of send,
`cancelGeneration` sets `pending` false, and the abort that follows reaches a
running tool call rather than only the model call — `executeToolCall` races the
signal and stops the child run. In the shipped chat UI a user
cannot send into a pending dialog at all — the component blocks submit while
`pending` holds — so the drop guard is a backstop for programmatic senders and
for UIs that do not gate on `pending`, not the thing standing between a user and
their message.

The place a hung network call should be detected is the LLM client, where the
information is, rather than a message-drop heuristic several layers above it.
`packages/llm/src/client.ts` passes an abort signal to `fetch` and then reads the
response stream in a loop with nothing watching for a peer that accepts the
connection and then stops sending. That is the same shape as the deadlines in
`fetch-utils.ts` noted below, and it belongs with them.

**Refreshing the heartbeat on a schedule was considered and rejected.** It would
close the remaining false positive, where a peer running a long turn looks gone
to everyone else, and would let the bound come down. It needs a repeating timer,
and it would put durable writes on a fixed interval from every replica running a
turn. Under the runner's fake clock the cost is concrete rather than stylistic:
a `setInterval` armed from `src/` is classified as a runtime timer, so the
auto-advance pump would re-arm and fire it for as long as any dialog turn is
open, moving logical time in tests that model no elapsed time at all. That is
what carries the decision — a periodic heartbeat is not a timeout, a retry loop,
or a sleep, so the rule in `AGENTS.md` does not reach it by name. The remaining
false positive costs a wasted model call and no corrupted state, which is a
smaller price.

An event-driven refresh is available and narrower: `startRequest` passes
`() => {}` as the streaming callback, under a standing `TODO(bf)`, and that
callback fires on every text delta. Refreshing `lastActivity` from it would keep
a long *model call* looking alive to peers with no timer at all. It does nothing
for a long round of tool calls, which produce no deltas, so it narrows the
remaining false positive rather than closing it, and it is worth taking on its
own terms rather than as part of this.

The surviving `Date.now()` read carries a comment naming that same fake-clock
hazard: auto-advance can carry logical time past five minutes in a test that
never meant to model elapsed time, and the branch it then takes is the one that
accepts a message into a dialog whose turn is still running.

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
