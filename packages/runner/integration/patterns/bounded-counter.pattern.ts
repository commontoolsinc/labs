/// <cts-enable />
import { Cell, compute, handler, recipe, str } from "commontools";

interface BoundedCounterArgs {
  value?: number;
  min?: number;
  max?: number;
}

const clampValue = handler(
  (
    event: { amount?: number } | undefined,
    context: { value: Cell<number>; min: Cell<number>; max: Cell<number> },
  ) => {
    const amount = typeof event?.amount === "number" ? event.amount : 1;
    const minValue = context.min.get() ?? 0;
    const maxValue = context.max.get() ?? minValue;
    const current = context.value.get() ?? minValue;
    const next = Math.min(Math.max(current + amount, minValue), maxValue);
    context.value.set(next);
  },
);

export const boundedCounter = recipe<BoundedCounterArgs>(
  "Bounded Counter",
  ({ value, min, max }) => {
    min.setDefault(0);
    max.setDefault(10);
    value.setDefault(0);

    const label = str`Value ${value} (min ${min}, max ${max})`;

    const clampEffect = compute(() => {
      const current = value.get() ?? 0;
      const minValue = min.get() ?? 0;
      const maxValue = max.get() ?? minValue;
      const normalized = Math.min(Math.max(current, minValue), maxValue);
      if (normalized !== current) value.set(normalized);
      return normalized;
    });

    return {
      value,
      bounds: { min, max },
      label,
      adjust: clampValue({ value, min, max }),
      effects: { clampEffect },
    };
  },
);
