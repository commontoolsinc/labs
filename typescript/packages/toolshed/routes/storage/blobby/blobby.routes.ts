import { z } from "zod";
import { createRoute } from "@hono/zod-openapi";
import { jsonContent } from "stoker/openapi/helpers";
import * as HttpStatusCodes from "stoker/http-status-codes";

const tags = ["Blobby Storage"];

const BlobResponseSchema = z.object({
  key: z.string(),
});

const BlobListResponseSchema = z.object({
  blobs: z.array(z.string()),
});

const BlobDataResponseSchema = z.record(z.any());

export const uploadBlob = createRoute({
  method: "post",
  path: "/api/storage/blobby/{key}",
  tags,
  request: {
    params: z.object({
      key: z.string(),
    }),
    body: {
      content: {
        "application/json": {
          schema: z.any(),
        },
      },
    },
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      BlobResponseSchema,
      "Successfully uploaded blob",
    ),
  },
});

export const getBlob = createRoute({
  method: "get",
  path: "/api/storage/blobby/{key}",
  tags,
  request: {
    params: z.object({
      key: z.string(),
    }),
  },
  responses: {
    [HttpStatusCodes.OK]: {
      content: {
        "application/json": {
          schema: z.any(),
        },
      },
      description: "Blob content",
    },
    [HttpStatusCodes.NOT_FOUND]: {
      description: "Blob not found",
    },
  },
});

export const getBlobPath = createRoute({
  method: "get",
  path: "/api/storage/blobby/{key}/:path{.+}",
  tags,
  request: {
    params: z.object({
      key: z.string(),
      path: z.string(),
    }),
  },
  responses: {
    [HttpStatusCodes.OK]: {
      content: {
        "application/json": {
          schema: z.any(),
        },
      },
      description: "Blob path content",
    },
    [HttpStatusCodes.NOT_FOUND]: {
      description: "Blob not found",
    },
  },
});

export const listBlobs = createRoute({
  method: "get",
  path: "/api/storage/blobby",
  tags,
  request: {
    query: z.object({
      all: z.string().optional(),
      allWithData: z.string().optional(),
      prefix: z.string().optional(),
      search: z.string().optional(),
      keys: z.string().optional(),
    }),
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      z.union([BlobListResponseSchema, BlobDataResponseSchema]),
      "List of blobs",
    ),
    [HttpStatusCodes.INTERNAL_SERVER_ERROR]: {
      description: "Internal server error",
      content: {
        "application/json": {
          schema: z.object({
            error: z.string(),
          }),
        },
      },
    },
  },
});

export const deleteBlob = createRoute({
  method: "delete",
  path: "/api/storage/blobby/{key}",
  tags,
  request: {
    params: z.object({
      key: z.string(),
    }),
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      z.object({
        success: z.boolean(),
      }),
      "Successfully deleted blob",
    ),
    [HttpStatusCodes.NOT_FOUND]: {
      description: "Blob not found",
    },
  },
});
