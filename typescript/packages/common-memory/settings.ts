import * as Clock from './clock.ts'

/**
 * Default TTL is 1 hour.
 */
export const ttl = 60 * 60;

/**
 * Default clock uses 10sec accuracy so that it's more stable
 * in CI environments.
 */
export const clock = Clock.default.with(10)

/**
 * Rate limiting configuration
 */
export const rateLimiting = {
  // Base threshold in milliseconds between requests
  baseThreshold: 100,
  // Number of requests allowed at base threshold before backoff starts
  requestLimit: 10,
  // Backoff factor for dynamic backoff calculation
  backoffFactor: 50,
  // Maximum debounce count (used in exponential backoff calculation)
  maxDebounceCount: 17
}
