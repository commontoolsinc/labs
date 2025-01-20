import { createRoute } from "@hono/zod-openapi";
import * as HttpStatusCodes from "stoker/http-status-codes";
import { jsonContent } from "stoker/openapi/helpers";
import {
  ProcessSchemaResponseSchema,
  ProcessSchemaRequestSchema,
} from "./spell.handlers.ts";

const tags = ["Spellcaster"];

export const imagine = createRoute({
  path: "/ai/spell/imagine",
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

export type ProcessSchemaRoute = typeof imagine;
