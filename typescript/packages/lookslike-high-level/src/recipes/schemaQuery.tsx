import { UI, NAME, lift, recipe } from "@commontools/builder";
import * as z from "zod";
import { jsonSchemaQuery } from "../query.js";
import { h } from "@commontools/html";

const stringify = lift(({ obj }) => {
  return JSON.stringify(obj, null, 2);
});

export const schemaQueryExample = recipe(
  z.object({ schema: z.any() }).describe("JSON Schema Query Playground"),
  ({ schema }) => {
    const { result: items, query } = jsonSchemaQuery(schema);

    return {
      [NAME]: "JSON Schema Query Playground",
      [UI]: (
        <div>
          <pre>{stringify({ obj: items })}</pre>
        </div>
      ),
      data: items,
      query,
    };
  },
);
