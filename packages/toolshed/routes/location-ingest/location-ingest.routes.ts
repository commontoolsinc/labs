import { createRoute } from "@hono/zod-openapi";
import * as HttpStatusCodes from "stoker/http-status-codes";
import { z } from "zod";

const tags = ["Location Ingest"];

// The presenter (the iOS beacon's install identity) self-signs an ordinary
// session.open against the location ingest channel space and POSTs it alongside
// the points. The endpoint verifies it via the unchanged
// verifySessionOpenAuthorization path (signature only; prf stays []), then the
// operator runtime durably appends the points under the ExternalIngest mark.
const sessionOpen = z.object({
  space: z.string().describe("The location ingest channel space DID"),
  session: z.object({
    sessionId: z.string().optional(),
    seenSeq: z.number().optional(),
  }).passthrough(),
  invocation: z.record(z.unknown()).optional(),
  authorization: z.unknown(),
}).passthrough();

const locationPoint = z.object({
  latitude: z.number(),
  longitude: z.number(),
  accuracy: z.number(),
  timestamp: z.number().describe(
    "Epoch millis the device captured the reading",
  ),
  altitude: z.number().optional(),
  altitudeAccuracy: z.number().optional(),
  heading: z.number().optional(),
  speed: z.number().optional(),
});

export const ingest = createRoute({
  path: "/api/location-ingest",
  method: "post",
  tags,
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            auth: sessionOpen.describe(
              "The presenter's self-signed session.open for the channel space",
            ),
            points: z.array(locationPoint).min(1),
          }),
        },
      },
    },
  },
  responses: {
    [HttpStatusCodes.OK]: {
      content: {
        "application/json": {
          schema: z.object({ appended: z.number() }),
        },
      },
      description: "Points durably appended under the ExternalIngest mark.",
    },
    [HttpStatusCodes.UNAUTHORIZED]: {
      content: {
        "application/json": { schema: z.object({ error: z.string() }) },
      },
      description: "session.open verification failed.",
    },
    [HttpStatusCodes.BAD_GATEWAY]: {
      content: {
        "application/json": { schema: z.object({ error: z.string() }) },
      },
      description: "Failed to persist the points.",
    },
  },
});

export type IngestRoute = typeof ingest;
