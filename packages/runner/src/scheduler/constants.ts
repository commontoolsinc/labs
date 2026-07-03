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
export const MAX_SETTLE_STATS_HISTORY = 20;
export const MAX_TRIGGER_TRACE_HISTORY = 400;
export const MAX_ACTION_RUN_TRACE_HISTORY = 2000;
export const DEFAULT_RETRIES_FOR_EVENTS = 5;
export const MAX_RETRIES_FOR_REACTIVE = 10;
export const AUTO_DEBOUNCE_THRESHOLD_MS = 50;
export const AUTO_DEBOUNCE_MIN_RUNS = 3;
export const AUTO_DEBOUNCE_DELAY_MS = 100;

// How long a resumed action's initial run may be held while waiting for its
// space to finish syncing (the flag-off resume hold; see runner.ts
// awaitSyncBeforeInitialRun). The sync completing releases the hold early; the
// timeout only bounds a slow or never-quiescing sync. The hold is an
// anti-churn OPTIMIZATION (avoid re-deriving against half-synced inputs), not
// a correctness gate — reads see whatever has synced either way — so its
// worst case must stay cheap: space-wide synced() is unbounded on a busy
// space, and a large cap turns every resumed action into a long stall
// (observed: CI's slow runners quantized second-navigation boots to ~10s and
// starved a 30s UI-commit wait; see lunch-poll-vote integration failure).
export const INITIAL_RUN_SYNC_HOLD_TIMEOUT_MS = 2_000;
