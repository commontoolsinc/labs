export const MAX_ITERATIONS_PER_RUN = 100;
export const MAX_SETTLE_STATS_HISTORY = 20;
export const MAX_TRIGGER_TRACE_HISTORY = 400;
export const MAX_ACTION_RUN_TRACE_HISTORY = 2000;
export const MAX_RETRIES_FOR_REACTIVE = 10;
export const AUTO_DEBOUNCE_THRESHOLD_MS = 50;
export const AUTO_DEBOUNCE_MIN_RUNS = 3;
export const AUTO_DEBOUNCE_DELAY_MS = 100;

// Cycle-aware debounce: applies adaptive debounce to actions cycling within one execute()
export const CYCLE_DEBOUNCE_THRESHOLD_MS = 100; // Min iteration time to trigger cycle debounce
export const CYCLE_DEBOUNCE_MIN_RUNS = 3; // Action must run this many times to be considered cycling
export const CYCLE_DEBOUNCE_MULTIPLIER = 2; // Debounce delay = multiplier x iteration time
