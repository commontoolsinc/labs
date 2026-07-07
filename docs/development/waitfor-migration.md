# Migrating off the polling `waitFor` helper

This note records an effort to move test waits away from `waitFor` — a poll
loop with a sleep and a timeout — and onto primitives that resolve on a real
event. It also records the `waitFor` usages that were deliberately left in
place, because for those a bounded poll is the honest observation and replacing
it would add coupling or complexity rather than remove flakiness.

## Why move off `waitFor`

`waitFor(predicate, { timeout, delay })` (defined in
`packages/integration/utils.ts`) re-runs `predicate` every `delay` milliseconds
(50 by default) and throws once `timeout` (60 seconds by default) elapses. In a
browser test each tick is also a DevTools Protocol round-trip. Two problems
follow. The timeout puts a ceiling on success: anything slower than the timeout
can never be observed, even when it would have completed. The fixed delay puts
a floor on latency and, in performance measurements, quantizes timings to the
poll interval.

Several non-browser test files also each define their own local copy of the same
poll-loop shape, so the pattern had spread well beyond the shared helper.

## The two families

The usages split into two groups with very different replacements.

**Browser integration tests** use the `waitFor` exported from
`@commonfabric/integration`. The replacement toolkit already exists in the repo:

- `waitForCondition(page, predicate, { timeout, args })` installs a single
  waiter inside the page. A shared MutationObserver hub watches the document and
  every shadow root — including shadow roots created after the wait began — and
  re-evaluates the predicate the instant the DOM reflects new state, then signals
  the test process over a protocol binding. It keeps a `timeout` argument, but
  that is a genuine stuck-condition safety net, not a poll interval; a coarse
  500-millisecond in-page backstop covers conditions that flip with no DOM
  mutation (for example a runtime global being set).
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

**Non-browser tests** (in `runner`, `memory`, `toolshed`, `piece`) each define a
local `waitFor` poll loop. There is no page to attach an in-page waiter to. The
sound replacement, where one applies, is to await a promise or resolve a
`defer()` (from `packages/utils/src/defer.ts`) inside a callback the test already
registers — a cell `sink`, a storage subscription's `next`, a scheduler
`onError`, or a counter incremented inside a test-owned transport.

## What was migrated

- `packages/shell/integration/header-menu.test.ts`,
  `packages/shell/integration/login.test.ts`,
  `packages/shell/integration/blob-upload.test.ts` — menu open/close class,
  breadcrumb text, aria-expanded, menu-item labels, piece-switcher dropdown
  presence and absence, runtime-exposed and image-loaded checks, all moved to
  `waitForCondition`. Several had abused a short `waitForSelector` timeout inside
  a try/catch as their poll tick; those inverted patterns are gone.
- `packages/shell/integration/shadow-dom.ts` — the shared `clickPierce` helper
  now finds its target through a `waitForCondition` predicate rather than a
  `waitFor` scan.
- `packages/shell/integration/piece.test.ts` — the slug-marker text, the
  app-view's resolved space-root and active pattern, and the runtime
  exposed/torn-down checks moved to `waitForCondition`.
- `packages/patterns/integration/counter.test.ts`,
  `packages/patterns/integration/nested-counter.test.ts`,
  `packages/patterns/integration/fetch-json.test.ts` — rendered-text waits moved
  to `waitForText`; the "two nested displays agree" assertion to a single
  `waitForCondition` predicate.
- `docs/development/UI_TESTING.md` — guidance and examples updated to teach the
  event-driven primitives instead of `waitFor`.

## Intentional exceptions: `waitFor` usages left in place

These are the usages where a bounded poll is the right tool. They are grouped by
the reason migration was declined.

### No page, and no callback to hang a promise on

These observe in-process state that becomes true as a side effect, with no event
boundary the test can await without adding one to production code.

- `packages/runtime-client/integration/client.test.ts` (every `waitFor`) drives
  a `RuntimeClient` over a web-worker transport and renders into an in-memory
  `MockDoc`. There is no browser page, so `waitForCondition` does not apply; the
  waits observe in-process arrays, `CellHandle` values, and the mock's
  `innerHTML`. Some could become `rt.idle()` / `cell.sync()` / subscription
  awaits — a separate in-process refactor, not this browser-focused change.
