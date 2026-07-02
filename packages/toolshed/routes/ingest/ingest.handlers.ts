// The `journal`-sink ingest handler — a thin transport wrapper. It pulls the
// bearer token and JSON body off the request, then delegates to processIngest
// (ingest.utils.ts), whose full auth + validation contract is unit-tested
// against a real runtime. Auth mirrors the webhook ingest path.
//
// Iteration 1: ingest only. There is no self-serve create/list/delete endpoint,
// so the confused-deputy risk of an unauthed create (registering a channel that
// targets someone else's space) does not exist here — channels are provisioned
// out-of-band by an operator. See the design proposal.
import type { AppRouteHandler } from "@/lib/types.ts";
import { runtime } from "@/index.ts";
import { identity } from "@/lib/identity.ts";
import { processIngest } from "./ingest.utils.ts";
import type { IngestRoute } from "./ingest.routes.ts";

export const ingest: AppRouteHandler<IngestRoute> = async (c) => {
  const logger = c.get("logger");
  const { id } = c.req.param();

  // Extract the bearer token FIRST, before any storage lookup.
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return c.json({ error: "Invalid request" }, 401);
  }
  const token = authHeader.slice(7);

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const result = await processIngest(
    runtime,
    identity.did(),
    id,
    token,
    body,
    logger,
  );
  if (result.status === 200) return c.json(result.body, 200);
  return c.json(result.body, result.status);
};
