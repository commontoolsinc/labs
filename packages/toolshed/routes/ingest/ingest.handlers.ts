// The `journal`-sink ingest handler — a thin transport wrapper. It pulls the
// bearer token and JSON body off the request, then delegates to processIngest
// (ingest.utils.ts), whose full auth + validation contract is unit-tested
// against a real runtime. Auth mirrors the webhook ingest path.
//
// This is the DATA plane only. Channel lifecycle lives at /api/ingest-channels
// (a separate prefix, separate auth model), where the confused-deputy risk of a
// create that names someone else's space is closed by requiring an explicit
// OWNER grant on that space's ACL. See
// docs/features/self-serve-ingest-channels.md.
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

  // Read the raw body but DON'T parse here — processIngest parses only after it
  // has verified the token, so a bad token can't be distinguished by body
  // validity (uniform 401 for bad/unknown/disabled/wrong-sink).
  const rawBody = await c.req.text();

  const result = await processIngest(
    runtime,
    identity.did(),
    id,
    token,
    rawBody,
    logger,
  );
  if (result.status === 200) return c.json(result.body, 200);
  return c.json(result.body, result.status);
};
