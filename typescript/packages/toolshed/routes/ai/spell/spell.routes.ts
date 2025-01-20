import { createRoute } from "@hono/zod-openapi";
import * as HttpStatusCodes from "stoker/http-status-codes";
import { jsonContent } from "stoker/openapi/helpers";
import {
  ProcessTextResponseSchema,
  ProcessTextRequestSchema,
  ProcessSchemaResponseSchema,
  ProcessSchemaRequestSchema,
} from "./spell.handlers.ts";

const tags = ["Spell"];

export const processText = createRoute({
  path: "/spell/process-text",
  method: "post",
  tags,
  request: {
    body: {
      content: {
        "application/json": {
          schema: ProcessTextRequestSchema,
        },
      },
    },
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      ProcessTextResponseSchema,
      "The processed text result",
    ),
  },
});

export const processSchema = createRoute({
  path: "/spell/process-schema",
  method: "post",
  tags,
  request: {
    body: {
      content: {
        "application/json": {
          schema: ProcessSchemaRequestSchema,
        },
      },
    },
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      ProcessSchemaResponseSchema,
      "The processed schema result",
    ),
  },
});

export type ProcessTextRoute = typeof processText;
export type ProcessSchemaRoute = typeof processSchema;
