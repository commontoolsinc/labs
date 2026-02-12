import * as Clock from "./clock.ts";

/**
 * Default TTL is 1 hour.
 */
export const ttl = 60 * 60;

/**
 * Default clock uses 10sec accuracy so that it's more stable
 * in CI environments.
 */
export const clock = Clock.default.with(10);

/**
 * Batch signing settings: accumulate invocations over a debounce window
 * and sign them all with one Ed25519 signature.
 */
export const batchDebounceMs = 20;
export const batchMaxAccumulateMs = 1000;
export const batchMaxSize = 50;
