import {
  Cell,
  derive,
  h,
  handler,
  ifElse,
  JSONSchema,
  NAME,
  OpaqueRef,
  recipe,
  str,
  toSchema,
  UI,
} from "commontools";

interface CounterState {
  value: Cell<number>;
}

const increment = handler<{}, CounterState>((e, state) => {
  state.value.set(state.value.get() + 1);
});

const decrement = handler((_, state: { value: Cell<number> }) => {
  state.value.set(state.value.get() - 1);
});

const model = {
  type: "object",
  properties: {
    value: { type: "number", default: 0 },
  },
  default: { value: 0 },
} as const satisfies JSONSchema;

export default recipe(model, model, (state) => {
  return {
    [NAME]: str`Simple counter: ${derive(state.value, String)}`,
    [UI]: (
      <div>
        <ct-button onClick={decrement(state)}>-</ct-button>
        <ul>
          <li>next number: {state.value + 1}</li>
        </ul>
        <ct-button onClick={increment(state)}>+</ct-button>
      </div>
    ),
    value: cell.value,
  };
});
