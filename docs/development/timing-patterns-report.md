# Timing Patterns in commontools — A Comprehensive Audit Report

*Retry loops, timeouts, sleeps, and wall-clock control decisions across the reactive runtime.*

Grounded in the exhaustive audit at [`timing-patterns-audit.md`](./timing-patterns-audit.md) (686 catalogued instances across 527 files), the aggregate run statistics, and three independent analyst drafts covering architecture, risk, and refactor strategy.

---

## 1. Executive summary

This report synthesizes a complete, file-by-file audit of every timing-related code pattern in the commontools repository. The scope was deliberately broad: retry loops, backoff schedules, quiescence-polling loops, timeouts, sleeps, and every reading of the wall clock that feeds a control-flow decision. One hundred parallel review agents read 527 source files in full — the strong-signal subset of a 3,711-file corpus — and catalogued each instance along the same set of dimensions: category, subtype, severity, whether the mechanism is load-bearing, its blast radius, and its risk to determinism.

**Headline numbers.**

- 686 timing instances were catalogued across 527 files.
- The category split: 256 retry/backoff/quiescence loops, 205 sleeps, 114 timeouts, 43 wall-clock control readings, and 68 other mechanisms (cancellation tokens, cross-thread ordering primitives, heartbeats).
- The severity split: 34 high, 158 medium, 260 low, and 234 informational.
- The concentration is extreme. Of the 686 instances, 248 live in `packages/runner`, the reactive engine — more than a third of everything, and nearly triple the next package (`patterns`, at 86). Within the runner, twelve of the thirty-four high-severity findings sit in a single subsystem: the reactive scheduler.

**The five most important takeaways.**

1. **This is a convergence-oriented system, and its timers say so.** The largest single category is not timeouts (as it would be in a request-and-response service) but retry loops, at 256. That fingerprint means the dominant design question underneath these patterns is not "how long do I wait for a reply" but "how do I know the reactive graph has stopped changing." The system has no single, first-class "everything has settled" event, so it has grown a family of quiescence detectors — loops that re-check, re-drain, and re-schedule until the graph stops dirtying itself.

2. **The timing complexity pools at three places, not evenly across the code.** It concentrates in the reactive scheduler (the machinery that decides when a graph is "done"), at the boundaries where the reactive core meets an uncooperative asynchronous outside world (the network, the disk and operating system, the DOM, the sandbox, the language model), and in the test harnesses that try to observe both deterministically.

3. **Most high-severity findings are load-bearing correctness machinery, not sloppiness.** The words "load-bearing" and "fragile" recur in nearly every high finding. The genuine smells cluster into two shapes: a magic-number timer standing in for a signal the code does not yet have, and a poll-when-you-could-subscribe loop in a test harness or piece of glue.

4. **The runner already demonstrates the correct pattern, and the dangerous findings are precisely the places that pattern has not yet reached.** The engine has a working vocabulary for "wait for an observable completion signal, not a clock": `scheduler.idle()`, `runtime.settled()`, `storageManager.synced()`, `editWithRetry()` with its `readyToRetry()` catch-up gate, and the conflict-wait gate in `scheduler/action-run.ts`. The debt is well-scoped: the remedy is demonstrated within the same codebase, and the refactoring job is largely to propagate that vocabulary outward.

5. **A small number of patterns tie a correctness outcome — not merely latency — to real elapsed time, and those are the sharpest risk.** The single most dangerous instance is a 30-second wall-clock window in the commit backpressure path that decides whether a contended durable write converges or is dropped. On a slow or oversubscribed continuous-integration machine, the same logical contention can blow a window that would have converged on a fast machine.

---

## 2. The landscape: a taxonomy of every mechanism class

### 2.1 Category mix, read as architecture

The category counts are not just an inventory; they are a signature of the system's nature.

| Category | Count | What it signifies architecturally |
|---|---:|---|
| Retry loops, backoff & quiescence polling | 256 | Convergence under optimistic concurrency; "wait until settled" with no settle event |
| Sleeps (timer / hot-loop idling) | 205 | Macrotask fences, debounce and coalesce timers, and test-harness settle waits |
| Timeouts (wall-clock / stopwatch bounds) | 114 | Deadlines at every input/output boundary that offers no liveness guarantee |
| Wall-clock readings feeding control flow | 43 | Time-to-live and lease expiry, retry windows, adaptive throttling |
| Other (cancellation, cross-thread ordering, heartbeats) | 68 | AbortController cancellation, MessageChannel ordering, telemetry probes |
| **Total** | **686** | |

That retry loops dominate both timeouts and even sleeps is the fingerprint of a convergence-oriented system rather than a request-and-response one. In a plain create-read-update-delete service, timeouts dominate. Here, the largest bucket is "re-run this work until it stops producing more work."

The severity split reflects a codebase that is largely deliberate about all this. There are 260 low and 234 informational findings against only 34 high. The high-severity items are overwhelmingly load-bearing correctness machinery the authors know is subtle, not accidental sleeps left in by mistake.

### 2.2 Where the patterns concentrate: category by package

The audit's category-by-package heat table makes the concentration vivid. The runner alone holds 95 of the 256 retry loops, 73 of the 205 sleeps, 47 of the 114 timeouts, and 18 of the 43 wall-clock control readings.

