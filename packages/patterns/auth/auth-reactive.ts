/**
 * Shared reactive utilities for OAuth auth patterns.
 */
import { Writable } from "commonfabric";

/**
 * Start a reactive clock that updates a Writable cell with safeDateNow()
 * at a fixed interval. This makes time-dependent computeds reactive.
 *
 * TODO(CT-1163): Replace with wish("#now:30000") when reactive time wish is available.
 * safeDateNow() is the current explicit snapshot helper for authored patterns.
 * Interval is intentionally never cleared — pattern lifecycle matches page lifecycle.
 */
export function startReactiveClock(
  _cell: Writable<number>,
  _intervalMs = 30_000,
): void {
  // SES does not expose timers inside authored modules yet.
  // Leave the initial snapshot in place until a reactive time source exists.
}

/** Token expiry threshold (10 minutes) — used for both refresh gating and UI warnings */
export const TOKEN_EXPIRY_THRESHOLD_MS = 600_000;

/** @deprecated Use TOKEN_EXPIRY_THRESHOLD_MS instead */
export const REFRESH_THRESHOLD_MS = TOKEN_EXPIRY_THRESHOLD_MS;

/** @deprecated Use TOKEN_EXPIRY_THRESHOLD_MS instead */
export const TOKEN_WARNING_THRESHOLD_MS = TOKEN_EXPIRY_THRESHOLD_MS;
