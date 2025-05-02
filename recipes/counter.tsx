import { h } from "@commontools/html";
import {
  cell,
  derive,
  handler,
  ifElse,
  JSONSchema,
  NAME,
  recipe,
  schema,
  str,
  UI,
} from "@commontools/builder";

// Different way to define the same schema, using 'schema' helper function,
// let's as leave off `as const satisfies JSONSchema`.
const inputSchema = schema({
  type: "object",
  properties: {
    value: { type: "number", default: 0 },
  },
  default: { value: 0 },
});

const outputSchema = {
  type: "object",
  properties: {
    value: { type: "number", default: 0 },
  },
} as const satisfies JSONSchema;

const updateSchema = {
  type: "object",
  properties: {
    value: { type: "number", default: 0 },
  },
  title: "update values",
} as const satisfies JSONSchema;

const increment = handler(updateSchema, inputSchema, (_, state) => {
  debugger;
  console.log("increment");
  state.value = state.value + 1;
  console.log(state.value);
});

const decrement = handler(updateSchema, inputSchema, (_, state) => {
  console.log("decrement");
  state.value = state.value - 1;
});

const isOdd = (n: number) => n % 2 > 0;

export default recipe(inputSchema, outputSchema, (cell) => {
  return {
    [NAME]: str`Simple counter: ${derive(cell.value, String)}`,
    [UI]: (
      <div>
        <button type="button" onClick={increment(cell)}>+</button>
        <p>{cell.value}</p>
        {
          /* {ifElse(
          derive(cell.value, isOdd),
          <i>{cell.value}</i>,
          <b>{cell.value}</b>,
        )} */
        }
        <button type="button" onClick={decrement(cell)}>-</button>
      </div>
    ),
    value: cell.value,
  };
});
