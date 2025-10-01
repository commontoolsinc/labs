/// <cts-enable />
import { Cell, Default, handler, lift, recipe } from "commontools";

interface LiftFormattingArgs {
  value: Default<number, 0>;
}

const addOne = handler(
  (
    event: { amount?: number } | undefined,
    context: { value: Cell<number> },
  ) => {
    const amount = typeof event?.amount === "number" ? event.amount : 1;
    const next = (context.value.get() ?? 0) + amount;
    context.value.set(next);
  },
);

export const counterWithLiftFormatting = recipe<LiftFormattingArgs>(
  "Counter With Lift Formatting",
  ({ value }) => {
    const formatted = lift((count: number) => `Value: ${count.toFixed(2)}`)(
      value,
    );

    return {
      value,
      formatted,
      increment: addOne({ value }),
    };
  },
);
