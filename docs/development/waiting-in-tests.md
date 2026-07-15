# Test waits: prefer events over polling `waitFor`

A test wait should resolve on a real event, not a poll loop. This note explains
why, which primitives to reach for instead, the check that keeps new polling
`waitFor` out of the integration suites, and the specific places where a bounded
`waitFor` poll is still the right tool.

## Why avoid `waitFor`

`waitFor(predicate, { timeout, delay })` (in `packages/integration/utils.ts`)
re-runs `predicate` every `delay` milliseconds (50 by default) and throws once
`timeout` (60 seconds by default) elapses. In a browser test each tick is also a
DevTools Protocol round-trip. Two problems follow. The timeout puts a ceiling on
success: anything slower than the timeout can never be observed, even when it
would have completed. The fixed delay puts a floor on latency and, in
performance measurements, quantizes timings to the poll interval.

Reach for a poll only for the cases catalogued under [Where a bounded poll is
the right tool](#where-a-bounded-poll-is-the-right-tool). Everywhere else, wait
on an event.

## The primitives to use instead

Waits split into two groups with different primitives.

**Browser integration tests** have a page to attach an in-page waiter to:

- `waitForCondition(page, predicate, { timeout, args })` installs a single
  waiter inside the page. A shared MutationObserver hub watches the document and
  every shadow root — including shadow roots created after the wait began — and
  re-evaluates the predicate the instant the DOM reflects new state, then signals
  the test process over a protocol binding. The `timeout` argument is a genuine
  stuck-condition safety net, not a poll interval; a coarse 500-millisecond
  in-page backstop covers conditions that flip with no DOM mutation (for example
  a runtime global being set). The predicate is serialized and runs in the page,
  so it closes over nothing from the test module — inline any collection it
  needs, and pass values in through `args`.
- `awaitViewSettled(page)` resolves once the worker has settled reactively, the
  resulting vdom batch has crossed to the main thread and been applied, and Lit
  has finished its update cycle. This is the "is the control interactive yet"
  signal.
- The higher-level wrappers in
  `packages/patterns/integration/cfc-browser-helpers.ts` — `waitForText`,
  `waitForTextAbsent`, `fillCfInput`, `clickCfButton`,
  `clickCfButtonAndWaitForText`, `waitForRuntimeIdle`, `waitForRuntimeSynced` —
  bundle "settle the view, act once, wait for the effect" on top of the two
  primitives above.

To click a control that appears asynchronously, follow the `clickCfButton`
shape rather than a find-and-click retry loop: a `waitForCondition` predicate
waits until a matching, rendered control is present and tags its click target,
then the test dispatches a single trusted click on that element. Require the
target to be rendered — laid out, and not `display:none` or `visibility:hidden`
— so a control still inside a collapsed menu is skipped until it becomes
clickable rather than tagged while it has no layout box and then failing to
click.

**Non-browser and off-page waits** have no page to observe. Resolve a `defer()`
(from `packages/utils/src/defer.ts`) inside a callback the test already registers
— a cell `sink`/`subscribe`, a storage subscription's `next`, a scheduler
`onError`, a telemetry listener, or a counter incremented inside a test-owned
transport. A read of a cell that a sink already observes belongs here too: record
the latest value in the sink callback and resolve the waiter when it reaches the
target. Because the sink fires once on registration and then on every committed
change, the waiter can resolve immediately when the value is already there and
otherwise on the next change the sink reports.

## Guard against new usage

A check prevents new integration tests from importing the polling `waitFor`.
`tasks/check-no-waitfor.ts` scans the `.ts` files under any `integration/`
directory beneath `packages/` (excluding the `@commonfabric/integration` package,
which defines `waitFor`) and fails when one names `waitFor` in an import from
`@commonfabric/integration` and is not on the check's allowlist. Run it with
`deno task check-no-waitfor`; the CI "Check" job runs it on every pull request.
The error names the offending file and points at `waitForCondition`,
`awaitViewSettled`, the in-process `defer()` replacement, and this report.

The allowlist inside `tasks/check-no-waitfor.ts` covers only the exceptions the
check can see: the integration-test files that import the shared `waitFor` from
`@commonfabric/integration`. That is a subset of the exceptions listed below.
The others fall outside the scan and are not on the allowlist — the in-process
`test/` files that each define their own local `waitFor` poll loop (the check
never reads a named import there), the `MultiRuntimeHarness.waitFor` method and
its callers (a different `waitFor`), `packages/runner/integration/sqlite-cfc-commit-eval.test.ts`
(which waits through a local helper rather than the shared import), and
`packages/integration/shell-utils.ts` (inside the excluded package that defines
`waitFor`). Do not add those to the allowlist: the check never scans them, so the
stale-entry test would reject the entry.

For the in-scope entries, the check's own tests assert that the allowlist and the
set of integration-test files still importing the shared `waitFor` stay in step:
a new offender fails the check, and an allowlisted file that later drops `waitFor`
fails the tests until its entry is removed. When a new in-scope usage is genuinely
one of the exception shapes below, add the file to the allowlist with a one-line
reason and record it here.

## Where a bounded poll is the right tool

For these a bounded `waitFor` poll is the honest observation; replacing it would
add coupling or complexity rather than remove flakiness. They are grouped by the
reason a poll fits.

### No page, and no callback to hang a promise on

These observe in-process state that becomes true as a side effect, with no event
boundary the test can await without adding one to production code.

- `packages/runtime-client/integration/client.test.ts` — the `MockDoc`'s
  rendered `innerHTML` waits. The worker's render pipeline applies the HTML with
  no completion callback the test can hook, and a fresh `cell.sync()` round-trip
  has no registered subscription. There is no event boundary to resolve a
  deferred from without adding a render hook to the mock purely for the test.
- `packages/generated-patterns/integration/pattern-harness.ts` pulls a runtime
  `Cell` value and compares it, headless. No page; polling the pull until it
  converges is the honest wait.
- `packages/shell/integration/piece.test.ts` — the one poll that reads a freshly
  reloaded piece (`cc.get(pieceId, true)`) has no registered sink, so it stays a
  bounded poll on its own sync round trip. The other result-cell reads in this
  file, and every such read in `counter.test.ts` and `nested-counter.test.ts`,
  resolve a `defer()` from the existing `resultCell.sink(...)`.

### Race, backpressure, and convergence tests

Here the poll measures eventual convergence across timing the test does not
control, and there is no single "it converged" promise to await.

- `packages/runner/test/scheduler-commit-backpressure.test.ts` — the committed
  total or list lands only after the runtime works through several
  backoff-delayed retry attempts, each parked on a real timer. `runtime.idle()`
  returns between retries, so it does not span the wait.
- `packages/runner/test/memory-v2-pull-reactivity.test.ts` — waits on
  `runtime.scheduler.isDirty(action)`, which reads membership in the scheduler's
  internal dirty set. Nothing fires when one specific action flips to dirty;
  de-polling would mean adding a scheduler hook purely for the test.
- `packages/runner/test/effect-conflict-recovery.test.ts` — recovery after a
  cross-replica conflict is driven autonomously by the runtime's catch-up
  re-queue, and one case deliberately disables the reader-dirty fast path so only
  the timing-sensitive re-queue can recover. The automatic re-run is the behavior
  under test; there is by construction no event to await.
- `packages/runner/test/memory-v2-reconnect-race.test.ts` and
  `packages/memory/test/v2-restore-flush-test.ts` — the waits that watch for a
  deliberate mid-flight sabotage or a restore replay to reach a specific in-flight
  point. These are race checkpoints the surrounding interleaving depends on;
  bounded polling expresses "wait until the sabotage/replay happened" without
  coupling test control to the race window.
- `packages/runner/integration/sqlite-cfc-commit-eval.test.ts` — the predicates
  read derived pattern result cells that settle only after a full server round
  trip (handler send, scheduler run, server commit, server-side re-derivation,
  re-query). The helper already drains with `runtime.idle()` and
  `storageManager.synced()` each iteration; the poll observes eventual
  convergence of that multi-stage evaluation.
- The frontier-cardinality waits in `memory-v2-subscription.test.ts`,
  `memory-v2-pull-reactivity.test.ts`, and `memory-v2-reconnect-race.test.ts`
  ("all N reachable ids present") are soft: event-driven only via a counting
  `defer()` over several integrate batches, which is a poll wearing a callback.
  They stay bounded convergence checks.

### A different `waitFor`

`packages/patterns/integration/cfc-group-chat-demo-multi-runtime.test.ts` and
`packages/patterns/integration/sqlite-read-clearance-multi-runtime.test.ts` call
`MultiRuntimeHarness.waitFor` (defined in
`packages/patterns/integration/multi-runtime-harness.ts`), a different method
that settles several in-process Deno-worker runtimes and reads durable cells
across them. It is not the `@commonfabric/integration` `waitFor`, has no page,
and its cross-runtime convergence poll is the honest mechanism.

### Cross-page joint condition

`packages/patterns/integration/lunch-poll-vote.test.ts` waits on a condition
joined across two different browser pages (both must show both voters).
`waitForCondition` installs its waiter in one page and resolves on that page's
binding, so it cannot express a two-page condition; the cross-browser
propagation wait stays a poll.

### Instrumentation and profiling one-shots

In `packages/patterns/integration/default-app.test.ts` and
`packages/patterns/integration/reload/default-app-notebook.test.ts`, a number of
`waitFor` calls wrap one-shot instrumentation (arm a trace, reset a logger,
install a telemetry handler) that returns false only until a runtime API is
present. These observe runtime API readiness, not a UI condition, and are
env-gated profiling scaffolding rather than assertions. If converted, await a
runtime-ready signal directly rather than installing a DOM waiter.

`packages/patterns/integration/server-execution-measurement.ts` fences a
profiling sample on two cross-process snapshot APIs: Toolshed server-health
counters and browser runtime routing diagnostics. Neither API publishes a
completion notification to the test process, and a DOM mutation does not imply
that either snapshot changed, so a bounded poll is the honest readiness and
drain check. The workload itself still uses the browser runtime's deterministic
settling barriers; this exception covers only starting and finishing the
instrumentation window.

### A shared state primitive

`packages/integration/shell-utils.ts`'s `waitForState` compares the shell's
serialized `AppState` (view plus identity DID), read through
`globalThis.app.serialize()`. That is application state, not the DOM, and this is
the shared primitive many suites build on. `waitForCondition`'s probe cannot see
app state, so converting it would mean re-implementing view/identity comparison
inside an in-page predicate for no reduction in flakiness.

### Disabled tests

`cf-code-editor.test.disabled.ts`, `cf-render.test.disabled.ts`, and
`cf-checkbox.test.disabled.ts` hold many `waitFor` calls but never run. Leave
them until they are re-enabled.

## Production reconnect backoff

The "wait on an event, not a poll" principle applies to production code too, and
one loop that looks like a violation is a deliberate exception:
`MemoryClient.reconnect()` in `packages/memory/v2/client.ts`. When the websocket
to the memory server drops, the client loops — it re-runs the `hello` handshake,
re-opens every mounted space's session, and, when an attempt fails, waits a
short, growing delay before trying again. That inter-attempt delay is the
exception.

The connection attempt itself is event-driven. `hello()` calls
`transport.send()`, which opens the websocket. The websocket transport
(`WebSocketTransport` in `packages/runner/src/storage/v2-remote-session.ts`)
resolves the open on the real `open` event and rejects it on the real `error` or
`close` event. The client never polls to discover whether a connection attempt
has succeeded; it awaits the transport event. On the success path there is no
timer standing in for a missing event.

The delay is only the pause between one failed attempt and the next, and that
pause cannot be replaced by awaiting an event, because there is no event to
await. A server that is down or restarting is, from the client's point of view,
just a host that refuses the connection. When the host refuses, the websocket
`error` event fires almost immediately, and nothing tells the client when the
server has come back — the only way to find out is to try again. Without a delay
between attempts the loop would open a socket, receive an instant error, and open
another as fast as the event loop allows, a busy loop hammering the host. The
growing backoff — 25 milliseconds doubling to a 30-second cap, with up to 20
percent jitter — is the honest way to keep checking whether the server is back
without flooding it. It is the same shape as the committed-write backoff in
`committed-write-backpressure.md`, where a capped exponential backoff also stands
in for a retry that has no event to wait on.

Cancelling an in-progress backoff stays event-driven: the pause between attempts
is a single timer that `close()` cancels directly, so a client closed mid-backoff
settles at once and nothing wakes on an interval. The backoff delay between
attempts stays; its cancellation carries no poll.
