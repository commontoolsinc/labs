export const MAX_ITERS = 10;
// A node runs at most once per settle iteration, so its per-pass run count is
// bounded by MAX_ITERS by construction. The budget is a backstop against any
// multi-run-per-iteration path — NOT a depth limit: first-run materialization
// of a discovered-dependency chain legitimately re-runs every downstream node
// once per level (one level unrolls per iteration), so a budget below
// MAX_ITERS misclassifies deep healthy chains as cycling and defers their
// still-never-ran frontier past idle() (see scheduler-convergence
// "materializes a discovered-dependency chain deeper than the pass budget").
export const PASS_RUN_BUDGET = MAX_ITERS;
export const BACKOFF_BASE_MS = 250;
export const BACKOFF_MAX_MS = 2000;

// How many consecutive convergence-backoff passes an idle() waiter is held
// across before the escape valve releases it. While a live subgraph keeps
// hitting the settle cap, a deferred re-run of an already-ran demanded
// computation (or a deferred effect) blocks idle() so a genuinely converging —
// but slow (> MAX_ITERS levels) — wave is observed AFTER it settles rather than
// mid-flight (the F1 early-resolution bug). But a truly non-converging (cyclic)
// subgraph never settles, so after this many backoff passes idle() resolves
// regardless (scheduler.non-settling telemetry has already fired) to keep the
// system responsive. The bound is applied to each node's episode-local
// `convergenceHoldPasses`, so a permanently non-settling subgraph cannot
// release idle() for unrelated work. The hold count resets when that idle
// episode ends; the separate delay streak remains rate-limited until the node
// finishes genuinely clean. Three passes cover the known healthy >MAX_ITERS convergence case while
// keeping a true cycle's idle escape below one second on the 250/500/1000ms
// backoff curve. Longer convergence continues behind scheduled wakes, as I6
// requires for gated work.
export const CONVERGENCE_IDLE_HOLD_MAX_BACKOFF_PASSES = 3;
export const MAX_SETTLE_STATS_HISTORY = 20;
export const MAX_TRIGGER_TRACE_HISTORY = 400;
export const MAX_ACTION_RUN_TRACE_HISTORY = 2000;
// W4 (timing side-channel): the maximum number of pending events one stream may
// hold for one handler before further enqueues collapse into the last pending
// entry (last-wins). Bounds the post-block backlog a pattern can observe as an
// event count, so the "block-and-count" timer cannot grow without limit. Well
// above any normal burst, so it never changes ordinary delivery.
export const MAX_EVENT_BACKLOG_PER_STREAM = 256;
export const MAX_RETRIES_FOR_REACTIVE = 10;
// A stale-basis rejection (conflict / same-replica race) is retried off the
// bounded budget, on the assumption that the action's subscription will
// eventually deliver the value it is waiting on. That holds for pattern-created
// reactive functions, which go through the cell machinery, but a bug that never
// closes the loop — historically a serialization round-trip that fails to
// preserve a value (a stray `-0`, say) — would spin here forever. Emit a
// non-fatal diagnostic every this-many off-budget re-queues of one action so the
// loop is visible rather than silent.
export const OFF_BUDGET_RETRY_WARN_INTERVAL = 100;
export const AUTO_DEBOUNCE_THRESHOLD_MS = 50;
export const AUTO_DEBOUNCE_MIN_RUNS = 3;
export const AUTO_DEBOUNCE_DELAY_MS = 100;

// How long a resumed action's initial run may be held while waiting for its
// space to finish syncing (see runner.ts awaitSyncBeforeInitialRun). This hold
// covers the flag-off path and the flag-on fallback for a missing, stale, or
// ineligible observation (including always-run coordinators). A successfully
// rehydrated action needs no hold.
// The sync completing releases the hold early; the
// timeout only bounds a slow or never-quiescing sync. The hold is an
// anti-churn OPTIMIZATION (avoid re-deriving against half-synced inputs), not
// a correctness gate — reads see whatever has synced either way — so its
// worst case must stay cheap: space-wide synced() is unbounded on a busy
// space, and a large cap turns every resumed action into a long stall
// (observed: CI's slow runners quantized second-navigation boots to ~10s and
// starved a 30s UI-commit wait; see lunch-poll-vote integration failure).
export const INITIAL_RUN_SYNC_HOLD_TIMEOUT_MS = 2_000;

/**
 * Action-timing stats entries kept before the least recently run is dropped.
 * An action id names one action INSTANCE, not one piece of source, so a
 * pattern that keeps creating actions — a list projecting a window that moves
 * over a long list makes a fresh set every time the window moves — adds ids
 * without ever reusing them. Auto debounce and the scheduler graph read these,
 * and both concern actions that are still running, so the least recently run
 * entry is the one to lose.
 */
export const MAX_ACTION_STATS = 20_000;
