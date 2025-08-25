import { createRoute } from "@hono/zod-openapi";
import { z } from "zod";
import { jsonContent } from "stoker/openapi/helpers";

const tags: string[] = ["storage-new"];

export const heads = createRoute({
  method: "get",
  path: "/spaces/:spaceId/docs/:docId/branches/:branchId/heads",
  tags,
  request: {
    params: z.object({
      spaceId: z.string(),
      docId: z.string(),
      branchId: z.string(),
    }),
  },
  responses: {
    200: jsonContent(
      z.object({
        doc: z.string(), // doc:<ref>
        branch: z.string(),
        heads: z.array(z.string()),
        seq_no: z.number(),
        epoch: z.number(),
        root_ref: z.string().optional(),
      }),
      "Current heads",
    ),
  },
});

export const tx = createRoute({
  method: "post",
  path: "/spaces/:spaceId/tx",
  tags,
  request: {
    params: z.object({ spaceId: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            clientTxId: z.string().optional(),
            reads: z.array(z.object({
              ref: z.object({ docId: z.string(), branch: z.string() }),
              heads: z.array(z.string()),
            })).default([]),
            writes: z.array(z.object({
              ref: z.object({ docId: z.string(), branch: z.string() }),
              baseHeads: z.array(z.string()),
              changes: z.array(z.string()), // base64 strings
            })),
          }),
        },
      },
    },
  },
  responses: {
    200: jsonContent(
      z.object({
        receipt: z.object({
          txId: z.number(),
          committedAt: z.string(),
          results: z.array(z.object({
            ref: z.object({ docId: z.string(), branch: z.string() }),
            status: z.enum(["ok", "conflict", "rejected"]),
            newHeads: z.array(z.string()).optional(),
            applied: z.number().optional(),
            reason: z.string().optional(),
          })),
          conflicts: z.array(z.any()),
        }),
      }),
      "Tx receipt",
    ),
  },
});

export const pit = createRoute({
  method: "get",
  path: "/spaces/:spaceId/pit",
  tags,
  request: {
    params: z.object({ spaceId: z.string() }),
    query: z.object({
      docId: z.string(),
      branchId: z.string(),
      seq: z.coerce.number(),
      accept: z.enum(["automerge", "json"]).optional(),
    }),
  },
  responses: {
    200: {
      description: "Point-in-time document bytes or JSON",
    },
  },
});

export const query = createRoute({
  method: "post",
  path: "/spaces/:spaceId/query",
  tags,
  request: {
    params: z.object({ spaceId: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            query: z.object({}).passthrough(),
          }),
        },
      },
    },
  },
  responses: {
    200: jsonContent(z.object({ rows: z.array(z.any()) }), "Query results"),
  },
});

export const subscribe = createRoute({
  method: "get",
  path: "/:spaceId/ws",
  tags,
  request: {
    params: z.object({ spaceId: z.string() }),
  },
  responses: {
    200: { description: "WebSocket upgrade" },
  },
});

export const snapshot = createRoute({
  method: "get",
  path: "/spaces/:spaceId/snapshots/:docId/:branchId/:seq",
  tags,
  request: {
    params: z.object({
      spaceId: z.string(),
      docId: z.string(),
      branchId: z.string(),
      seq: z.coerce.number(),
    }),
  },
  responses: {
    200: { description: "Snapshot/PIT bytes" },
  },
});

export const mergeInto = createRoute({
  method: "post",
  path: "/spaces/:spaceId/docs/:docId/branches/:from/merge-into/:to",
  tags,
  request: {
    params: z.object({
      spaceId: z.string(),
      docId: z.string(),
      from: z.string(),
      to: z.string(),
    }),
  },
  responses: {
    200: jsonContent(z.object({ mergedHead: z.string() }), "Merged head hash"),
  },
});
