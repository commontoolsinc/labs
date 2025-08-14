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

const increment = handler((_, { value }: { value: Cell<number> }) => {
  value.set(value.get() + 1);
});

const decrement = handler((_, { value }: { value: Cell<number> }) => {
  value.set(value.get() - 1);
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

export default recipe<{ value: Default<number, 0> }>("Counter", ({ value }) => {
  return {
    [NAME]: str`Simple counter: ${value}`,
    [UI]: (
      <div>
        <ct-button onClick={decrement({ value })}>
          dec to {previous(value)}
        </ct-button>
        <span id="counter-result">
          Counter is the {nth(value)} number
        </span>
        <ct-button onClick={increment({ value })}>
          inc to {value + 1}
        </ct-button>
      </div>
    ),
    value,
  };
});
