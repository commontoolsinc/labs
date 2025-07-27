/// <cts-enable />
import { Cell, Default, h, handler, NAME, recipe, str, UI } from "commontools";

interface CounterState {
  value: Cell<number>;
}

interface RecipeState {
  value: Default<number, 0>;
}

const increment = handler<unknown, CounterState>((e, state) => {
  state.value.set(state.value.get() + 1);
});

const decrement = handler((_, state: { value: Cell<number> }) => {
  state.value.set(state.value.get() - 1);
});

export default recipe<RecipeState>("Counter", (state) => {
  return {
    [NAME]: str`Simple counter: ${state.value}`,
    [UI]: (
      <div>
        <ct-button onClick={decrement(state)}>-</ct-button>
        <ul>
          <li>next number: {state.value + 1}</li>
        </ul>
        <ct-button onClick={increment({ value: state.value })}>+</ct-button>
      </div>
    ),
    value: state.value,
  };
});
