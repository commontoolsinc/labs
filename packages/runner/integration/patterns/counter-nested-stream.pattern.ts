/// <cts-enable />
import { Cell, handler, recipe, str } from "commontools";

interface NestedStreamArgs {
  value?: number;
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
    value.setDefault(0);

    return {
      value,
      label: str`Counter ${value}`,
      streams: {
        increment: nestedIncrement({ value }),
      },
    };
  },
);
