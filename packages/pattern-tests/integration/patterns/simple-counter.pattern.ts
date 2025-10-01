/// <cts-enable />
import { Cell, Default, handler, recipe, str } from "commontools";

interface CounterState {
  value: Default<number, 0>;
}

interface IncrementEvent {
  amount?: number;
}

const increment = handler(
  (event: IncrementEvent | undefined, context: { value: Cell<number> }) => {
    const amount = typeof event?.amount === "number" ? event.amount : 1;
    context.value.set((context.value.get() ?? 0) + amount);
  },
);

export const simpleCounter = recipe<CounterState>(
  "Simple Counter",
  ({ value }) => {
    return {
      label: str`Counter value: ${value}`,
      value,
      increment: increment({ value }),
    };
  },
);
