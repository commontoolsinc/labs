// deno-lint-ignore-file jsx-no-useless-fragment
import { derive, h, handler, NAME, recipe, schema, str, UI } from "commontools";

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

export default recipe(model, model, (cell) => {
  return {
    [NAME]: str`Simple counter: ${derive(cell.value, String)}`,
    [UI]: (
      <div>
        <button type="button" onClick={increment(cell)}>+</button>
        {/* use html fragment to test that it works  */}
        <>
          <b>{cell.value}</b>
        </>
        <button type="button" onClick={decrement(cell)}>-</button>
      </div>
    ),
    value: cell.value,
  };
});
