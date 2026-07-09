import type { MiddlewareHandler } from "@hono/hono";
import { verifyFirstPartyHttpRequest } from "@commonfabric/runner/toolshed-http-auth";
import { trace } from "@opentelemetry/api";
import type { AppBindings } from "@/lib/types.ts";

export function requireFirstPartyHttpAuth(): MiddlewareHandler<
  AppBindings
> {
  return async (c, next) => {
    try {
      const { userDid } = await verifyFirstPartyHttpRequest({
        request: c.req.raw,
      });
      c.set("verifiedUserDid", userDid);
      // Enrich the active request span (started by the otel middleware, which
      // runs earlier in the chain) with the verified user. Defensive: no-op if
      // no span/provider is active.
      trace.getActiveSpan()?.setAttribute("user.did", userDid);
      // TODO(auth): Check that the verified DID is authorized for this privileged route before continuing.
    } catch (error) {
      const logger = c.get("logger");
      logger.warn(
        {
          path: c.req.path,
          method: c.req.method,
          error: error instanceof Error ? error.message : String(error),
        },
        "Rejected unauthenticated first-party HTTP request",
      );
      return c.json({ error: "Unauthorized" }, 401);
    }
    await next();
  };
}
