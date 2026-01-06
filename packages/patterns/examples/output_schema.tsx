/// <cts-enable />
import { Cell, Writable, Default, handler, NAME, pattern, UI, VNode } from "commontools";

const increment = handler<unknown, { value: Writable<number> }>((_, state) => {
  state.value.set(state.value.get() + 1);
});

interface Input {
  value: Default<number, 0>;
}
interface Output {
  value: number;
  [UI]: VNode;
}

export default pattern<Input, Output>(({ value }) => {
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
