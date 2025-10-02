/// <cts-enable />
import { Cell, Default, handler, lift, recipe, str } from "commontools";

interface DoubleCounterArgs {
  left: Default<number, 0>;
  right: Default<number, 0>;
}

const incrementBoth = handler(
  (
    event: { amount?: number } | undefined,
    context: { left: Cell<number>; right: Cell<number> },
  ) => {
    const amount = typeof event?.amount === "number" ? event.amount : 1;
    const nextLeft = (context.left.get() ?? 0) + amount;
    const nextRight = (context.right.get() ?? 0) + amount;
    context.left.set(nextLeft);
    context.right.set(nextRight);
  },
);

export const doubleCounterWithSharedIncrement = recipe<DoubleCounterArgs>(
  "Double Counter With Shared Increment",
  ({ left, right }) => {
    const status = str`left ${left} • right ${right}`;
    const total = lift((values: { left: number; right: number }) =>
      values.left + values.right
    )({ left, right });

    return {
      left,
      right,
      status,
      total,
      controls: {
        increment: incrementBoth({ left, right }),
      },
    };
  },
);
