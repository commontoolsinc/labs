/// <cts-enable />
import { Cell, compute, Default, handler, recipe } from "commontools";

interface DelayedCounterArgs {
  value: Default<number, 0>;
  pending: Default<number[], []>;
}

const scheduleIncrement = handler(
  (
    event: { amount?: number } | undefined,
    context: { pending: Cell<number[]> },
  ) => {
    const amount = typeof event?.amount === "number" ? event.amount : 1;
    const existing = context.pending.get() ?? [];
    context.pending.set([...existing, amount]);
  },
);

export const counterWithDelayedIncrement = recipe<DelayedCounterArgs>(
  "Counter With Delayed Increment",
  ({ value, pending }) => {
    const drainPending = compute(() => {
      const queued = [...(pending.get() ?? [])];
      if (queued.length === 0) return value.get() ?? 0;

      pending.set([]);
      const total = queued.reduce((sum, amount) => sum + amount, 0);
      const current = value.get() ?? 0;
      const next = current + total;
      value.set(next);
      return next;
    });

    return {
      value: drainPending,
      schedule: scheduleIncrement({ pending }),
      rawValue: value,
    };
  },
);
