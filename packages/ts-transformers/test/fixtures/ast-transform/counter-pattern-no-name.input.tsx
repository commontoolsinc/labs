/// <cts-enable />
import { Cell, Default, handler, NAME, pattern, str, UI } from "commontools";

interface CounterState {
  value: Cell<number>;
}

interface PatternState {
  value: Default<number, 0>;
}

const increment = handler<unknown, CounterState>((_e, state) => {
  state.value.set(state.value.get() + 1);
});

const decrement = handler((_, state: { value: Cell<number> }) => {
  state.value.set(state.value.get() - 1);
});

export default pattern<PatternState>((state) => {
  return {
    [NAME]: str`Simple counter: ${state.value}`,
    [UI]: (
      <div>
        <ct-button onClick={decrement(state)}>-</ct-button>
        <ul>
          <li>next number: {state.value ? state.value + 1 : "unknown"}</li>
        </ul>
        <ct-button onClick={increment({ value: state.value })}>+</ct-button>
      </div>
    ),
    value: state.value,
  };
});
