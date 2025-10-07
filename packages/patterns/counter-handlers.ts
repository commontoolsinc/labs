/// <cts-enable />
import { Cell, derive, handler } from "commontools";

export const increment = handler<
  { result: Cell<string> },
  { value: Cell<number> }
>(
  (args, state) => {
    state.value.set(state.value.get() + 1);
    args.result.set(`Incremented to ${state.value.get()}`);
  },
);

export const decrement = handler<
  { result: Cell<string> },
  { value: Cell<number> }
>(
  (args, state) => {
    state.value.set(state.value.get() - 1);
    args.result.set(`Decremented to ${state.value.get()}`);
  },
);

export function nth(value: number) {
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

export function previous(value: number) {
  return value - 1;
}
