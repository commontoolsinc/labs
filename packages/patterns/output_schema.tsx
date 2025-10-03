/// <cts-enable />
import {
  Cell,
  Default,
  derive,
  h,
  handler,
  NAME,
  Opaque,
  OpaqueRef,
  recipe,
  str,
  UI,
  VNode,
} from "commontools";

const increment = handler<unknown, { value: Cell<number> }>((_, state) => {
  const current = state.value.get();
  if (current !== undefined) {
    state.value.set(current + 1);
  }
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
