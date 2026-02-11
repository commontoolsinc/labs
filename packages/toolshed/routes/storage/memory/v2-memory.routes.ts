/**
 * Memory v2 OpenAPI Route Definitions
 *
 * Zod schemas and OpenAPI route definitions for the v2 memory protocol.
 * Routes are mounted at /api/storage/memory/v2.
 *
 * @module v2-memory.routes
 */

import { z } from "zod";
import { createRoute } from "@hono/zod-openapi";
import { jsonContent } from "stoker/openapi/helpers";
import * as HttpStatusCodes from "stoker/http-status-codes";

export const tags = ["Memory Storage V2"];

// ---------------------------------------------------------------------------
// Shared schemas
// ---------------------------------------------------------------------------

const EntityId = z.string().describe("Entity ID (e.g. urn:entity:abc123)");
const SpaceId = z.string().describe("Space DID");

const UserOperation = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("set"),
    id: EntityId,
    value: z.any(),
  }),
  z.object({
    op: z.literal("patch"),
    id: EntityId,
    patches: z.array(z.any()),
  }),
  z.object({
    op: z.literal("delete"),
    id: EntityId,
  }),
  z.object({
    op: z.literal("claim"),
    id: EntityId,
  }),
]);

const ConfirmedRead = z.object({
  id: EntityId,
  hash: z.string(),
  version: z.number(),
});

const PendingRead = z.object({
  id: EntityId,
  hash: z.string(),
  fromCommit: z.string(),
});

// ---------------------------------------------------------------------------
// Request bodies
// ---------------------------------------------------------------------------

const TransactBody = z.object({
  cmd: z.literal("/memory/transact"),
  sub: SpaceId,
  args: z.object({
    reads: z.object({
      confirmed: z.array(ConfirmedRead),
      pending: z.array(PendingRead),
    }),
    operations: z.array(UserOperation),
    branch: z.string().optional(),
    codeCID: z.string().optional(),
  }),
});

const QueryBody = z.object({
  cmd: z.literal("/memory/query"),
  sub: SpaceId,
  args: z.object({
    select: z.record(z.string(), z.any()),
    since: z.number().optional(),
    branch: z.string().optional(),
  }),
});

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export const transact = createRoute({
  method: "patch",
  path: "/api/storage/memory/v2",
  tags,
  request: {
    body: {
      content: {
        "application/json": {
          schema: TransactBody,
        },
      },
    },
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      z.object({ ok: z.any() }),
      "Successful transaction",
    ),
    [HttpStatusCodes.CONFLICT]: jsonContent(
      z.object({
        error: z.object({
          name: z.literal("ConflictError"),
          conflicts: z.array(z.any()),
          message: z.string(),
        }),
      }),
      "Conflict occurred",
    ),
    [HttpStatusCodes.INTERNAL_SERVER_ERROR]: jsonContent(
      z.object({
        error: z.object({
          name: z.string(),
          message: z.string(),
          stack: z.string().optional(),
        }),
      }),
      "Server error",
    ),
  },
});

export const query = createRoute({
  method: "post",
  path: "/api/storage/memory/v2",
  tags,
  request: {
    body: {
      content: {
        "application/json": {
          schema: QueryBody,
        },
      },
    },
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      z.object({ ok: z.any() }),
      "Query results",
    ),
    [HttpStatusCodes.INTERNAL_SERVER_ERROR]: jsonContent(
      z.object({
        error: z.object({
          name: z.string(),
          message: z.string(),
          stack: z.string().optional(),
        }),
      }),
      "Server error",
    ),
  },
});

export const subscribe = createRoute({
  method: "get",
  path: "/api/storage/memory/v2",
  tags,
  request: {
    headers: z.object({
      connection: z.string().regex(/(^|\s*,\s*)Upgrade(\s*,\s*|$)/i),
      upgrade: z
        .string()
        .regex(/(^|\s*,\s*)websocket(\/[^,]+)?(\s*,\s*|$)/i),
    }),
  },
  responses: {
    [HttpStatusCodes.OK]: {
      headers: z.object({
        connection: z.literal("Upgrade"),
        upgrade: z.literal("websocket"),
        "sec-websocket-accept": z.string(),
        date: z.string(),
      }),
      description: "WebSocket upgrade",
    },
    [HttpStatusCodes.INTERNAL_SERVER_ERROR]: {
      description: "Upgrade to websocket failed",
    },
  },
});
