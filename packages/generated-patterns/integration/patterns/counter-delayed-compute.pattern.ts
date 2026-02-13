/// <cts-enable />
import { Cell, Default, derive, handler, pattern } from "commontools";

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

export const counterWithDelayedIncrement = pattern<DelayedCounterArgs>(
  "Counter With Delayed Increment",
  ({ value, pending }) => {
    const drainPending = derive(
      { pending, value },
      ({ pending, value }) => {
        const queued = [...(pending ?? [])];
        if (queued.length === 0) return value ?? 0;

        const total = queued.reduce((sum, amount) => sum + amount, 0);
        const current = value ?? 0;
        return current + total;
      },
    );

    return {
      value: drainPending,
      schedule: scheduleIncrement({ pending }),
      rawValue: value,
    };
  },
);

export default counterWithDelayedIncrement;
