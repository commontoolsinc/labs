/// <cts-enable />
import { Cell, handler } from "commontools";

export const increment = handler<unknown, { value: Cell<number> }>(
  (_, state) => {
    state.value.set(state.value.get() + 1);
  },
);

export const decrement = handler((_, state: { value: Cell<number> }) => {
  state.value.set(state.value.get() - 1);
});

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