| Package | retry-loop | timeout | sleep | wall-clock | other | Total |
|---|---:|---:|---:|---:|---:|---:|
| `packages/runner` | 95 | 47 | 73 | 18 | 15 | 248 |
| `packages/patterns` | 46 | 7 | 24 | 4 | 5 | 86 |
| `packages/ui` | 12 | 6 | 26 | 1 | 22 | 67 |
| `packages/cli` | 20 | 10 | 13 | 0 | 6 | 49 |
| `packages/memory` | 12 | 6 | 7 | 4 | 0 | 29 |
| `packages/cf-harness` | 8 | 13 | 1 | 0 | 5 | 27 |
| `packages/fuse` | 10 | 0 | 12 | 2 | 3 | 27 |
| `packages/toolshed` | 5 | 7 | 3 | 4 | 0 | 19 |
| `packages/runtime-client` | 3 | 3 | 5 | 3 | 3 | 17 |
| `packages/shell` | 4 | 3 | 7 | 1 | 0 | 15 |
| `tasks` | 6 | 1 | 2 | 3 | 1 | 13 |
| `packages/utils` | 1 | 2 | 7 | 0 | 2 | 12 |

A few package profiles stand out. The user-interface package (`ui`) is the only one where the "other" category is large (22 of 67): that is the requestAnimationFrame, MessageChannel, and cancellation-token machinery of DOM rendering. The `cf-harness` test package is the only one where timeouts dominate (13 of 27): those are the deliberate external-call deadlines and AbortSignal cancellation tests. The `fuse` filesystem bridge has zero timeouts but heavy sleeps and retry loops: at the operating-system boundary the code does not so much bound a reply as debounce a stream of writes with no clean end signal.

### 2.3 Nine mechanism clusters

Reading the taxonomy from the reactive core outward, nine distinct mechanism clusters emerge. Each answers the same underlying question — "when is something done?" — but the answer degrades from clean completion signals at the center to magic-number guesses at the edges.

- **Cluster A — Scheduler quiescence and the macrotask heartbeat (the core).** The runtime advances reactive state on a `setTimeout(0)` macrotask fence, not a microtask, deliberately. This is treated in depth in Section 3.

- **Cluster B — Optimistic-commit backoff and conflict re-queue (core meets storage).** The store is optimistic: writes commit against a basis that may be stale, and the engine surfaces conflicts one stale-read at a time. This produces the codebase's most sophisticated retry family, in `scheduler/backpressure.ts`, `scheduler/events.ts`, `scheduler/action-run.ts`, and `pattern-manager.ts`. The good news is that these retries gate on the `readyToRetry` completion signal wherever possible; timers appear only for backoff spacing and for the give-up deadline.

- **Cluster C — Network reconnect and backoff (core meets network).** The persistence engine talks to a remote store over a connection that can drop, so it grows the classic resilience stack in `memory/v2/client.ts`: an unbounded reconnect loop, a textbook exponential-backoff-with-jitter delay, and a completion-signal gate (`waitForCaughtUpLocalSeq`) that is preferred within a live connection. The asymmetry is telling: within a connection the client awaits a sequence signal; across a dropped connection there is nothing to await, so it falls back to blind timed retry.

- **Cluster D — Fan-out debounce and drain-convergence (server side of memory).** The subscription server in `memory/v2/server.ts` reproduces the scheduler's quiescence problem on the server: a 5-millisecond debounce, a `while(true)` drain-quiescence loop, and a drain-then-drain-again convergence loop. The same "no aggregate settled signal" gap that shapes the client reappears here for cross-connection fan-out.

- **Cluster E — Filesystem debounce and coalescing (core meets disk and operating system).** The FUSE mount in `fuse/cell-bridge.ts` and `fuse/mod.ts` accumulates the most fragile timer magic in the audit, because the operating-system and virtual-filesystem layer emits no clean completion signals. This cluster has the highest concentration of "the constant is a guess" comments.

