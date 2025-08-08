import { createRoute } from "@hono/zod-openapi";
import { z } from "zod";
import { jsonContent } from "stoker/openapi/helpers";

export const createDoc = createRoute({
  method: "post",
  path: "/api/storage/new/v1/:space/docs",
  tags: ["storage-new"],
  request: {
    params: z.object({ space: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            docId: z.string(),
            branch: z.string().default("main"),
          }),
        },
      },
    },
  },
  responses: {
    200: jsonContent(
      z.object({ ok: z.boolean() }),
      "Created or existed",
    ),
  },
});

export const heads = createRoute({
  method: "get",
  path: "/api/storage/new/v1/:space/heads/:docId",
  tags: ["storage-new"],
  request: {
    params: z.object({ space: z.string(), docId: z.string() }),
    query: z.object({ branch: z.string().default("main") }),
  },
  responses: {
    200: jsonContent(
      z.object({
        docId: z.string(),
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
  path: "/api/storage/new/v1/:space/tx",
  tags: ["storage-new"],
  request: {
    params: z.object({ space: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            reads: z.array(z.object({
              ref: z.object({ docId: z.string(), branch: z.string() }),
              heads: z.array(z.string()),
            })),
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
      z.object({ ok: z.boolean(), receipt: z.any() }),
      "Tx receipt",
    ),
  },
});
