import type { MiddlewareHandler } from "@hono/hono";
import { verifyFirstPartyHttpRequest } from "@commonfabric/runner/toolshed-http-auth";
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