- `packages/generated-patterns/integration/pattern-harness.ts` pulls a runtime
  `Cell` value and compares it, headless. No page; polling the pull until it
  converges is the honest wait.
- The `waitFor` calls in `counter.test.ts`, `nested-counter.test.ts`, and
  `piece.test.ts` that read a piece's committed `result` cell through the
  in-process controller. These observe an off-page cell. They are technically
  convertible by resolving a `defer()` inside the `resultCell.sink(...)` the
  tests already register, but that conversion belongs with the non-browser
  effort and needs the browser+CLI suite run to verify.

### Race, backpressure, and convergence tests

Here the poll is measuring eventual convergence across timing the test does not
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
  `storageManager.synced()` each iteration; the remaining poll observes eventual
  convergence of that multi-stage evaluation.
- The frontier-cardinality waits in `memory-v2-subscription.test.ts`,
  `memory-v2-pull-reactivity.test.ts`, and `memory-v2-reconnect-race.test.ts`
  ("all N reachable ids present") are soft: event-driven only via a counting
  `defer()` over several integrate batches, which is a poll wearing a callback.
  Left as bounded convergence checks.

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
present. These observe API readiness, not a UI condition; the honest fix is to
await a runtime-ready signal directly, not to install a DOM waiter. They are
env-gated profiling scaffolding, not assertions.

### A shared state primitive

`packages/integration/shell-utils.ts`'s `waitForState` compares the shell's
serialized `AppState` (view plus identity DID), read through
`globalThis.app.serialize()`. That is application state, not the DOM, and this is
the shared primitive many suites build on. `waitForCondition`'s probe cannot see
app state, so migration would mean re-implementing view/identity comparison
inside an in-page predicate for no reduction in flakiness.

### Disabled tests

`cf-code-editor.test.disabled.ts`, `cf-render.test.disabled.ts`, and
`cf-checkbox.test.disabled.ts` hold many `waitFor` calls but never run.
Migrating them only churns dead code.

## Remaining migratable work (not yet done)

These have clean, event-driven replacements and are worth doing, but each needs
the relevant suite run to verify and so was not bundled with the mechanical
commits above.

- **Non-browser `defer()` conversions.** In `scheduler-commit-backpressure`
  (telemetry-marker and `onError` waits), `memory-v2-subscription`,
  `memory-v2-reconnect-race`, `memory-v2-reactivity`, `reconnection`,
  `v2-client-test`, `v2-restore-flush-test`, `toolshed/.../memory.test.ts`, and
  `piece/test/pull-materialization.test.ts`, the awaited transition already flows
  through a callback the test registers (a cell `sink`, a subscription's `next`,
  a scheduler `onError`, or a counter incremented inside a test-owned transport).
  Resolving a `defer()` there and awaiting it removes the poll with no
  production-code change. These are runnable and verifiable in-process.
- **Browser probe-inlining.** In `chatbot.test.ts`, `cfc-group-chat-demo.test.ts`,
  `cfc-spec-gallery.test.ts`, and `cfc-authorship-chat.test.ts`, a `page.evaluate`
  probe can move into a `waitForCondition` predicate. In `default-app.test.ts` and
  the notebook reload test, `waitFor(() => waitForRuntimeIdle(page))` and
  `waitFor(() => awaitViewSettled(page))` wrappers can drop to the bare helper,
  and the `clickButtonWithText` re-click helpers can become settle-then-single
  `clickCfButton`. The `clickNthButton` helper in `nested-counter.test.ts`
  likewise wants a settle-then-single-click rewrite rather than a mechanical
  swap.

## Also noticed (out of scope)

Two bare sleeps sit next to migrated waits and deserve their own cleanup:
`packages/runner/integration/reconnection.test.ts` sleeps 100ms after restarting
the server, and `packages/toolshed/routes/storage/memory/memory.test.ts` does the
same. Both race server readiness rather than awaiting it.
