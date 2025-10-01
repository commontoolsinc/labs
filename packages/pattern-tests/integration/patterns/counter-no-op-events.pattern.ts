/// <cts-enable />
import {
  Cell,
  cell,
  Default,
  derive,
  handler,
  lift,
  recipe,
  str,
} from "commontools";

interface NoOpCounterArgs {
  value: Default<number, 0>;
}

interface IncrementEvent {
  amount?: number;
}

const applyIncrement = handler(
  (
    event: IncrementEvent | undefined,
    context: {
      value: Cell<number>;
      updates: Cell<number>;
      lastEvent: Cell<string>;
    },
  ) => {
    const amount = event?.amount;
    if (typeof amount !== "number" || !Number.isFinite(amount)) {
      return;
    }

    const currentRaw = context.value.get();
    const currentValue =
      typeof currentRaw === "number" && Number.isFinite(currentRaw)
        ? currentRaw
        : 0;
    const next = currentValue + amount;
    context.value.set(next);

    const updateRaw = context.updates.get();
    const applied = typeof updateRaw === "number" && Number.isFinite(updateRaw)
      ? updateRaw + 1
      : 1;
    context.updates.set(applied);
    context.lastEvent.set(`applied ${amount}`);
  },
);

export const counterNoOpEvents = recipe<NoOpCounterArgs>(
  "Counter No-Op Events",
  ({ value }) => {
    const updates = cell(0);
    const lastEvent = cell("none");

    const currentValue = lift((input: number | undefined) =>
      typeof input === "number" && Number.isFinite(input) ? input : 0
    )(value);
    const updateCount = lift((count: number | undefined) =>
      typeof count === "number" && Number.isFinite(count) ? count : 0
    )(updates);
    const lastEventView = lift((label: string | undefined) =>
      typeof label === "string" && label.length > 0 ? label : "none"
    )(lastEvent);
    const hasChanges = derive(updateCount, (count) => count > 0);
    const status = derive(
      hasChanges,
      (changed) => (changed ? "changed" : "no changes"),
    );
    const label = str`Counter value ${currentValue} (${status})`;

    return {
      value,
      currentValue,
      updateCount,
      hasChanges,
      status,
      label,
      lastEvent: lastEventView,
      increment: applyIncrement({ value, updates, lastEvent }),
    };
  },
);
