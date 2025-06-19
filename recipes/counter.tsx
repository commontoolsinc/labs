// deno-lint-ignore-file jsx-no-useless-fragment
import {
  derive,
  h,
  handler,
  ifElse,
  NAME,
  recipe,
  schema,
  str,
  UI,
} from "commontools";

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
  const odd = derive(cell.value, (value) => value % 2);
  derive(odd, (odd) => {
    console.log("odd", odd);
  });

  return {
    [NAME]: str`Simple counter: ${derive(cell.value, String)}`,
    [UI]: (
      <div>
        <ct-button onClick={decrement(cell)}>-</ct-button>
        <ul>
          {odd ? <h1>Odd</h1> : <h1>Even</h1>}
          <li>Ternary: {odd ? "odd" : "even"}</li>
          <li>IfElse: {ifElse(odd, "odd", "even")}</li>
        </ul>
        <ct-button onClick={increment(cell)}>+</ct-button>
      </div>
    ),
    value: cell.value,
  };
});
