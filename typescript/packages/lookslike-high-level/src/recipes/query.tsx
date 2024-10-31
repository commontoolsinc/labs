import {
  UI,
  NAME,
  lift,
  recipe,
} from "@commontools/common-builder";
import * as z from "zod";
import { querySynopsys } from "../query.js";
import { h } from "@commontools/common-html";

const stringify = lift(({ obj }) => {
  return JSON.stringify(obj, null, 2);
});

export const query = recipe(
  z.object({ schema: z.any() }),
  ({ schema }) => {
    const { result: items, query } = querySynopsys(schema)

    return {
      [NAME]: 'generic query',
      [UI]: <div>
        <pre>{stringify({ obj: items })}</pre>
      </div>,
      data: items,
      query,
    };
  },
);
