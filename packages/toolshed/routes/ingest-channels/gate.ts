import type { MiddlewareHandler } from "@hono/hono";
import type { AppBindings } from "@/lib/types.ts";

/**
 * The self-serve opt-in gate, mirroring the memory-dump router: when the
 * deployment has not enabled self-serve, every verb 404s as if the routes never
 * existed rather than 403-ing. An endpoint that is not meant to be reachable
 * should not advertise itself.
 *
 * Takes the flag as an argument rather than reading `env` itself, so the router
 * and its test exercise the SAME middleware. `.env.test` enables the feature so
 * the other suites can reach the handlers, so a gate that closed over `env`
 * could only ever be tested through a hand-written copy — and a copy pins the
 * copy.
 */
export const ingestGate =
  (enabled: boolean): MiddlewareHandler<AppBindings> => async (c, next) => {
    if (!enabled) return c.notFound();
    await next();
  };
