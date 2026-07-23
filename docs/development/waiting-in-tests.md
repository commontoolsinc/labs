# Test waits: prefer events over polling `waitFor`

A test wait should resolve on a real event, not a poll loop or a fixed delay.
This note explains why, which primitives to reach for instead, how to wait on
the two pieces of machinery whose timing is easy to guess wrong, the check that
keeps new polling `waitFor` out of the integration suites, and the specific
places where a bounded `waitFor` poll is still the right tool.

The same principle applies to production code, and the last two sections cover
it there: [Production reconnect backoff](#production-reconnect-backoff), a
deliberate exception because nothing announces that a downed server is back, and
[The FUSE mount handshake](#the-fuse-mount-handshake), a cross-process readiness
signal carried by a pipe.

## Why avoid `waitFor`

`waitFor(predicate, { timeout, delay })` (in `packages/integration/utils.ts`)
re-runs `predicate` every `delay` milliseconds (50 by default) and throws once
`timeout` (60 seconds by default) elapses. In a browser test each tick is also a
DevTools Protocol round-trip. Two problems follow. The timeout puts a ceiling on
success: anything slower than the timeout can never be observed, even when it
would have completed. The fixed delay puts a floor on latency and, in
performance measurements, quantizes timings to the poll interval.

Reach for a poll only for the cases catalogued under [Where the polling
`waitFor` stays](#where-the-polling-waitfor-stays). Everywhere else, wait on an
event.

## Wall-clock time is not a measure of progress

The ceiling above assumes the bound is exceeded because the work was slow. There
is a worse way to exceed it: the clock jumps forward while the work made no
progress and nothing was wrong.

A timeout counts wall-clock time, and wall-clock time diverges from real progress
whenever the world outside the process pauses. A laptop is closed and reopened. A
CI virtual machine is paused for an hour of host maintenance, or is live-migrated
to another host, and resumes where it left off. A container is frozen by the
cgroup freezer or a checkpoint. The clock is stepped by NTP. Each of these
advances wall time — sometimes by a large, arbitrary amount — while the timed
operation did not run at all, so a timeout fires on it exactly as it would on a
genuine hang. It cannot tell "stuck" from "everyone was stopped."

This is a stronger objection than "the machine might be slow, so pad the bound."
Slowness you can pad against; a clock discontinuity you cannot, because no fixed
bound survives an arbitrary jump — a suspend one second past the deadline trips a
fifteen-second bound as surely as a one-second one. A bound sized "comfortably
above how long the operation ever takes" is therefore safe against slowness only,
not against this. The exposure also turns on details you do not control: GNU
`timeout` arms a `CLOCK_REALTIME` timer, which counts suspend time, so the bound
fires on resume; a `CLOCK_MONOTONIC` bound would survive a suspend-to-RAM but not
a frozen process whose system clock kept running. No clock is safe against every
kind of pause.

So a bounded timeout is never a guarantee, only a heuristic with a real
false-positive mode, and the test for whether one is acceptable is not "is the
bound comfortably large" but "is firing early safe." Does the code still reach a
correct outcome when the bound trips on a healthy operation? A bound whose early
fire only repeats cleanup work is tolerable. A bound whose early fire fails a
passing test, drops a real result, or corrupts state is not — and wanting one
there is the signal to make the wait event-driven instead.

Those two kinds map onto the rest of this note. The shutdown escalation in the
mount handshake keeps a bound whose early fire is harmless — it `SIGKILL`s a
child that was already exiting, reaching the same end either way. The rest — the
polling waits under [Where the polling `waitFor`
stays](#where-the-polling-waitfor-stays) and the FUSE cleanup's teardown bound —
keep a bound whose early fire fails the run. They exist because no event reports
the condition they wait on, so a large-enough clock jump can trip one on a
healthy run and fail it. That is a fragility we accept for want of an
alternative, sized so only a multi-minute jump reaches it — not one we have
designed away. The deno-web-test per-test stuck detector
([below](#browser-hosted-unit-tests-have-a-harness-backstop)) is another bound of
this kind, and the most exposed: a competing ceiling keeps it from being sized
that high, as its own section explains. When an event boundary does exist, use
it, and neither kind of exception arises.

## The primitives to use instead

Waits split into two groups with different primitives.

**Browser integration tests** have a page to attach an in-page waiter to:

- `waitForCondition(page, predicate, { args })` installs a single waiter inside
  the page. A shared MutationObserver hub watches the document and every shadow
  root — including shadow roots created after the wait began — and re-evaluates
  the predicate the instant the DOM reflects new state, then signals the test
  process over a protocol binding. It takes no caller-supplied timeout: a
  built-in five-minute stuck-condition safety net bounds a condition that never
  holds, and a coarse 500-millisecond in-page backstop covers conditions that
  flip with no DOM mutation (for example a runtime global being set). The
  predicate is serialized and runs in the page, so it closes over nothing from
  the test module — inline any collection it needs, and pass values in through
  `args`.
- `awaitViewSettled(page)` resolves once the worker has settled reactively, the
  resulting vdom batch has crossed to the main thread and been applied, and Lit
  has finished its update cycle. This is the "is the control interactive yet"
  signal.
- The higher-level wrappers in
  `packages/patterns/integration/cfc-browser-helpers.ts` — `waitForText`,
  `waitForTextAbsent`, `fillCfInput`, `clickCfButton`, `clickNthCfButton`,
  `clickCfButtonAndWaitForText`, `waitForRuntimeIdle`, `waitForRuntimeSynced` —
  bundle "settle the view, act once, wait for the effect" on top of the two
  primitives above. `clickCfButton` takes the first match and reaches through a
  host's shadow root for its inner `[data-cf-button]`; `clickNthCfButton` takes
  the `index`-th match of a selector that already resolves to the buttons
  themselves.

To click a control that appears asynchronously, follow the `clickCfButton`
shape rather than a find-and-click retry loop: a `waitForCondition` predicate
waits until a matching, rendered control is present and tags its click target,
then the test dispatches a single trusted click on that element. Require the
target to be rendered — laid out, and not `display:none` or `visibility:hidden`
— so a control still inside a collapsed menu is skipped until it becomes
clickable rather than tagged while it has no layout box and then failing to
click.

Ask `probe.isRendered` for that check rather than hand-rolling it, and note that
it is deliberately not `probe.isVisible`, which additionally requires the
element to be on-screen. A click scrolls its element into view before it
dispatches, so where the element sits at tagging time does not decide whether
the click lands. Requiring it on-screen only adds ways to wait forever: the
shell sets `html { scroll-behavior: smooth }`, so a `scrollIntoView()` a
predicate issues animates over several hundred milliseconds, and a viewport
check within the same predicate reads a position the scroll has not reached yet.

Check the element the click is dispatched on, not the host that matched the
selector. Hiding the host or any ancestor reaches the inner control either way:
`display:none` zeroes the control's layout box, and `visibility:hidden` inherits
into its computed visibility. So the click target's own check covers the whole
chain, and checking the host as well buys nothing.

Being rendered is a question about whether a click can be delivered, which is
why it belongs in the predicate that tags the control. Whether the control is
`disabled` is a separate question — a disabled control still takes the click and
declines it. A test that needs a control enabled before clicking says so with
`waitForDisabled(page, selector, false)`.

**Non-browser and off-page waits** have no page to observe. Resolve a `defer()`
(from `packages/utils/src/defer.ts`) inside a callback the test already registers
— a cell `sink`/`subscribe`, a storage subscription's `next`, a scheduler
`onError`, a telemetry listener, or a counter incremented inside a test-owned
transport. A read of a cell that a sink already observes belongs here too: the
sink wakes the waiter, and the waiter compares the cell against the target.
Because the sink fires once on registration and then on every committed change,
the waiter can resolve immediately when the value is already there and otherwise
on the next change the sink reports.

That last shape is packaged as `waitForCellValue` in
`@commonfabric/integration/wait-for-cell-value`, usable from any package's
tests. It sleeps on the sink and applies its predicate to the cell only after
`runtime.idle()`, so the wait has neither a poll interval under it nor an
iteration cap over it. Its predicate takes `T | undefined`, since a cell holds
no value until its piece writes one.

The runner's llm tests wait on that shape often enough to have a name for it.
`waitForLlmSettled`, in `packages/runner/test/support/llm-result.ts`, resolves
once `llm`, `generateText` or `generateObject` has finished a request. It is a
call to `waitForCellValue` carrying the predicate those builtins settle on,
`pending === false`, and it holds no wait machinery of its own. Reach for it
rather than re-deriving that predicate: reading at quiescence is what makes it
honest, and the helper's comment records why.

Some traps are worth knowing before you hand-roll one of these against a
runtime. They cost real debugging to find, and they are why the helper takes a
runtime.

Where a runtime is in reach, test the value the cell holds once the scheduler
is quiescent, not the one the sink handed the callback. A cell passes through
states that exist only until the scheduler drains, and a predicate can accept
one that is about to be superseded — a query that has not yet re-run against
new inputs still holds its previous settled result, so "settled and without
error" matches the stale value. Waking on the sink but reading after
`runtime.idle()` keeps those states away from the predicate. The waits above
that have no runtime to idle, such as the shell's result-cell reads, do compare
the callback's value, and have to keep their predicates specific enough that no
passing state is a stale one.

A cell's value is a live view either way, so whatever a wait returns can still
move afterwards, and a test that accepts a value and then awaits something else
before reading it can assert against a state the predicate never approved.
Reading at quiescence narrows that window rather than closing it: there is no
pending reactive work left to drive the value on, but `runtime.idle()` settles
reactivity only, not storage sync, so a value arriving from another runtime can
still land late. Read what a wait hands back before awaiting anything else.

Cancelling the sink is a trap of its own. Resolving from inside the callback
wakes the waiting code while the action that reported the value is still
finishing, and finalizing an action resubscribes it, so a cancel issued from
that continuation is undone and the sink goes on firing afterwards. Await
`runtime.idle()` before cancelling.

An in-process wait like this needs no timeout backstop. When the value never
arrives and the runtime goes quiet, Deno's test runner reports `Promise
resolution is still pending but the event loop has already resolved` and fails
the test at once, rather than hanging. The message names the test, not the wait
inside it, so a test holding several waits needs the last step printed without
an `ok` to place the failure. It still beats a deadline, which reports only that
time ran out, and reports it later.

That argument covers the in-process waits in this section and nothing else. It
holds because nothing in these tests keeps the event loop alive by itself: the
runner's one repeating timer is unref'd and gated behind `CF_TRAVERSE_CAPTURE`,
and an unsatisfiable wait still fails in seconds in the heaviest setup we have,
two runtimes over an in-process memory server. It does not carry over to the
browser waits above, where a live DevTools Protocol connection holds the loop
open and a waiter that never fires would hang instead. A client talking to a
live server holds the loop open the same way. A wait against one runs to the
ambient test or CI limit rather than failing fast. The CLI suite's readiness
probe is such a client. It disposes its controller once the wait returns, which
also keeps a finished wait from holding the loop open for the rest of the
suite.

### Browser-hosted unit tests have a harness backstop

That fail-fast is Deno's, and the browser-hosted unit tests that
`packages/deno-web-test` runs do not get it — `iframe-sandbox`, `identity`,
`static`, and the `ui` browser tests. Their waits are the
`defer()`-from-a-callback shape described above, but they run inside a page,
whose event loop the page itself holds open, so a wait that never resolves hangs
rather than failing.

One bound at the harness level covers them. `deno-web-test` stops waiting on a
test after `testTimeout` — 40 seconds by default, set per suite in
`deno-web-test.config.ts` — and fails that test with a message naming it and
saying how long it waited, leaving the rest of the run to report as usual.
Without it a stuck test ran until astral's retried deadline on `page.evaluate`
ran out of attempts, 53 to 57 seconds later, and threw a `RetryError` that named
no test, printed no summary, and abandoned every test file still queued.

This is the distinction `waitForCondition`'s `timeout` draws, one level up: a
stuck-condition safety net rather than a bound at the call site. It is why a
wait inside one of these tests still takes no timeout of its own — adding one
per call site would cap what each wait can observe, which is the thing being
avoided, while the harness bound only decides when to stop believing a test will
ever finish.

By the test in [Wall-clock time is not a measure of
progress](#wall-clock-time-is-not-a-measure-of-progress), its early fire is not
safe: it fails a passing test. So it is a bound kept for want of an alternative,
alongside the polling waits and the FUSE teardown bound — there is no event for
"this test will never finish." It is the worst-placed member of that group, and
the reason is worth stating plainly. Those other bounds sit so far above their
work that only a multi-minute clock jump reaches them. This one cannot: astral's
own deadline runs out around fifty seconds and takes the run down unnamed, so
the bound has to fire below that, and a clock jump between the bound and fifty
seconds fails a healthy test. Astral's retry would have ridden that jump out — it
re-wraps the same evaluate across five attempts, so a test that finishes late is
still returned — where this single timer does not. The bound is kept only
because astral's un-named, whole-run failure is the worse outcome on a genuine
hang, not because it escapes the clock-jump fault.

That trade is what sets the default, and it sets it high rather than low. The
window in which this bound fires but astral would not is exactly the gap between
the bound and astral's floor, so the bound wants to sit as close under that
floor as reliable naming allows — the opposite of the "leave a wide margin"
instinct, which here only widens the exposure. Astral's floor is a hard fifty
seconds, five ten-second timers that no machine runs through faster, so forty
seconds clears it with room for the retry's backoff on top while keeping the
clock-jump window down to about ten seconds. The slowest healthy test in any of
these suites is about a second, and that one is deliberately waiting out a timer,
so real work never approaches forty. A suite that somehow needs more should raise
`testTimeout`, and keep it under the fifty-second floor.

`packages/deno-web-test/README.md` records what the bound does not cover: a test
blocking the event loop outright, and the stuck test's own work, which goes on
running in the page afterwards.

## Waiting for the scheduler and for the worker reconciler

Two pieces of machinery come up often enough in unit tests, and dispatch
differently enough from each other, that guessing at their timing is where fixed
delays tend to creep back in.

The **scheduler** delivers a runtime-backed cell's updates through `queueTask`
(`packages/runner/src/scheduler/diagnostics.ts`), which is `setTimeout(fn, 0)`.
That is a macrotask, so yielding to the microtask queue never reaches a change
made through a real cell, however many times the test yields. Wait for these
with `runtime.idle()`, which resolves once the scheduler has settled.

The **worker reconciler** (`packages/html/src/worker/reconciler.ts`) is
synchronous apart from one line. It queues its VDOM ops as it renders and
flushes them from a `queueMicrotask` callback, which hands the batch to the
`onOps` callback the test registered. So once the change itself has landed, the
ops are one microtask away, and a microtask the test queues afterwards runs
after the flush, because microtasks run in the order they were queued.

The reconciler tests in `packages/html/test/` write plain `Deno.test` and wait
through `t.settle`, added to the test context by a preload:

```ts
// Shown for illustration only.
Deno.test("...", async (t) => {
  cell.set(next);
  await t.settle();
  assertEquals(collector.getOpsOfType("set-prop"), expected);
});
```

Nothing is imported. The package's test task runs `test/clock-preload.ts`
before the test modules (through Deno's `--preload`); it replaces `Deno.test`
so each test runs under a clock that freezes only positive-delay timers, and it
adds `settle` to the context. `test/clock.d.ts` gives `t.settle` its type, which
`deno check` sees because it type-checks the package directory as one program.

A zero-delay `setTimeout(fn, 0)` still fires, driven through the real event
loop, so the scheduler's dispatch, the reconciler's flush, and teardown all
resolve on their own. `t.settle` resolves once every zero-delay timer and
microtask has run to a fixpoint, so it covers both the mock-cell and
runtime-cell trees these tests mix, and needs no runtime argument.

`t.settle` is an ordering guarantee rather than a deadline, so it cannot lose a
race under load. It also holds for a test asserting that an op is *absent*: once
it returns, every op the change was going to produce has been delivered, so no
later batch can falsify the absence. Those tests pass vacuously when nothing has
flushed at all, so their teeth come from the wait being long enough to have seen
an unwanted op.

The frozen clock is what keeps a fixed delay from creeping back in. A
`setTimeout(resolve, 10)` sleep, in any spelling since they all bottom out in
the same timer, is a positive-delay timer, so it is never fired and the promise
it backs never resolves. A test that waits on one deadlocks, which the async-op
sanitizer reports at once rather than letting the sleep pass by luck. No test in
the package needs a real positive-delay timer; one that did would deadlock and
announce itself.

## Proving a negative

A test that asserts something never happens has no event of its own to wait for.
Waiting a fixed interval and then declaring success is the shape to avoid. It
puts a floor under what the test costs and a ceiling on what it can catch, since
whatever arrives after the interval is missed, and it reports the same pass
either way — the assertion never depends on the wait having been long enough.

Send something that must arrive after the thing being ruled out, wait for that,
then assert the thing never came. Any channel that preserves order carries this.
A `postMessage` between a fixed pair of windows does, and so does a chain of
them: `packages/iframe-sandbox/test/iframe-csp.test.ts` has each guest document
write a marker back to the host once its load event fires, and a CSP error from
the same guest travels the same two hops — guest to outer frame, outer frame to
host — so a test holding the marker holds any error that fired. The "subscribes"
and "cancels subscriptions between documents" tests in
`packages/iframe-sandbox/test/iframe.test.ts` use the same idea against the
update stream: write to a key that is still subscribed, and once the guest
reports it, an update for the unsubscribed key would already have arrived had
one been sent.

Two things decide whether this works, and both are worth checking rather than
assuming.

The barrier has to be genuinely ordered after the event, which is a claim about
the specific mechanism and not about elapsed time. The CSP suite is a good
illustration of how far that varies for one browser and one policy: a blocked
`<img>` or `<link rel=stylesheet>` reports its violation before the document's
load event, while a blocked `<script src>`, an image a stylesheet asks for, and a
`fetch()` all report theirs after it. A `fetch()` is the extreme — its violation
lands a macrotask turn after the request has already rejected, so no marker the
page can post is ordered after it. Where no such ordering exists, say so and
leave the case on its interval rather than inventing a barrier that only looks
like one; `unbarrierable` in that file records the cases that stay.

A barrier that is not really ordered after the event fails silently: the test
goes on passing while asserting nothing. Pair the conversion with a control — the
same fixture and the same wait against input that does trigger the event, which
must observe it by the time the barrier lands. `barrierControls` in the CSP suite
is that check. Moving its barrier earlier leaves every negative case green while
the controls that can speak to ordering go red, which is the point of having
them.

Which controls those are is worth working out rather than assuming, because a
control can be written so that it cannot fail. Only an event that can arrive
after the page's own scripts have run tests the ordering at all. Two of that
suite's eight controls are of that kind; the other six raise their error from a
synchronous throw while the document parses, which no barrier could be posted
before, so they stay green however early the barrier moves. They still earn
their place — they show the error channel is live for their fixture's shape —
but they are evidence of that and not of ordering. Sort them deliberately and
say which is which, or the group reads as proof it does not supply.

## Guard against new usage

A check prevents new integration tests from importing the polling `waitFor`.
`tasks/check-no-waitfor.ts` scans the `.ts` files under any `integration/`
directory beneath `packages/` (excluding the `@commonfabric/integration` package,
which defines `waitFor`) and fails when one takes `waitFor` as a value from an
import of that package and is not on the check's allowlist. Two spellings reach
it and both count: the bare `@commonfabric/integration` specifier, and a relative
path ending at the package's `utils.ts` or `index.ts`. Commenting the import out
clears the check, so it stays out of the way while a test is being migrated —
text inside a comment or a string is not an import. A type-only import, whether
`import type { waitFor }` or an inline `{ type waitFor }`, is erased before the
test runs and polls nothing, so it does not count either. Run it with
`deno task check-no-waitfor`;
the CI "Check" job runs it on every pull request. The error names the offending
file and points at `waitForCondition`, `awaitViewSettled`, the in-process
`defer()` replacement, and this report.

The check is a speed bump against reaching for `waitFor` out of habit, not a seal
against a determined evasion. It reads the import statement and nothing else, so
a namespace import — `import * as I from "@commonfabric/integration"` followed by
`I.waitFor(...)` — passes it. Every import of the package in the repository uses
the named form. Treat a green check as "no new polling `waitFor` was imported the
usual way", not as proof that a suite polls nowhere.

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

## Where the polling `waitFor` stays

These are grouped by the reason the poll stays, and the reasons are not equally
good. For most of them a bounded `waitFor` is the honest observation, and
replacing it would add coupling or complexity rather than remove flakiness. Two
groups are here on weaker grounds: files that nothing automated runs, where a
conversion would not pay for itself, and a few waits in files that CI does run
which are simply not converted yet. Those two say so where they appear; do not
read them as endorsements.

### No page, and no callback to hang a promise on

These observe in-process state that becomes true as a side effect, with no event
boundary the test can await without adding one to production code.

- `packages/runtime-client/integration/client.test.ts` — the `MockDoc`'s
  rendered `innerHTML` waits. The worker's render pipeline applies the HTML with
  no completion callback the test can hook, and a fresh `cell.sync()` round-trip
  has no registered subscription. There is no event boundary to resolve a
  deferred from without adding a render hook to the mock purely for the test.
- `packages/shell/integration/piece.test.ts` — the one poll that reads a freshly
  reloaded piece (`cc.get(pieceId, true)`) has no registered sink, so it stays a
  bounded poll on its own sync round trip. The other result-cell reads in this
  file wait through `waitForCellValue`, which sinks on the result cell and reads
  it at quiescence. The equivalent reads in `counter.test.ts` and
  `nested-counter.test.ts` resolve a `defer()` from an existing
  `resultCell.sink(...)`.

### A pull that drives its own loading

`packages/generated-patterns/integration/pattern-harness.ts` compares a runtime
`Cell` value, headless. There is no page to attach an in-page waiter to. A
callback does exist — the harness registers `result.sink(() => {})` to keep the
result reactive — but that callback is empty and records nothing, so today there
is no latest value for a waiter to resolve against. It also sits on the root
`result` cell, while each assertion walks a path of `key()` steps down to a
nested cell and waits on `targetCell.pull()`.

The pull is not purely an observation, which is what makes it hard to swap for a
sink. It awaits the scheduler, and when the read reached a link whose target this
replica had never loaded, it settles those loads and re-reads as each arrival
reveals the next hop, for a bounded number of rounds. A sink reports committed
changes; it does not drive that traversal. Polling the pull until it converges is
the honest wait.

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
- `packages/runner/test/memory-v2-stacked-commit.test.ts` — the wait for a
  conflict rejection to reach the runner, read as the `commit-conflict` logger
  count. `pushCommit`'s catch moves that count synchronously before it calls
  `finalizeRejection`, and the logger exposes counts through readers only, with
  no subscription, so nothing fires when one moves. The commit the test is
  watching must not settle — that is the assertion — so its own promise is not
  the signal either.
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

### Instrumentation one-shots

`packages/patterns/integration/default-app.test.ts` keeps `waitFor` for one-shot
instrumentation: arm a trace, reset a logger baseline. Each such call returns
false only until a runtime API is present, so it observes runtime API readiness
rather than a UI condition, and it is profiling scaffolding rather than an
assertion. Every one sits behind a `CF_CAPTURE_*` environment gate that defaults
to off, so a normal run never reaches them.

The notebook regression test in that same file resets the event-invocation trace
on every pass, and needs no wait for it. The reset returns false only until the
runtime exposes its telemetry methods, and the click that opened the note modal
settled the view, so those methods are already present; the reset is called once
and its success asserted. A wait on runtime-API readiness would have been no
better, because that condition flips with no DOM mutation behind it and would
fall back to the in-page waiter's coarse backstop for something already true.

### A shared state primitive

`packages/integration/shell-utils.ts`'s `waitForState` compares the shell's
serialized `AppState` (view plus identity DID), read through
`globalThis.app.serialize()`. A handful of test files call it directly, but
`ShellIntegration.goto()` also calls it internally after every navigation, so
every suite that navigates through the shell depends on it.

An in-page predicate could reach the state it reads: `globalThis.app` is a page
global, and a `waitForCondition` predicate runs in the page, so it could call
`serialize()` for itself. Two other things block the conversion.

First, the predicate is serialized into the page and closes over nothing from the
test module, so everything it needs has to be inlined. `waitForState` compares
views through `isAppViewEqual` from `@commonfabric/shell/shared`, and it compares
identities by DID — which the serialized state does not carry. `serialize()`
writes the identity out as a raw key pair, and `deserialize()` recovers the DID by
importing that private key through `Identity.fromRaw`. An in-page predicate can
import neither module, so converting means re-implementing both view equality and
private-key import inside the page, forking logic the shell relies on.

Second, an `AppState` transition does not reliably mutate the DOM, so the
MutationObserver hub would have nothing to pulse on and the wait would fall back
to the coarse 500-millisecond in-page backstop. That polls more slowly than the
50-millisecond loop it would replace.

### A human-in-the-loop flow that no CI lane runs

`packages/patterns/google/core/integration/google-calendar-importer.test.ts`
drives the Google OAuth consent flow end to end, and a person has to complete
that flow in a real browser. The test prints instructions to the console and then
allows two minutes for the account selection and the scope approval. It cannot
run unattended, and no CI lane runs it: the `patterns` package's `test` task
ignores `google/core/integration`, and its `integration` tasks run only the
`integration/` and `integration/reload/` directories. The check still sees the
file, because the scan walks every `integration/` directory beneath `packages/`,
so it needs an allowlist entry.

Its waits are ordinary DOM and text conditions that `waitForCondition` would
express. They stay a poll because nothing automated exercises this file, so
converting it churns code that no run covers.

### A shell script observing another process through a kernel mount

`packages/cli/integration/fuse-exec.sh` drives the FUSE daemon as a separate
process through a real mount, and observes it from bash. Its poll loops —
`wait_for_path`, `wait_for_json`, `resolve_entity_dir`, `wait_for_piece_value`,
`wait_for_trace_line` and `resolve_traced_write_fh` — stay polls.

There is no event channel to convert them to. The state each loop waits on lives
in another process: the daemon's tree for the path and JSON loops, the server's
cell for the value loop, and the daemon's log file for the two trace loops. Bash
has no callback to resolve a `defer()` from.

Watching the filesystem does not substitute for one. A mounted path appears
because the daemon added a node to its own tree, and that is not a filesystem
operation passing through the mount, which is what the kernel raises inotify
events for. The daemon's two notification calls, `notify_inval_entry` and
`notify_inval_inode`, tell the kernel to drop cache entries; they do not announce
new state to a watcher.

The two path loops also drive the work they wait for, which is the same shape as
the pattern harness's `pull()` above. The lookup behind a `test -e` is what makes
the daemon fetch: for the space root it runs `connectSpace`, and for the piece
paths beneath it `CellBridge.prepareLookup`, which hydrates the piece property.
Polling the probe until it converges is the honest wait.

Two waits in this script are not polls, and should not become polls.

Mount readiness needs no timing loop. `cf fuse mount --background` calls
`awaitBackgroundMountStartup`, which waits for the daemon to report the
`mounted` supervisor state and confirms both the supervisor and the child are
alive before the command prints the PID. Every other exit from that function
throws, and a throw kills the child and fails the command, so a script that has
parsed a PID has a daemon that reported mounted. That wait is itself
event-driven, carried by the pipe that [The FUSE mount
handshake](#the-fuse-mount-handshake) describes.

The daemon reports that state once its session loop is dispatched, so the mount
serves requests, but the paths under it still hydrate lazily and the documents at
those paths settle on a debounce after the path first answers a lookup. A path
existing is not the same as its content being final. Those gaps belong to
`wait_for_path` and `wait_for_json`, which poll a lookup and a rendered document
until each converges, each carrying its own timeout. What is left for the script
directly is one check that the daemon survived the handshake.

#### The stale-descriptor assertion reads the daemon's trace, not the cell

The stale-descriptor assertion — that truncating a path does not let an already
open descriptor write its old buffer back — asserts that something does not
happen. It needs no delay, but the reason is not the one an earlier version of
this document gave.

Both truncate paths — `open` with `O_TRUNC` on Linux, and the handle-less
`setattr` that FUSE-T issues on macOS — reach `handles.truncateByIno`, which
empties the buffer of every handle on the inode and clears `dirty` on all of
them, leaving `truncatePending` set only on the truncating handle.
`flushHandle`, `flushCb` and `releaseCb` all gate on `dirty || truncatePending`,
so a descriptor with both clear is inert. A descriptor that stayed armed instead
flushes from the callback the kernel sends on `close()`.

The cell value cannot carry that assertion, for two separate reasons.

The first is that the value cannot see the likeliest regression at all.
`truncateByIno` empties the buffer of every handle on the inode unconditionally
and gates only `truncatePending`, so a descriptor left armed holds an empty
buffer and flushes `""` — byte-identical to what the truncate wanted. Drop the
`{ pendingFh }` argument at any of the three call sites in `mod.ts` and every
handle arms; the descriptor then writes back on `close()`, and a check on the
settled value passes every single time. That regression also passes every test
in `handles.test.ts`, which calls `truncateByIno` directly and so never
exercises a call site — and which blesses the argument-less form besides.

The second applies when the buffer does survive to be written. The armed
descriptor's write and the truncate's write are then two fire-and-forget
optimistic transactions racing for the same cell: `PieceController.set` calls
`runtime.editWithRetry`, which applies the write to a transaction synchronously
and then commits asynchronously, and a commit that loses a conflict re-runs the
callback and re-applies its own value. The value settles on whichever write
reaches the server second, and nothing in the daemon orders that. Issue order
makes the stale write the likely winner, but "likely" is what a test must not
rest on.

Waiting for the truncate's `""` to land before closing the descriptor does not
rescue the value check either: it makes the cell hold `""` at the moment of the
close, so a poll for `""` succeeds before the stale write could arrive. Any
"the value stays `""`" check needs a barrier proving the stale write has landed
if it was going to, and the retry-on-conflict behavior above means no later
write supplies one — a write issued after the stale write can still commit
before it.

So the assertion observes the disarm where it happens, in the daemon's
`[write-trace]` log. `releaseCb` traces the handle's `dirty`, `flushing` and
`pending` fields before it decides anything, so that one line states whether
`close()` found the descriptor armed. It says so on either truncate path, and
whichever callback ends up doing the flushing. The script resolves the handle
number from the `write` line its own `printf` produced, waits for that handle's
`release` line, and requires it to report `pending=false` — the gate itself —
and `flushing=false`, since a flush already in flight carries the buffer it
copied when it started, which the truncate cannot recall.

The write and the truncate have to reach the descriptor's handle with no flush
between them, or the buffer never survives to the close the assertion is about.
That is why the script issues both under one redirect of the descriptor's fd
rather than writing through a transient `>&9`. On Linux the kernel sends a FUSE
flush on every `close()`, including the `close()` of the duplicate fd a
transient redirect makes and then drops when it ends — so `printf … >&9` would
flush the buffered write before the truncate ran, and the release would report a
handle that was never armed across a truncate at all. Grouping the write and the
truncate keeps the buffer on the handle until the group ends, after the truncate
has disarmed it, so every flush of that handle happens post-disarm. macOS
does not forward the flush on that duplicate close, so the grouping is a no-op
there and the write stays buffered until the real close either way.

One case escapes that line: a flush that started and finished before `release`
arrived clears the same fields the disarm clears. So the script also requires no
`flush-fire` line for the handle. `flushCb` traces `flush-fire` only for a handle
that got past the gate, which is exactly the case the release line would have
lost. Neither check subsumes the other. Between them they catch the descriptors
`flushCb` flushed and the ones `releaseCb` flushed, which is every descriptor
this sequence can arm.

Waiting for `release` is what makes this an observation rather than a guess.
`close()` sends `flush` and blocks on its reply before the kernel queues
`release`, and the daemon runs its callbacks on one thread through
`fuse_session_loop`, appending trace lines in that order. A `release` line for a
handle therefore cannot appear before that handle's flush decision has been
traced. The release check does not depend on `flush` being delivered; only the
supplementary `flush-fire` check does, and it is the one whose job the release
line already covers when `flush` is missing.

Both checks do depend on `release` being delivered, and one platform does not
deliver it: `scheduleFlush(handle, 500)` exists because Docker Desktop's VirtioFS
does not forward `flush` or `release` through a FUSE-T mount. Run the suite
there and it fails on the wait for the release line rather than reporting a
broken disarm. CI runs it on Linux against libfuse3, which delivers both.

That deferred flush is the one path the trace cannot see at all: the timer calls
`flushHandle` directly, tracing nothing. It cannot resurrect anything, because
`truncateByIno` has already closed `flushHandle`'s guard by the time it fires —
half a second after a write the script follows within three syscalls. The window
where it could pick up a still-armed buffer is not reachable from this sequence,
so nothing here observes it; it is out of the assertion's reach rather than
covered by it.

The `flush-fire` check passes by a line being absent, so a reword in `mod.ts`
would quietly turn it into a no-op that still passes. The other two lines fail
loudly if reworded — the script cannot resolve the handle, or times out waiting
for the release line — but they fail far from the cause. `mod.test.ts` pins the
shape of all three lines, so a reword fails there, naming what it broke.

The value check stays, after the trace checks, as the end-to-end statement that
the cell really is empty. It is the weaker of the two instruments and is not what
makes a broken disarm fail.

#### Cleanup hard-kills on a failure, unmounts gracefully on a pass

The daemon can wedge — a hang that hits a meaningful share of CI runs, with its
own root-cause investigation. When it does, every filesystem call that crosses
the mount blocks with no time limit, because the daemon that would answer it
never does. The exit-trap `cleanup` would run `cf fuse unmount` and check whether
the mount is still active; both touch the mount, so left unbounded on a wedge the
script neither reports nor exits. On CI the job then runs to its step timeout and
is cancelled with the streamed log truncated at the hang, so no diagnostics
survive — the original failure this guards against.

`cleanup` handles the two ways it is reached differently, keyed on the pending
exit status it captures before doing anything. If the test has **already failed**
— a `wait_for_path` deadline, an assertion, anything — we no longer care how the
mount is torn down, only that the process exits and reports the failure to CI. So
it hard-kills the daemon and detaches: `SIGKILL` on the worker that holds
`/dev/fuse` makes the kernel abort the connection, which is non-blocking and
needs no timeout, and `error` has already dumped the daemon state on the way in.
No graceful unmount is attempted, because a graceful unmount of a wedged mount is
the very thing that would hang. The failure code is preserved — an exit trap that
returns without calling `exit` keeps the status that triggered it — so nothing
here can mask the failure.

If the test **passed**, `cleanup` unmounts gracefully: the only path that
exercises the real `cf fuse unmount`, and the one that avoids leaving a stale
FUSE-T mount on macOS. That unmount is bounded, but by the shared outer deadline
([above](#wall-clock-time-is-not-a-measure-of-progress)), not a fixed few seconds
— so a slow-but-succeeding unmount is never cut short, and only a teardown that
cannot finish before the deadline (the daemon wedging during its own shutdown)
reaches the bound. That is a real failure a passing run must not hide, so
`cleanup` dumps the daemon state, hard-kills it, detaches, and fails the run. The
bound is still a ceiling, so a clock jump can trip it early on a healthy unmount;
but it sits minutes above how long an unmount takes, so only a multi-minute jump
does, and at that point we are out of diagnostic margin either way. Reporting is
the honest response — preferred over masking a genuine wedge whenever we cannot
prove it was a clock jump.

Killing the worker, not the bound, is what actually unsticks the mount. Once the
process holding `/dev/fuse` exits, the kernel aborts the connection and every
pending call returns an error. That exit is the event this path leans on, the
same way the shutdown escalation in the mount handshake leans on the child's exit
and only sends `SIGKILL` after a grace period as a fallback.

Before touching the mount at all, `error` dumps the daemon's own state — the tail
of its log file, which is a regular file off the mount, and on Linux each daemon
thread's scheduling state and kernel wait channel from `/proc`. A wedged mount
parks the worker thread in uninterruptible sleep in a FUSE wait, so that per-
thread state names the hang. Reading both crosses nothing that can block, so the
diagnostics survive even when the mount-tree dump that follows stalls. The
`/proc` state in particular has to be read here rather than from CI's post-run
log step: by the time that step runs, `cleanup` has killed the daemon and its
`/proc` entries are gone.

#### The daemon's `.status` file is a probe, not a signal

The FUSE daemon keeps write statistics (`writeStats` in `packages/fuse/mod.ts`)
and publishes them through the `.status` file at the mount root. A script can
read that file to see how many descriptors the daemon has opened, written and
flushed. The counts it reads are the ones the daemon held when it answered, so a
loop around `.status` would converge on the write-path event it waits for. The
`fuse-exec.sh` suite does not use it that way — it reads `.status` once, to
confirm the generated file is served as one coherent document, and waits on the
events it already has better signals for. Polling `.status` would be a poll it
can avoid.

That works because nothing writes `.status`. `CellBridge.initStatus` registers
it through `FsTree.addGeneratedFile`, which hands the tree a function that
renders the status JSON from the daemon's current counters. The callbacks that
report the file's size run that renderer and publish what it returns, and reads
serve the published bytes. The write path announces nothing: a flush increments
`writeStats.flushed` and stops there. No refresh has to be ordered after a
counter, because no refresh exists to be ordered.

The kernel caches are set to match. `replyEntry` and the getattr callback treat
a generated inode as dynamic and reply with a zero entry and attribute timeout,
so on Linux a lookup and a getattr precede each read. Publishing bumps the
node's mtime whenever the bytes change, and `.status` reports it, so a client
that validates its cached copy against the timestamp and the size notices a
counter going from 9 to 10 even though the document's length did not change.

A macOS mount cannot use those timeouts, because FUSE-T ignores the ones a reply
carries; it bounds staleness through an NFS attribute-cache mount option
instead, the `attrcache-timeout` default described in
`packages/fuse/mount-options.ts`. A `.status` poll on macOS is therefore only as
sharp as that option allows: a reader that has read the file once holds the NFS
client's cached copy until it expires, so a count arrives a beat after the write
that caused it. That the counts advance is settled by the `CellBridge.status`
unit tests, which drive the tree directly and need no mount and no wait.

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

## The FUSE mount handshake

`cf fuse mount --background` has to find out whether a daemon it did not spawn
directly came up. It spawns a supervisor, the supervisor spawns the FUSE daemon,
and the daemon is therefore a grandchild the command holds no handle to. Both
halves of the handshake wake on an event rather than a poll. The shape is worth
knowing, because "the processes are detached" reads like an argument that no
channel is available, and it is not one.

The daemon publishes readiness states — starting, mounted, failed, exiting,
exited — through a child-status file next to the mount state, refreshed by a
one-second heartbeat. Those states are the signal `cf fuse status` reads. A file
cannot wake a reader, though, so readiness for the handshake itself travels over
a pipe. The command spawns the supervisor with a piped stdout and blocks reading
it; the supervisor passes that descriptor down to the daemon, so the daemon's
readiness line arrives at the command directly and the read wakes on the write.
The status file serves `cf fuse status`, and the heartbeat keeps it fresh; only
the one-shot startup transitions go through the pipe, so the heartbeat does not
flood a channel nobody reads once the command has returned.

Detachment does not rule the pipe out, and the reasons are worth stating because
each one looks like a blocker.

The daemon must outlive the command. It does: the descriptor is inherited at
spawn, and closing the read end has no effect on the processes holding the write
end. The command reads one line, cancels the reader and exits, and the mount
stays up.

A daemon whose parent has gone must not die. It does not. Deno ignores SIGPIPE
and surfaces a write to a readerless pipe as a catchable `BrokenPipe`, so the
readiness write catches and the mount continues unobserved. Nothing else reaches
that descriptor: a background daemon redirects `console.log` and friends into its
log file, and only tees to stderr when stderr is a terminal, which for a
background mount it is not.

The supervisor is unreferenced only after the handshake. `unref` keeps the child
from holding the command's event loop open, which is what the command wants once
the mount is up and outlives it. Unreferencing before the read would stop the
readiness read from holding the loop open too, and the command would exit
mid-handshake with a zero status and no output.

Failure is an event as well, and this is the part a poll cannot match. Two things
end the read besides a report. End of stream means every process holding the
write end has exited. The supervisor's exit — which the command already holds,
because the supervisor is the child it spawned — means no report is coming from a
daemon that cannot send one. Both fire the moment they happen rather than on the
next liveness tick, and a daemon that fails during startup publishes its own
error first, so the command reports the cause rather than only that the process
went away.

Watching the supervisor's exit is not belt-and-braces on top of end of stream;
without it the command can hang. The daemon inherits the write end, so a daemon
orphaned by a dead supervisor holds the stream open on its own and end of stream
never arrives. A supervisor killed while its daemon sits there silently would
otherwise leave the read outstanding forever.

The pipe is private to one invocation, which is why the handshake carries no
correlation. The status file is a shared namespace — a stale file from an earlier
mount at the same mountpoint sits at the same path — so a reader of that file
would need a correlation token, a mountpoint check and a cross-check against the
mount state to tell its own child's report from a leftover. A line on the pipe
came from this invocation's daemon and nothing else, so the handshake needs none
of that.

The supervisor owns the mount state file, because it is the process that spawns
the daemon and so the only one that knows both pids; it writes the file once and
completely. The command prepares the containing directory and the path, and the
supervisor holds write access to that one file and no read access.

What lets the readiness read stay pure-event is where the daemon announces
`mounted`. It announces only after it has dispatched its FUSE session loop and
installed its signal handlers, so a command that has read `mounted` has a mount
that serves requests and tears down cleanly on a signal. The announcement
carries that guarantee, so the command trusts it on arrival: it confirms the
child and the supervisor are alive at that instant — a point-in-time probe, not a
wait — and returns. An announcement made earlier, before the loop was dispatched,
would report a mount that might still fail in the loop, and to catch that the
command would have to wait out a fixed confirmation window on every successful
mount, a genuine timing bet because nothing announces that a process intends to
keep running. Moving the announcement behind the loop dispatch retires that wait
rather than tuning it.

The status file the daemon also writes, the record `cf fuse status` reads, is
written to survive a concurrent reader, because its startup, readiness, heartbeat
and signal paths all write it without coordinating. Each write lands under a
scratch name and is renamed into place, so a reader woken mid-write sees a whole
document rather than a truncated one. And the writes are serialized through a
queue, so the file ends on the state of the most recent call: without that, two
renames could complete in either order and let a heartbeat still in flight
replace a terminal state, leaving the file claiming a mount that has already
gone.

One wait in the handshake keeps a real duration:
`cleanupFuseChild`'s shutdown escalation. It sends SIGTERM,
allows the child five seconds to exit, then sends SIGKILL. The wait for the
child's exit is event-driven — it races the real status promise — and the timeout
is the escalation policy, not a stand-in for a missing signal. A process ignoring
SIGTERM never announces that it intends to keep ignoring it.

There is no deadline on the readiness read. A daemon that neither mounts nor
exits, under a supervisor that is also still there, blocks the command
indefinitely — which is what a foreground mount does too, and the user interrupts
it or a CI job limit catches it. Every way the pair can actually fail ends the
read instead. A ceiling over the read would instead fail a mount that would have
succeeded on a loaded machine, the ceiling this note warns about throughout.
