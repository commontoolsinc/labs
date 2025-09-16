/// <cts-enable />
import { Cell, handler, recipe, str } from "commontools";

interface CounterState {
  value: number;
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
    value.setDefault(0);
    return {
      label: str`Counter value: ${value}`,
      value,
      increment: increment({ value }),
    };
  },
);
