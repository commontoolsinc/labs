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
const model = schema({
  type: "object",
  properties: {
    value: { type: "number", default: 0, asCell: true },
  },
  default: { value: 0 },
});

const increment = handler({}, model, (_, state) => {
  state.value.set(state.value.get() + 1);
});

const decrement = handler({}, model, (_, state) => {
  state.value.set(state.value.get() - 1);
});

const isOdd = (n: number) => n % 2 > 0;

export default recipe(model, model, (cell) => {
  return {
    [NAME]: str`Simple counter: ${derive(cell.value, String)}`,
    [UI]: (
      <div>
        <button type="button" onClick={increment(cell)}>+</button>
        {/* <span>{derive(cell.value, String)}</p> */}

        {ifElse(
          derive(cell.value, isOdd),
          <i>{cell.value}</i>,
          <b>{cell.value}</b>,
        )}

        <button type="button" onClick={decrement(cell)}>-</button>
      </div>
    ),
    value: cell.value,
  };
});
