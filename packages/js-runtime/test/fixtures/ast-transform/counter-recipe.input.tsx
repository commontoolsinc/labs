/// <cts-enable />
import { Cell, derive, h, handler, NAME, recipe, str, UI } from "commontools";

interface CounterState {
  value: Cell<number>;
}

interface RecipeState {
  value: number;
}

const increment = handler<unknown, CounterState>((e, state) => {
  state.value.set(state.value.get() + 1);
});

const decrement = handler((_, state: { value: Cell<number> }) => {
  state.value.set(state.value.get() - 1);
});

export default recipe<RecipeState>("Counter", (state) => {
  return {
    [NAME]: str`Simple counter: ${derive(state.value, String)}`,
    [UI]: (
      <div>
        <ct-button onClick={decrement({ value: state.value })}>-</ct-button>
        <ul>
          <li>next number: {state.value + 1}</li>
        </ul>
        <ct-button onClick={increment({ value: state.value })}>+</ct-button>
      </div>
    ),
    value: state.value,
  };
});
