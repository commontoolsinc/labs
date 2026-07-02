import { createRoute } from "@hono/zod-openapi";
import * as HttpStatusCodes from "stoker/http-status-codes";
import { z } from "zod";

const tags = ["Ingest"];

// POST /api/ingest/:id — the `journal` sink of a vouched ingest channel.
// An external, DID-less source (a phone beacon, a webhook) bearer-authenticates
// with its per-channel token and durably appends a batch of records to the
// channel's partition cell, each carrying the runtime-minted ExternalIngest
// mark. The body is parsed and validated in the handler (auth runs first), so
// no request body schema is declared here — mirroring the webhook ingest route.
export const ingest = createRoute({
  path: "/api/ingest/:id",
  method: "post",
  tags,
  request: {
    params: z.object({
      id: z.string().describe("Ingest channel ID"),
    }),
  },
  responses: {
    [HttpStatusCodes.OK]: {
      content: {
        "application/json": {
          schema: z.object({
            received: z.number(),
            appended: z.number(),
          }),
        },
      },
      description: "Records appended to the channel's partition cell",
    },
    [HttpStatusCodes.BAD_REQUEST]: {
      content: {
        "application/json": { schema: z.object({ error: z.string() }) },
      },
      description: "Invalid body or partition",
    },
    [HttpStatusCodes.UNAUTHORIZED]: {
      content: {
        "application/json": { schema: z.object({ error: z.string() }) },
      },
      description: "Invalid request",
    },
    [413]: {
      content: {
        "application/json": { schema: z.object({ error: z.string() }) },
      },
      description: "Batch too large",
    },
    [HttpStatusCodes.BAD_GATEWAY]: {
      content: {
        "application/json": { schema: z.object({ error: z.string() }) },
      },
      description: "Durable write failed",
    },
  },
});

export type IngestRoute = typeof ingest;
