import * as Clock from "./clock.ts";
import { RateLimitingOptions } from "./interface.ts";

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
 * Rate limiting configuration
 */
export const rateLimiting: RateLimitingOptions = {
  baseThreshold: 100,
  requestLimit: 10,
  backoffFactor: 50,
  maxDebounceCount: 17,
};
