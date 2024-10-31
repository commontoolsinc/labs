import {
  UI,
  NAME,
  lift,
  recipe,
} from "@commontools/common-builder";
import * as z from "zod";
import { h } from "@commontools/common-html";
import { datalogQuery } from "../query.js";

const stringify = lift(({ obj }) => {
  return JSON.stringify(obj, null, 2);
});

export const datalogQueryExample = recipe(
  z.object({ query: z.any() }),
  ({ query }) => {
    const { result: items } = datalogQuery(query)

    return {
      [NAME]: 'Datalog Query Playground',
      [UI]: <div>
        <pre>{stringify({ obj: items })}</pre>
      </div>,
      data: items,
      query,
    };
  },
);
