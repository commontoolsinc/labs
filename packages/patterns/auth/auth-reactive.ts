/**
 * Shared time utilities for OAuth auth patterns.
 */
import { safeDateNow, Writable } from "commontools";

/**
 * Refresh a Writable cell with a current-time snapshot.
 *
 * SES compartments do not endow timer globals, so pattern code cannot safely
 * schedule its own clock ticks. Until we introduce a dedicated reactive time
 * capability, auth UIs fall back to a snapshot value.
 */
export function startReactiveClock(
  cell: Writable<number>,
  intervalMs = 30_000,
): void {
  if (typeof setInterval === "function") {
    setInterval(() => cell.set(safeDateNow()), intervalMs);
  }
}

/** Token expiry threshold (10 minutes) — used for both refresh gating and UI warnings */
export const TOKEN_EXPIRY_THRESHOLD_MS = 10 * 60 * 1000;

/** @deprecated Use TOKEN_EXPIRY_THRESHOLD_MS instead */
export const REFRESH_THRESHOLD_MS = TOKEN_EXPIRY_THRESHOLD_MS;

/** @deprecated Use TOKEN_EXPIRY_THRESHOLD_MS instead */
export const TOKEN_WARNING_THRESHOLD_MS = TOKEN_EXPIRY_THRESHOLD_MS;
