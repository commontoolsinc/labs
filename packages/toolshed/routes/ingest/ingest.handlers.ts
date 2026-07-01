// The `journal`-sink ingest handler. Auth is copied from the webhook ingest
// path (bearer -> registration lookup -> timing-safe verify with a dummy-hash
// timing-oracle guard). The write is a durable, ExternalIngest-marked append.
//
// Iteration 1: ingest only. There is no self-serve create/list/delete endpoint,
// so the confused-deputy risk of an unauthed create (registering a channel that
// targets someone else's space) does not exist here — channels are provisioned
// out-of-band by an operator. See the design proposal.
import type { AppRouteHandler } from "@/lib/types.ts";
import { runtime } from "@/index.ts";
import { identity } from "@/lib/identity.ts";
import {
  appendToJournal,
  getRegistration,
  isValidPartition,
  MAX_BATCH,
  verifyIngestSecret,
} from "./ingest.utils.ts";
import type { IngestRoute } from "./ingest.routes.ts";

const DUMMY_HASH = "0".repeat(64);

export const ingest: AppRouteHandler<IngestRoute> = async (c) => {
  const logger = c.get("logger");
  const { id } = c.req.param();

  // Extract the bearer token FIRST, before any storage lookup.
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return c.json({ error: "Invalid request" }, 401);
  }
  const token = authHeader.slice(7);

  // Storage errors must 502, not masquerade as 401.
  let registration: Awaited<ReturnType<typeof getRegistration>>;
  try {
    registration = await getRegistration(runtime, identity.did(), id);
  } catch (error) {
    logger.error(
      { error, id },
      "ingest: storage error looking up registration",
    );
    return c.json({ error: "Failed to process request" }, 502);
  }

  if (!registration || !registration.enabled) {
    // Match the real verification path to prevent a timing oracle on missing
    // or disabled channels.
    await verifyIngestSecret(token, DUMMY_HASH);
    return c.json({ error: "Invalid request" }, 401);
  }

  const valid = await verifyIngestSecret(token, registration.secretHash);
  if (!valid) {
    return c.json({ error: "Invalid request" }, 401);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const partition = (body as { partition?: unknown } | null)?.partition;
  const records = (body as { records?: unknown } | null)?.records;

  if (typeof partition !== "string" || !isValidPartition(partition)) {
    return c.json({ error: "Invalid or missing partition" }, 400);
  }
  if (
    !Array.isArray(records) ||
    records.length === 0 ||
    !records.every(
      (r) => r !== null && typeof r === "object" && !Array.isArray(r),
    )
  ) {
    return c.json(
      { error: "records must be a non-empty array of objects" },
      400,
    );
  }
  if (records.length > MAX_BATCH) {
    return c.json({ error: `Batch too large (max ${MAX_BATCH} records)` }, 413);
  }

  try {
    const appended = await appendToJournal(
      runtime,
      registration,
      partition,
      records as Record<string, unknown>[],
    );
    logger.info({ id, partition, appended }, "ingest: appended records");
    return c.json({ received: records.length, appended }, 200);
  } catch (error) {
    logger.error({ error, id, partition }, "ingest: failed to append records");
    return c.json({ error: "Failed to write records" }, 502);
  }
};
