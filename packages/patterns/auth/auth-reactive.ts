/**
 * Shared reactive utilities for OAuth auth patterns.
 */
import { Writable } from "commontools";

/**
 * Start a reactive clock that updates a Writable cell with Date.now()
 * at a fixed interval. This makes time-dependent computeds reactive.
 *
 * TODO(CT-1163): Replace with wish("#now:30000") when reactive time wish is available.
 * Date.now() is non-idiomatic (will be blocked in future sandbox versions).
 * Interval is intentionally never cleared — pattern lifecycle matches page lifecycle.
 */
export function startReactiveClock(
  cell: Writable<number>,
  intervalMs = 30_000,
): void {
  setInterval(() => cell.set(Date.now()), intervalMs);
}

/** Threshold: refresh when less than 10 minutes remain */
export const REFRESH_THRESHOLD_MS = 10 * 60 * 1000;

/** Token warning threshold (10 minutes) — same value, used in auth managers */
export const TOKEN_WARNING_THRESHOLD_MS = 10 * 60 * 1000;
