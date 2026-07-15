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

Reach for a poll only for the cases catalogued under [Where the polling
`waitFor` stays](#where-the-polling-waitfor-stays). Everywhere else, wait on an
event.

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

## Guard against new usage

A check prevents new integration tests from importing the polling `waitFor`.
`tasks/check-no-waitfor.ts` scans the `.ts` files under any `integration/`
directory beneath `packages/` (excluding the `@commonfabric/integration` package,
which defines `waitFor`) and fails when one names `waitFor` in an import of that
package and is not on the check's allowlist. Two spellings reach it and both
count: the bare `@commonfabric/integration` specifier, and a relative path ending
at the package's `utils.ts` or `index.ts`. Commenting the import out clears the
check, so it stays out of the way while a test is being migrated — text inside a
comment or a string is not an import. Run it with `deno task check-no-waitfor`;
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
  file, and every such read in `counter.test.ts` and `nested-counter.test.ts`,
  resolve a `defer()` from the existing `resultCell.sink(...)`.

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

### Instrumentation one-shots, and a few unconverted UI waits

`packages/patterns/integration/default-app.test.ts` keeps `waitFor` for one-shot
instrumentation: arm a trace, reset a logger, install a telemetry handler. Each
such call returns false only until a runtime API is present, so it observes
runtime API readiness rather than a UI condition, and it is profiling scaffolding
rather than an assertion. Most of them sit behind a `CF_CAPTURE_*` environment
gate. If converted, await a runtime-ready signal directly rather than installing
a DOM waiter.

`packages/patterns/integration/reload/default-app-notebook.test.ts` keeps one
wait of that shape — it arms the event-invocation telemetry handler, which is the
one instrumentation wait that runs ungated in both files.

The rest of the waits in these two files are ordinary UI conditions, and a poll
is not the right tool for them. They are simply not converted yet: both files
wait for the note modal's "Create Another" button to render, and
`default-app.test.ts` also retries a piece-link click until the link is found. A
`waitForCondition` predicate would express each of them. Converting them would
not take either file off the allowlist, because the instrumentation waits keep
both files importing `waitFor`.

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
express. They stay a poll for the same reason as the disabled tests below:
nothing automated exercises this file, so converting it churns code that no run
covers.

### A shell script observing another process through a kernel mount

`packages/cli/integration/fuse-exec.sh` drives the FUSE daemon as a separate
process through a real mount, and observes it from bash. Its three poll loops —
`wait_for_path`, `resolve_entity_dir`, and `wait_for_piece_value` — stay polls.

There is no event channel to convert them to. The state each loop waits on lives
in another process: the daemon's tree for the two path loops, and the server's
cell for the value loop. Bash has no callback to resolve a `defer()` from.

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
parsed a PID has a daemon that reported mounted.

The daemon reports that state just before it enters its FUSE session loop, so it
means the kernel mount exists rather than that any request has been served, and
mounted paths hydrate lazily besides. Both gaps belong to `wait_for_path`, whose
probe carries its own kill-timeout and retries for twenty seconds. What is left
for the script is one check that the daemon survived the handshake.

The stale-descriptor assertion — that truncating a path does not let an already
open descriptor write its old buffer back — waits on `wait_for_piece_value`
alone. This looks like it needs a delay, because it asserts that something does
not happen. It does not, because a descriptor that could write late is a
descriptor that has already written.

Both truncate paths — `open` with `O_TRUNC` on Linux, and the handle-less
`setattr` that FUSE-T issues on macOS — reach `handles.truncateByIno`, which
empties the buffer of every handle on the inode and clears both `dirty` and
`truncatePending` on the one that is not the truncating handle. `flushHandle`,
`flushCb` and `releaseCb` all gate on that pair, so the disarmed descriptor is
inert. A descriptor that stayed armed instead flushes from the callback the
kernel sends on `close()`, which the flush callback issues in the same tick when
the handle is dirty. Its write targets the same cell as the truncate's own write
and is issued after it, so it lands last and the value settles on the stale
content rather than `""`.

The deferred flush that every write arms, `scheduleFlush(handle, 500)`, is the
one path that could fire after the wait, and it cannot resurrect anything.
`truncateByIno` does not cancel it, so it does fire around half a second later —
into `flushHandle`'s guard, which the disarm has already closed. In the armed
case it never gets that far, because the flush callback calls
`clearScheduledFlush` before flushing.

#### The daemon's `.status` file is not a wait signal

The FUSE daemon keeps write statistics (`writeStats` in `packages/fuse/mod.ts`)
and publishes them through the `.status` file at the mount root. That file looks
like a way to wait for the daemon to report a write-path event. It is not. The
counters it carries lag the events they describe, and reading it around a write
shows them frozen across the open, the write, the truncate and the release, then
jumping several counts at once.

The content is a snapshot rather than a live view. `CellBridge.initStatus` bakes
JSON into a tree node and the read callback serves that node's stored bytes, so
the numbers a reader sees are the ones the last `updateStatus` call baked.

Refreshes do reach `.status` from the write path, but never carrying the counter
a waiter wants. A successful flush calls `markExistingFinalized`, which reaches
`updateStatus` through `CfcWritebackStore.deletePrepared`, `persist` and the
store's `onChange` hook. That chain runs before `writeStats.flushed++` on every
flush branch, so the snapshot a flush triggers always reports the count from
before that flush. Opening and writing move their own counters with no refresh
attached at all.

Attribute caching sits on top. `.status` is a static inode, so `replyEntry` gives
it a one-second entry and attribute timeout on Linux, and a macOS mount bounds
staleness through an NFS attribute-cache option instead, because FUSE-T ignores
the timeouts a reply carries. `updateStatus` assigns `node.content` and changes
no size or mtime, so nothing invalidates a cached reader either way.

Waiting on `.status` therefore means waiting for a refresh that reports the state
before the event, through a cache with no invalidation, at a granularity coarser
than the wait itself. Making it a real signal means ordering the refresh after
the counters, regenerating on read, and giving a reader something to notice.

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
