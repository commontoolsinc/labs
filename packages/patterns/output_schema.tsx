/// <cts-enable />
import { Cell, Default, handler, NAME, recipe, UI, VNode } from "commontools";

const increment = handler<unknown, { value: Cell<number> }>((_, state) => {
  state.value.set(state.value.get() + 1);
});

interface Input {
  value: Default<number, 0>;
}
interface Output {
  value: number;
  [UI]: VNode;
}

export default recipe<Input, Output>("Counter", ({ value }) => {
  return {
    [NAME]: "recipe output issue",
    [UI]: (
      <ct-button onClick={increment({ value: value })}>
        {value}
      </ct-button>
    ),
    value,
  };
});