- **Cluster F — DOM render loops, view-settle, and requestAnimationFrame (core meets DOM).** The DOM is a separate, asynchronously-updating world, so `packages/html` and dozens of `packages/ui` components grow their own quiescence and frame-pacing layer. It produces two idioms: microtask coalescing where a real completion promise exists (Lit's `updateComplete`, the reconciler flush), and frame-poll retry via requestAnimationFrame where the framework exposes no signal for "property assigned."

- **Cluster G — Deadlines at external boundaries (core meets sandbox, language model, worker, subprocess).** Every place the reactive core hands work to something it cannot introspect gets a wall-clock deadline: the worker-controller IPC deadline, the language-model tool-call race, the fetch mutex lease, and subprocess supervisors. The recurring critique is identical across all of them — a pure wall-clock deadline cannot tell "slow" from "stuck."

- **Cluster H — Heartbeats and event-loop-lag probes (diagnostics).** A handful of `setInterval` timers used purely for observability: a self-correcting event-loop-lag probe in `runtime-client/client/connection.ts` that measures how late a 100-millisecond timer fires to detect main-thread blocking, plus a FUSE heartbeat and a voice-input duration display. These are the only timers the audit blesses unreservedly; they feed histograms, not decisions.

- **Cluster I — Test-harness settle waits and benchmark stopwatches (observing the system).** Because the core has no public "everything settled" event, tests reconstruct one. This is where the most numerous, though lowest-severity, smells live. The test layer is a mirror: where production exposes a real signal, tests await it and are deterministic; where it does not, tests poll-and-sleep and become the audit's largest reservoir of flakiness.

---

## 3. Deep dive: the reactive scheduler and timing subsystem

The runner scheduler (`packages/runner/src/scheduler` and `scheduler.ts`) deserves separate treatment because it is simultaneously the densest and the best-engineered timing subsystem in the repository. Twelve of the 34 high-severity findings live here. Its design can be read almost directly off the audit, and understanding it is the key to understanding every other timer in the codebase, because every other timer is what the scheduler would look like if the boundary it faced exposed a real signal.

### 3.1 The macrotask heartbeat

The single most consequential timing decision in the codebase is that the runtime advances reactive state on a `setTimeout(0)` macrotask fence, not a microtask.

- `scheduler.ts:1004-1017`, `Scheduler.queueExecution`, is a recursive `setTimeout(0)` re-queue. The audit calls it "the central heartbeat of the reactive runtime." The choice of macrotask over microtask is itself the completion-ordering contract: it guarantees derived state and effects settle after microtasks and input/output callbacks, so storage callbacks interleave correctly. A microtask would starve input/output and change convergence order.

- `scheduler/continuation.ts:94-103`, `queueAnotherExecutionTick`, is the same `setTimeout(0)` re-queue that drives multi-pass convergence. Each pass is a fresh macrotask, so a churning graph that never settles spins the event loop rather than burning the CPU — which makes a non-settling graph detectable and non-fatal instead of a hung process.

The blast radius of this decision is, in the audit's word, "enormous": every schedule path funnels through `queueExecution`. Any well-meaning optimization that swapped the macrotask for `queueMicrotask` or a MessageChannel would change batching granularity, reorder against storage callbacks, and break the `idle()` and `settled()` semantics that hundreds of scheduler tests depend on. It is dangerous the way a load-bearing wall is dangerous: fine until someone touches it.

### 3.2 The quiescence oracle

`scheduler.ts:963-1002`, `Scheduler.idle`, is the primary synchronization point for the entire system and for every test. It is a recursive re-check quiescence loop: mostly event-driven, but re-polling its quiescence conditions after each await. Its branch set — running work, background work, the event-queue wake, lineage, and pull-mode settling — literally defines what "idle" means. Missing a wake source would hang `idle` forever. This is the function every test awaits instead of sleeping a fixed number of milliseconds, and it is the reason the well-written tests in the suite are deterministic.

### 3.3 Counted settle loops with cycle-break fallbacks

The scheduler's answer to the unanswerable question "is the reactive graph done?" is to bound convergence by a count of passes rather than to prove a mathematical fixpoint.

- `scheduler/execution.ts:357-382`, `trackSettleLoopIteration`, caps a settle re-run at 100 iterations per action. A cyclic computation that keeps dirtying itself is stopped deterministically rather than hanging.
- `scheduler/pull-execution.ts:108-139`, `runPullSchedulerSettleLoop`, caps the pull-mode settle loop at 10 iterations. This is the file whose in-code comment poses the whole system's question — "how do I know the reactive graph is done" — verbatim.
- `scheduler/pull-cycle-break.ts:23-71`, `breakPullCyclesIfNeeded`, is the escape hatch that fires when the 10-iteration cap is hit. It exists precisely because the settle loop uses an iteration cap instead of a fixpoint proof: it force-clears the computations it heuristically judges to be in a cycle and runs the remaining dirty effects once.

The audit is careful to praise the choice of count-based over wall-clock bounds here: count-based determinism is preferable, because the same graph converges in the same number of passes on a fast machine and a slow one. The residual risk, treated in Section 4, is that the specific numbers (10 and 100) are magic constants encoding a hidden assumption that no legitimate graph needs more passes.

### 3.4 The backpressure retry engine

This is the one place the scheduler admits the wall clock into a correctness decision, and it is the most carefully reasoned retry family in the codebase.

- `scheduler/backpressure.ts:87-100`, `computeBackoffDelayMs`, is exponential backoff with subtractive jitter. Its guarantee is that a write is never silently dropped: it either converges or fails loudly with a `CommitConvergenceError`.
- `scheduler/events.ts:64-93`, `scheduleEventQueueWake`, converts busy-retry of transient commit conflicts into coalesced, cancellable, clamped timed wakeups, wired into `idle()` and `settled()` so parked events still complete within a settle. The audit calls this "the correct signal-plus-timer pattern for backpressure, not a smell."
- `scheduler/events.ts:625-655`, `requeueForBackoff`, and `scheduler/events.ts:959-1000`, `classifyCommitDisposition`, are window-bounded rather than count-bounded: a 30-second wall-clock retry window, measured from the first conflict, decides whether a contended write converges or fails terminally.
- `scheduler/action-run.ts:116-197`, `watchReactiveActionCommit`, is the crux. It distinguishes a conflict-wait (gate on the `readyToRetry` completion signal — the good pattern) from a real-failure-retry (bounded budget). Treating a conflict as a wait, rather than consuming the retry budget, is what prevents "zombie" computations under contention.

### 3.5 Adaptive self-throttling

The scheduler instruments its own elapsed time to detect and throttle misbehaving actions. `scheduler/delays.ts:186-220`, `scheduleComputationDebounce`, combines a trailing-flush timer with `performance.now()` deadline reads to bound the staleness window of debounced derived data. The adaptive cycle-aware debounce (`scheduler/execution.ts` and `scheduler.ts:1542-1566`) throttles an apparently-cyclic action when a settle pass takes more than 100 milliseconds of wall-clock time and the action has re-run at least three times. The engine watching its own wall clock to decide when a computation is misbehaving is clever, but it is exactly the kind of clock-dependence that makes convergence tests timing-sensitive.

### 3.6 The invariant threading all of it

The critical property that ties the whole subsystem together: reactive retries gate on completion signals — `readyToRetry`, sequence markers — wherever possible, and fall back to timers only for backoff spacing (to avoid thundering-herd synchronization) and for give-up deadlines (to bound how long to keep believing convergence is possible). That is the mature version of the pattern the rest of the codebase is groping toward. The scheduler is what every FUSE debounce, requestAnimationFrame retry, and test `waitFor` loop would look like if the boundary it faced exposed a real signal.

---

## 4. Risk analysis: determinism, flakiness, and hot paths

Different categories fail in different ways. Retry loops risk non-termination, or termination that drops valid work. Sleeps risk test flakiness and freshness-versus-latency tradeoffs pinned to a magic constant. Timeouts risk abandoning slow-but-valid work. Wall-clock control readings risk non-determinism, because the outcome depends on real elapsed time. The 34 high-severity findings collapse into three recurring archetypes, ordered by how directly they threaten correctness rather than mere latency.

### 4.1 Archetype A — a wall clock gates a correctness outcome

This is the worst class, where real elapsed time decides whether valid work is kept or dropped.

- **`scheduler/events.ts:959-1000`, `classifyCommitDisposition` — the single most dangerous instance.** A 30-second wall-clock window, measured from the first conflict via `performance.now()`, is the gate between eventual convergence and terminal failure of a contended durable write. The window-from-first-conflict design is clean and the backoff carries jitter, but the audit states the danger plainly: tying a correctness outcome (drop versus converge) to a 30-second wall-clock deadline is inherently non-deterministic under heavy contention. On a machine that is slow, oversubscribed, or paused by garbage collection or container throttling, the same logical contention can blow a window that would have converged on a fast machine. The outcome is loss of a valid write, not a delay; it feeds control flow directly; and it is on the hot path under write contention.

- **`runner/src/builtins/llm-dialog.ts:2597-2611`, `invokeToolPattern`.** A fixed 120-second `Promise.race` deadline (`TOOL_CALL_TIMEOUT`, line 106) on language-model tool calls. A slow-but-valid tool is killed at exactly 120 seconds. The completion path is already signal-driven through `result.sink`, so the timer is a pure backstop — the smell the audit says should ideally flow through an AbortSignal instead of racing a stopwatch.

- **`background-piece-service/src/worker-controller.ts:149-191`, `WorkerController.exec`.** A 60-second inter-process-communication deadline, well-formed with a proper `clearTimeout` in a `finally` block. But it abandons purely on wall time with no notion of forward progress, so a legitimately long task and a hung task look identical. Every IPC call routes through it, and a rejection feeds the `onProcessFail` backoff-and-disable logic in `SpaceManager` — so a machine slow enough to make legitimate work exceed 60 seconds can trip pieces toward the three-strike disable path.

- **`scheduler/delays.ts` / `scheduler/execution.ts:523-555`, `planPullAdaptiveCycleDebounce`.** Throttles an apparently-cyclic action when a settle pass exceeds 100 milliseconds of wall-clock time. Machine speed decides the throttling, which interacts perniciously with the count caps in Archetype B: the same graph on a slow machine crosses the 100-millisecond threshold sooner, gets throttled harder, and can therefore need more settle iterations — nudging it toward the iteration cap.

The common defect across this archetype is a time bound with no notion of forward progress. The fix vocabulary the audit points to is a forward-progress heartbeat and AbortSignal cancellation, so that "hung" and "slow" stop looking identical.

### 4.2 Archetype B — a magic count or constant stands in for a "done" signal

Deterministic, but built on a hidden assumption that can silently clip valid work.

- **The iteration-cap settle loops (Section 3.3).** `runPullSchedulerSettleLoop`'s cap of 10 is a magic ceiling; a graph that genuinely needs more than 10 iterations to converge silently falls through to the cycle-break path, which does not just stop work but changes observable final state by force-clearing computations it heuristically judges cyclic. The failure mode is not a hang or a visible error; it is a computation silently cleared and a final state that is subtly wrong. This is the classic "bound work by count in a way that can abandon valid results," moved from the time axis to the iteration axis.

- **`runner/src/runtime.ts:688-695`, `Runtime.settled` (`maxRounds=50`).** The single most insidious member: on reaching its round cap it returns silently as if settled, masking non-convergence as success. This turns a latent flake into an invisible one.

- **`runner/src/pattern-manager.ts:1363-1399`, `writeBackCompileCache`.** An `editWithRetry` with a data-sized retry budget of `2 * edges + 8`, floor 16 — a magic arithmetic formula encoding a storage-engine invariant (each commit surfaces only one stale read). An undersized budget was a real prior bug that degraded to endless recompiles.

- **The FUSE and memory debounces.** The hard-coded 150-millisecond debounce in `fuse/cell-bridge.ts:2812-2863`, the 25/500/10-millisecond constants in `fuse/mod.ts:1753-1771`, and the 5-millisecond fan-out debounce in `memory/v2/server.ts:2489-2500`. In each case the code already knows what a proper signal would be — `runtime.idle`, an `idle()`/`flushSessions()` drain hook — and the magic constant is a placeholder for a signal not yet wired up.

The fix vocabulary already exists in the runner: `runtime.idle`, drain hooks, and subscriptions on cells the code already resolves. The recommendation is also to make silent caps loud, so exhaustion emits a diagnostic rather than masquerading as success.

### 4.3 Archetype C — polling stands in for a completion signal (test flakiness)

Rarely a production correctness bug; the dominant source of flaky tests.

- **`runner/test/memory-v2-subscription.test.ts:61-72`, the `waitFor` combinator — the continuous-integration time bomb.** A poll-with-deadline loop: a 250-millisecond deadline and a 5-millisecond poll interval, roughly 50 wakeups per wait. On an unloaded machine the condition resolves in a few polls; on an oversubscribed continuous-integration runner the same condition can take longer than 250 milliseconds purely from scheduling latency, producing a false timeout failure — a test that fails not because the code is wrong but because the machine was busy. The remedy already exists in a sibling file: the `whenDialed` signal-based barrier in the remote-session test.

- **The quiescence polls.** `memory/v2/server.ts:2512-2538`, `waitForConnectionQueuesToDrain`, a `while(true)` with double `Date.now()` deadline checks; `memory/v2/server.ts:2552-2609`, `refreshLoop`, a drain-then-drain-again loop whose termination depends on drain timeouts; and `html/src/debug.ts:238-244`, `viewSettled`, the exported test-synchronization primitive whose `setTimeout(0)` macrotask yield is essential for message delivery ordering but whose 50-pass escape hatch warns and proceeds when a view animates forever.

### 4.4 Hot-path performance

A few findings sit on genuinely hot paths where the timing choice affects throughput.

- **`packages/utils/src/sleep.ts:80-91`, `yieldToEventLoop` — the sharpest.** A hand-tuned fairness scheduler that blends posted-message yields with budgeted `setTimeout(0)` hops under an 8-millisecond wall-clock budget, using `performance.now()` to gate whether a timer hop is taken. The 8-millisecond budget and the depth-1 scheduling trick encode host-specific quirks (Deno's message-and-timer interleave, the browser's nested-timeout clamp) that are easy to break. The module-level `lastTimerTurnAt` is shared across all callers, so any refactor affects timer fairness everywhere the primitive is awaited. This is a cross-cutting hot-path invariant sitting on undocumented host behavior — dangerous to touch, central to whether long compute pipelines starve event delivery.

- **`fuse/cell-bridge.ts:1080-1170`, `schedulePropRebuild`.** A `setTimeout(0)` coalescing state machine that directly affects CPU and the observable freshness of the FUSE tree. The audit flags its hand-rolled three-map state machine (pending, active, and deferred rebuild maps) as a fragility smell that a single serialized async queue with a dirty flag would simplify.

### 4.5 The opposite failure: never giving up

`memory/v2/client.ts:365-397`, `Client.reconnect`, is the mirror image of the abandon-slow-work archetype: an indefinite retry loop, delay capped at 30 seconds, that only the `#closed` flag breaks. This is deliberate for a durable store, and its recovery path (replaying outstanding commits and restoring watches) is load-bearing. But there is no distinction between a transient outage and a fatal, stop-trying error, so a permanently-unreachable server or an authentication failure produces indefinite background reconnection rather than surfacing.

---

## 5. Recommendations and roadmap

The 686 findings sort into three fundamentally different populations, and the single most important framing is that **the runner already has a world-class completion-signal vocabulary; the job is to propagate it outward, not to invent new machinery.** The canonical worked example already in the repository is `runner/test/compile-cache-writeback-conflict.test.ts:159-203`, which documents a real bug fix: a naive retry loop re-ran immediately against stale state, and the remedy was to gate on the `readyToRetry` signal. Every cluster below should imitate that template.

### 5.1 What to leave alone

Applied naively, "reduce reliance on timers" would cause regressions in the load-bearing mechanisms. These should not be touched:

- The scheduler macrotask fence (`queueExecution`, `queueAnotherExecutionTick`): the `setTimeout(0)` is the ordering contract, not a smell.
- `editWithRetry` and the `runtime.idle()` / `settled()` / `synced()` barriers: already signal-driven and deterministic. This is the target pattern.
- The commit backpressure backoff: exponential backoff with jitter is the correct answer to conflict storms.
- The iteration caps as cycle-safety valves: count-based determinism is preferable to a wall-clock bound; only the magic numbers deserve review.
- The distributed lease time-to-live in `fetch-utils.ts`: no completion signal exists across runtimes to replace it.
- Production external-call deadlines (server shutdown, server-side-request-forgery bounds, model calls) and the AbortSignal cancellation plumbing: bounding external work you do not control is exactly what wall-clock timeouts are for.

The rule of thumb for reviewers: a timing construct is defensible when the wait resolves on an observable completion signal and any timer is only a backstop that fires when an external dependency misbehaves. It is a smell when correctness or freshness depends on the timer firing on schedule, or when a magic constant encodes an invariant that lives elsewhere.

### 5.2 Quick wins (do first — mechanical, high flake-reduction, low risk)

These share one shape and one fix, and they are the largest single lever on continuous-integration flakiness for the least risk.

- **The `waitFor` polling family (roughly 40-plus call sites).** In every one, a sink or subscriber callback already fires exactly when the awaited condition becomes true. Land one shared `signalWhen` / `waitForSignal` helper in the runner test utilities that resolves a one-shot promise from that callback, then migrate call sites in batches by file (not all in one pull request, so each is independently reviewable and revertible). The in-repo template is the `whenDialed` barrier. **Effort: low. Risk: low — tests only, and a mis-conversion fails loudly.**

- **The four near-identical SQLite settle loops** (`sqlite-cfc-label-link`, `sqlite-cfc-label`, `sqlite-cfc-row-label`, `sqlite-db-query-decode`). Add a completion promise to the `db.query` builtin (one small builtin change, the load-bearing part), then delete all four poll loops in a follow-up. This is the smallest "add a signal, remove four polls" demonstration and a good pilot for the broader philosophy. **Effort: low. Risk: low.**

### 5.3 Targeted structural work (moderate effort, real correctness upside)

- **Scheduler convergence magic numbers.** Do not de-timer these — they are already signal-driven. Instead: (1) make `Runtime.settled`'s silent exit at `maxRounds` loud, so it throws or emits a diagnostic rather than masking non-convergence as success — this is the single highest-value change in the cluster, because it turns a latent flake into a visible failure and may surface real non-convergence bugs; (2) centralize the constants (50, 10, 10, 100) into one named, documented `ConvergencePolicy` object; (3) leave the bounds count-based. **Effort: medium. Risk: medium-to-high for step 1 — schedule accordingly.**

- **UI polling for a missing reactive edge.** `cf-cfc-authorship.ts:798-822` polls up to 100 times (roughly 10 seconds) for a security-relevant "verified author" badge because the resolved cell is queried one-shot and not subscribed to; if the document is slow the badge silently stays unverified. `cf-tabs.ts:211-228` (duplicated in `cf-tab-bar`) re-schedules a requestAnimationFrame until a property is set, with a strict no-write rule to avoid a runtime settle-loop. The fix is to subscribe to the resolved cell instead of polling it, which makes both loops vanish. Prioritize the authorship badge above its raw severity because it is security-relevant and can silently fail; fix `cf-tabs` and `cf-tab-bar` together because they share duplicated logic. **Effort: medium. Risk: medium — the `cf-tabs` fix must preserve the write-free-during-sync invariant.**

### 5.4 Consolidation (medium structural, mostly de-duplication)

- **Pattern HTTP retry and backoff duplication.** Several hand-rolled retry-with-backoff loops across the Airtable and Google patterns (roughly ten). External HTTP legitimately needs backoff, so this is consolidation rather than de-timering: extract one shared `fetchWithRetry({ backoff, onAuthRefresh, signal })` helper so there is one well-tested implementation with consistent jitter and AbortSignal support instead of six variants. **Effort: low-to-medium. Risk: low.**

- **CLI, integration, and iframe-sandbox polling harnesses (roughly 30).** Two sub-populations. Runner-driven waits that poll a result cell should adopt `runtime.idle()` / `settled()` plus a cell-settled promise (a signal swap). Genuinely external waits (browser readiness, process death, iframe health) have no completion signal available, so polling is legitimate; for those, consolidate onto one `pollUntil({ deadline, interval, signal })` helper so the deadline and interval stop being scattered magic numbers. **Effort: low-to-medium. Risk: low.**

### 5.5 Deep structural work (high blast radius, schedule deliberately, gate behind a verification harness)

- **Memory server fan-out quiescence — the best deep-refactor investment.** The three coupled high findings in `memory/v2/server.ts:2489-2609` (`scheduleRefresh`, `waitForConnectionQueuesToDrain`, `refreshLoop`) all compensate for not having a single "all connections idle" event, and the team already fights the timer leaking across Deno test boundaries. Introduce a cross-connection aggregate idle signal — a counter of in-flight per-connection receives plus an `onAllConnectionsIdle` promise, mirroring the runner's settle-tracking accounting. Then the drain loop's re-scan and deadline disappear, the debounce becomes a microtask or explicit flush boundary (removing the 5-millisecond floor), and the convergence loop terminates on the aggregate signal rather than drain timeouts. This removes three coupled smells at once. **Effort: high. Risk: high — do not attempt piecemeal.**

- **Memory client reconnect terminal-error exit.** Add a terminal-error classification (mirroring the runner's permanent-versus-conflict rejection taxonomy) so fatal and authentication errors stop retrying instead of reconnecting forever. Leave the backoff and the macrotask ack-coalescing. **Effort: medium. Risk: medium — preserve the one-reconnect-at-a-time invariant.**

- **FUSE debounce de-timering.** The cluster splits sharply. De-timer candidates: the 150-millisecond debounce (replace with a `runtime.idle()`-gated rebuild) and the three-map `schedulePropRebuild` state machine (replace with one serialized async queue). Leave alone: the `scheduleFlush` and `writeCb` constants tuned to editor and Docker VirtioFS behavior (a platform workaround with no upstream flush signal), the reverse-invalidation drain gate (deadlock-avoidance against the kernel), and the epoch-keyed hydration retry (already the right clock-free shape). Do the two candidates as one focused pull request with write-then-read integration tests rewritten to await a real flush; add a comment at each irreducible timer explaining why it stays. **Effort: high. Risk: high.**

- **`yieldToEventLoop` — leave, but isolate and document.** The most subtle cross-cutting invariant in the audit. Do not redesign it. Centralize its constants and write a test that pins the interleave behavior so a future refactor has a guardrail.

### 5.6 A sequenced roadmap

1. **Phase 0 (low risk, immediate flake payoff):** the `waitFor` family and the SQLite settle loops.
2. **Phase 1 (targeted):** make `Runtime.settled` loud first (it will surface latent non-convergence while attention is on it), then centralize the convergence constants and do the UI subscription fixes, authorship badge prioritized.
3. **Phase 2 (consolidation):** the shared `fetchWithRetry` and `pollUntil` helpers.
4. **Phase 3 (deep, gated on a verification harness):** the memory-server aggregate-idle signal, then the reconnect terminal exit and the FUSE de-timering.
5. **Never, or document-only:** `yieldToEventLoop`, the FUSE platform and deadlock workarounds, the scheduler macrotask fence, the backpressure backoff, and the production external deadlines.

### 5.7 Cross-cutting recommendations

- **Codify the vocabulary.** Document `trackUntilSettled`, `readyToRetry`, and `idle` / `settled` / `synced` as the sanctioned building blocks so new code reaches for them instead of a `while (Date.now() < deadline)` poll.
- **A poll standing in for a callback is always a bug-in-waiting.** Make "resolve a promise from the callback" the reflexive pattern in test utilities.
- **Magic-number caps that change behavior on exhaustion must be named and loud.** Silent fall-through is the recurring trap.
- **Distinguish a timer-as-backstop from a timer-as-clock.** A timer that fires only when an external dependency misbehaves is healthy; a timer whose scheduled firing determines freshness or drop-versus-keep is the smell.
- **Introduce a deterministic virtual clock for the tests that must keep a timer.** The memory client test already uses Deno's `FakeTime` with `Math.random` pinned to zero to exercise backoff deterministically; extend that discipline to the remaining timer-dependent tests.

---

## 6. Meta-analysis and implications

### 6.1 What the aggregate pattern says about maturity

Read as a whole, this is a mature codebase that knows exactly what it is doing at its center and is honest about where it is improvising at its edges. The evidence is in the severity distribution — 494 of 686 findings are low or informational — and in the language of the findings themselves. The high-severity items are annotated by their own authors as "load-bearing" and "fragile," with cross-references to the bugs that motivated them (an undersized retry budget that caused endless recompiles, a settle-loop constraint that caused a runtime spin). A codebase that documents why its timers exist, names the invariants they protect, and keeps the count of genuinely-accidental sleeps near zero is not one that reached for `setTimeout` carelessly. It is one that fought its way to each timer and left a note.

### 6.2 The codebase's philosophy about time and completion

The deepest structural fact the audit reveals is a gradient. Reading from the reactive core outward:

- **At the very center (the scheduler), timing is structural and clock-free by preference.** Convergence is counted, retries gate on completion signals, and a single macrotask fence is the only "clock" — and it is the event loop's own tick, not the wall clock.
- **One ring out (the storage commit path, the memory client sequence gates), the code still prefers signals** but admits backoff spacing and give-up deadlines, because "keep believing convergence is possible" versus "declare failure" is a genuine policy question with no completion event.
- **At the network edge, signals disappear across a dropped connection,** forcing blind exponential backoff with jitter.
- **At the operating-system edge (FUSE) and the framework-property edge (requestAnimationFrame retry), the platform emits no completion signal at all,** and the code degrades to magic-number debounces and per-tick polling — the audit's most fragile constants.
- **At the sandbox, language-model, and subprocess edge, the only tool is a wall-clock deadline that cannot distinguish slow from stuck.**

The one-sentence conclusion the audit supports: **this system is a reactive core that is disciplined and largely clock-free at its center, and every timer of note is a scar marking a boundary where the outside world refused to tell it when something was done.** The high-severity findings are not sloppiness; they are the load-bearing improvisations at exactly those boundaries.

### 6.3 The testing culture, read from its timers

The test layer is a precise mirror of the production layer. Where production exposes a real signal (`idle`, `settled`, `updateComplete`, a sequence gate), the tests await it and are deterministic. Where it does not, the tests fall back to poll-and-sleep `waitFor` loops and become the audit's largest reservoir of flakiness. This is a strong and somewhat unusual finding: the distribution of test smells is not random, and it is not a comment on the discipline of the test authors. It is a faithful map of which production subsystems lack a completion signal. The `waitFor` in the memory subscription test is flaky for the same reason the FUSE bridge debounces on 150 milliseconds — both face a boundary that will not announce completion. Fixing the production signal fixes the test flake; the two are the same debt seen from two sides.

The encouraging half of this is that the repository already contains the counter-examples, in-tree, right next to the smells: the `whenDialed` barrier beside the polling `waitFor`, the `readyToRetry` regression test documenting the exact bug that poll-and-spin causes, and the `FakeTime` deterministic-clock discipline in the memory backoff test. The culture that produced the smell also produced its own antidote and left both in place.

### 6.4 The central tension: a reactive system that still leans on the wall clock

The honest tension worth naming is this. A reactive, event-driven runtime aspires to a world where nothing happens "after N milliseconds" — everything happens "when X becomes true." The audit shows that commontools comes remarkably close to that ideal at its core, and then is repeatedly forced to betray it at its edges. The betrayal is not a failure of will; it is a property of the boundaries. A kernel's virtual filesystem does not fire a "the editor finished saving" event. A language model does not promise "I will either answer or tell you I am stuck." A dropped socket does not signal "I will be back in 4 seconds." Against those partners, the wall clock is the only instrument available, and a deadline that cannot tell slow from stuck is the unavoidable cost of dealing with a partner that will not report its own progress.

The place this tension turns genuinely risky — and the one architectural line worth drawing in bold — is when a wall-clock deadline crosses from bounding latency into deciding correctness. The 30-second commit window is the exemplar: it is the one spot where the reactive core's own convergence guarantee is handed to a stopwatch, and it is therefore the one spot where a busy continuous-integration machine can turn a correct program into a dropped write. The clearest single improvement the audit points to is to keep pushing real completion signals — idle and settled hooks, subscribe-don't-poll, AbortSignal cancellation, forward-progress heartbeats — outward from the scheduler to the debounces, the frame-poll retries, and the deadline races that currently stand in for them, and above all to get the wall clock back out of the correctness decisions it has crept into.

---

## 7. Notable, surprising, or fun findings

- **The audit's thesis is a code comment.** `scheduler/pull-execution.ts:108-139` contains, verbatim, the question that the entire 686-instance audit is really about: "how do I know the reactive graph is done." The whole taxonomy is a set of answers to that one line.

- **A security badge that gives up after ten seconds.** `cf-cfc-authorship.ts:798-822` polls up to 100 times for a "verified author" badge because the resolved cell "is queried one-shot and is not subscribed to." If the document loads slowly, the badge silently stays unverified — a security-relevant signal whose correctness is gated on a bounded timer racing a document load.

- **A timer that measures how late timers are.** The event-loop-lag probe in `runtime-client/client/connection.ts:169-186` schedules a 100-millisecond timer and measures how much later than 100 milliseconds it actually fires, using the lateness as a read-out of main-thread blocking. It is `unref`'d so it never leaks or trips the operation-leak sanitizer — a self-correcting diagnostic that turns the event loop's own tardiness into a metric.

- **A liveness check that is turned off.** The iframe sandbox has a full Pong-driven health check with a 3-second timeout fallback (the `HealthCheck` class in `iframe-sandbox/src/health-check.ts`, whose timeout is a `sleep(timeout)` that throws `HealthCheckTimeout`), but it is disabled at its call site behind `HEALTH_CHECKING_ENABLED = false` (`common-iframe-sandbox.ts:22`, alongside `HEALTH_CHECK_TIMEOUT = 3000`), with the comment that the team "will not 'crash tabs' yet until things settle." A load-bearing safety mechanism, built and then deliberately parked.

- **The magic constants tuned to Docker.** `fuse/mod.ts:1753-1771` carries the constants 25, 500, and 10 milliseconds, tuned — per its own comments — to specific editor save behavior and Docker VirtioFS timing. It is the clearest single case of a correctness-adjacent timer that is a guess about someone else's software.

- **A retry budget that is a formula, not a number.** `pattern-manager.ts:1363-1399` sizes its retry budget as `2 * edges + 8` with a floor of 16, encoding a storage-engine invariant (one stale read surfaced per commit) as arithmetic. When the formula was undersized, it degraded to endless recompiles — a magic number that is a function of the data it is retrying over.

- **The best and worst retry loops are neighbors.** The exemplary signal-gated retry (`readyToRetry`) and the dangerous 30-second wall-clock drop-versus-converge gate live in the same `scheduler/events.ts` file, within a few hundred lines of each other — the mature pattern and the residual smell, side by side in the crown-jewel subsystem.

---

## 8. Appendix: methodology and coverage

**Corpus and selection.** The audit covered all tracked `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, and `.sh` source files — 3,711 in total — excluding the vendored `vendor-astral` package, the `*.expected.*` transformer golden fixtures, and ambient TypeScript library declaration files (which carry type signatures, not runnable code). A broad regular expression over the whole corpus surfaced 765 files touching any timing-adjacent token. These were narrowed to a deep-audit set of 527 files, defined as the union of files with strong-signal timer, retry, or sleep tokens; files using `Date.now()` or `performance.now()`; and files carrying subtle keyword-free control constructs (`Promise.race`, `AbortController`, `while(true)`, `waitFor`, and reconnect, quiesce, or settle idioms).

**Deep audit.** One hundred parallel agents each read their assigned files in full, located every instance — including keyword-free polling and rescheduling loops — classified it, and recorded the analysis dimensions used throughout this report (category, subtype, severity, load-bearing status, blast radius, and determinism risk).

**Excluded by design.** Uses of `Date.now()` or `performance.now()` purely as a data timestamp, an identifier or nonce, a log line, or a benchmark print — that is, not feeding any wait, abandon, or bound decision — were excluded, but noted per chunk so that nothing was silently dropped.

**Coverage completeness.** The aggregate statistics report a clean run: the `missing_chunks` and `parse_errors` lists in `_stats.json` are both empty, meaning every assigned chunk was audited and every finding parsed. The 527 audited files reconcile with the per-package counts, which sum to the reported 686 instances. The one structural gap to keep in mind is inherent to the selection method rather than a processing error: the corpus was filtered to files touching timing-adjacent tokens or subtle control constructs, so a timing decision expressed with no recognizable token and no `while(true)` / `Promise.race` / `waitFor` shape could in principle escape the net. The deep-audit agents were specifically tasked with catching keyword-free loops within the 527 selected files, which mitigates this within-file, but a file that contained only such a construct and matched none of the surfacing patterns would not have entered the 527-file set. Given the breadth of the surfacing regular expression (765 candidate files narrowed to 527), the residual risk is small, and no coverage gaps were flagged by the run itself.

**Package coverage.** All twenty-plus packages with timing instances are represented, from the 248-instance runner down to single-instance packages (`felt`, `js-compiler`, `lib-shell`, `state-inspector`, `ts-transformers`). The audit also covered non-package directories: `scripts` (12), `tasks` (13), `tools` (3), and `skills` (2).
