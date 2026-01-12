/// <cts-enable />
import { Default, handler, Writable } from "commontools";

export const increment = handler<
  void,
  { value: Writable<Default<number, 0>> }
>(
  (_args, state) => {
    state.value.set(state.value.get() + 1);
  },
);

export const decrement = handler<
  void,
  { value: Writable<Default<number, 0>> }
>(
  (_args, state) => {
    state.value.set(state.value.get() - 1);
  },
);

export const getValue = handler<
  { result: Writable<string> },
  { value: Writable<Default<number, 0>> }
>(
  (args, state) => {
    args.result.set(`Value is ${state.value.get()}`);
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
  return `${(value ?? 0)}th`;
}

export function previous(value: number) {
  return (value ?? 0) - 1;
}
