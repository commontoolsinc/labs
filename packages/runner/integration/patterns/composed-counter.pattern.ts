/// <cts-enable />
import { Cell, handler, lift, recipe, str } from "commontools";

const bump = handler(
  (
    event: { amount?: number } | undefined,
    context: { value: Cell<number> },
  ) => {
    const amount = typeof event?.amount === "number" ? event.amount : 1;
    context.value.set((context.value.get() ?? 0) + amount);
  },
);

const mirrorRight = handler(
  (_event: unknown, context: { left: Cell<number>; right: Cell<number> }) => {
    const leftValue = context.left.get() ?? 0;
    context.right.set(leftValue);
  },
);

const childCounter = recipe<{ value?: number }>(
  "Child Counter",
  ({ value }) => {
    value.setDefault(0);
    return {
      label: str`Value ${value}`,
      value,
      increment: bump({ value }),
    };
  },
);

interface ComposedCounterArgs {
  left?: number;
  right?: number;
}

export const composedCounters = recipe<ComposedCounterArgs>(
  "Composed Counters",
  ({ left, right }) => {
    left.setDefault(0);
    right.setDefault(0);

    const leftCounter = childCounter({ value: left });
    const rightCounter = childCounter({ value: right });

    const total = lift((values: { left: number; right: number }) =>
      values.left + values.right
    )({
      left: leftCounter.key("value"),
      right: rightCounter.key("value"),
    });

    return {
      left: leftCounter,
      right: rightCounter,
      total,
      actions: {
        mirrorRight: mirrorRight({
          left: leftCounter.key("value"),
          right: rightCounter.key("value"),
        }),
      },
    };
  },
);
