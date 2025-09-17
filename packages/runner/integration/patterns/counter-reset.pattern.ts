/// <cts-enable />
import { Cell, handler, recipe, str } from "commontools";

interface ResetCounterArgs {
  value?: number;
  baseline?: number;
}

const applyDelta = handler(
  (
    event: { amount?: number } | undefined,
    context: { value: Cell<number> },
  ) => {
    const amount = typeof event?.amount === "number" ? event.amount : 1;
    const next = (context.value.get() ?? 0) + amount;
    context.value.set(next);
  },
);

const resetCounter = handler(
  (
    _event: unknown,
    context: { value: Cell<number>; baseline: Cell<number> },
  ) => {
    const target = context.baseline.get() ?? 0;
    context.value.set(target);
  },
);

export const counterWithReset = recipe<ResetCounterArgs>(
  "Counter With Reset",
  ({ value, baseline }) => {
    value.setDefault(0);
    baseline.setDefault(0);

    return {
      value,
      baseline,
      label: str`Value ${value}`,
      increment: applyDelta({ value }),
      reset: resetCounter({ value, baseline }),
    };
  },
);
