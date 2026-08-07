import type { MiddlewareHandler } from "@hono/hono";
import { getConnInfo } from "@hono/hono/deno";
import type { AppBindings } from "@/lib/types.ts";
import env from "@/env.ts";
import { createRateLimiter, type RateLimiter } from "@/lib/rate-limit.ts";

/**
 * Rate limiting keyed by CLIENT ADDRESS.
 *
 * Not by caller DID: a DID is a free, freshly-generated keypair, so every
 * bucket would start full. `X-Forwarded-For` is consulted only when the
 * deployment declares a trusted proxy (`RATE_LIMIT_TRUST_FORWARDED_FOR`),
 * because there is no way to tell a proxy-set header from a client-set one —
 * and either mistake is total. Trusting a spoofable header makes the limiter a
 * no-op; ignoring a real proxy collapses every caller onto one bucket and lets
 * one client starve the deployment.
 */
export const clientKey = (
  c: { req: { header: (name: string) => string | undefined } },
): string => {
  if (env.RATE_LIMIT_TRUST_FORWARDED_FOR) {
    const forwarded = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
    if (forwarded) return forwarded;
  }
  try {
    // deno-lint-ignore no-explicit-any
    return getConnInfo(c as any).remote.address ?? "unknown";
  } catch {
    return "unknown";
  }
};

/**
 * Mount ahead of the work being protected — and, where the route authenticates,
 * ahead of that too, so an unauthenticated flood is bounded before it costs a
 * signature verification.
 */
export function rateLimit(
  limiter: RateLimiter,
): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    if (!limiter.take(clientKey(c))) {
      return c.json({ error: "Too many requests" }, 429);
    }
    await next();
  };
}

export { createRateLimiter };
