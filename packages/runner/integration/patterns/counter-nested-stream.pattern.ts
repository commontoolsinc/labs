/// <cts-enable />
import { Cell, Default, handler, recipe, str } from "commontools";

interface NestedStreamArgs {
  value: Default<number, 0>;
}

const nestedIncrement = handler(
  (
    event: { amount?: number } | undefined,
    context: { value: Cell<number> },
  ) => {
    const amount = typeof event?.amount === "number" ? event.amount : 1;
    const next = (context.value.get() ?? 0) + amount;
    context.value.set(next);
  },
);

export const counterWithNestedStream = recipe<NestedStreamArgs>(
  "Counter With Nested Stream",
  ({ value }) => {
    return {
      value,
      label: str`Counter ${value}`,
      streams: {
        increment: nestedIncrement({ value }),
      },
    };
  },
);
