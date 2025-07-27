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
} from "commontools";

interface RecipeState {
  value: Default<number, 0>;
}

const increment = handler<unknown, { value: Cell<number> }>((_, state) => {
  state.value.set(state.value.get() + 1);
});

const decrement = handler((_, state: { value: Cell<number> }) => {
  state.value.set(state.value.get() - 1);
});

function previous(value: number) {
  return value - 1;
}

function nth(value: number) {
  if (value === 1) {
    return "1st";
  }
  if (value === 2) {
    return "2nd";
  }
  if (value === 3) {
    return "3rd";
  }
  return `${value}th`;
}

export default recipe<RecipeState>("Counter", (state) => {
  return {
    [NAME]: str`Simple counter: ${state.value}`,
    [UI]: (
      <div>
        <ct-button onClick={decrement(state)}>
          dec to {previous(state.value)}
        </ct-button>
        Counter is the {nth(state.value)} number
        <ct-button onClick={increment({ value: state.value })}>
          inc to {state.value + 1}
        </ct-button>
      </div>
    ),
    value: state.value,
  };
});
