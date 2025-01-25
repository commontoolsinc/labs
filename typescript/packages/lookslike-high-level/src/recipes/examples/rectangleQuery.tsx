import { h } from "@commontools/html";
import {
  UI,
  NAME,
  lift,
  recipe,
} from "@commontools/builder";
import * as z from "zod";
import { zodSchemaQuery } from "../../query.js";

export const schema = z.object({
  width: z.string(),
  height: z.string(),
  backgroundColor: z.string(),
  border: z.string(),
});

const tap = lift((x) => {
  console.log("poly", x, JSON.stringify(x, null, 2));
  return x;
});

export const rectangleQuery = recipe(z.object({}), ({}) => {
  const { result: items, query } = zodSchemaQuery(schema);
  tap({ obj: items });

  const getInlineStyles = lift(
    ({ style }) =>
      `width: ${style.width}; height: ${style.height}; background-color: ${style.backgroundColor}; border: ${style.border}`,
  );

  return {
    [NAME]: "Rectangle query",
    [UI]: (
      <div style="display: flex; flex-direction: row; flex-wrap: wrap">
        {items.map((item) => (
          <div style={getInlineStyles({ style: item })} />
        ))}
      </div>
    ),
    data: items,
    query,
  };
});
