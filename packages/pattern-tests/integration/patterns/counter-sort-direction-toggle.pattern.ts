/// <cts-enable />
import { Cell, cell, Default, handler, lift, recipe, str } from "commontools";

type SortDirection = "asc" | "desc";

interface SortDirectionToggleArgs {
  count: Default<number, 0>;
  entries: Default<number[], []>;
  direction: Default<SortDirection, "asc">;
}

const recordValue = handler(
  (
    event: { amount?: number } | undefined,
    context: { count: Cell<number>; entries: Cell<number[]> },
  ) => {
    const amount = typeof event?.amount === "number" ? event.amount : 1;
    const current = context.count.get();
    const base = typeof current === "number" ? current : 0;
    const next = base + amount;
    context.count.set(next);

    const existing = context.entries.get();
    const list = Array.isArray(existing) ? existing : [];
    context.entries.set([...list, next]);
  },
);

const toggleSortDirection = handler(
  (
    event: { direction?: SortDirection } | undefined,
    context: {
      direction: Cell<SortDirection>;
      history: Cell<SortDirection[]>;
    },
  ) => {
    const current = context.direction.get();
    const currentDirection = current === "desc" ? "desc" : "asc";
    const requested = event?.direction;
    const next = requested === "desc"
      ? "desc"
      : requested === "asc"
      ? "asc"
      : currentDirection === "asc"
      ? "desc"
      : "asc";

    if (next !== currentDirection) {
      context.direction.set(next);
    }

    const previous = context.history.get();
    const history = Array.isArray(previous) ? previous : [];
    const updates = [...history, next];
    context.history.set(updates);
  },
);

export const counterWithSortDirectionToggle = recipe<SortDirectionToggleArgs>(
  "Counter With Sort Direction Toggle",
  ({ count, entries, direction }) => {
    const directionHistory = cell<SortDirection[]>([]);

    const safeCount = lift((value: number | undefined) =>
      typeof value === "number" ? value : 0
    )(count);

    const safeEntries = lift((values: number[] | undefined) =>
      Array.isArray(values) ? values : []
    )(entries);

    const safeDirection = lift((value: SortDirection | undefined) =>
      value === "desc" ? "desc" : "asc"
    )(direction);

    const sortedValues = lift(
      (input: { values: number[]; direction: SortDirection }) => {
        const sorted = [...input.values].sort((left, right) =>
          input.direction === "desc" ? right - left : left - right
        );
        return sorted;
      },
    )({ values: safeEntries, direction: safeDirection });

    const directionLabel = lift((value: SortDirection) =>
      value === "desc" ? "descending" : "ascending"
    )(safeDirection);

    const sortedValuesLabel = lift((values: number[]) =>
      values.length === 0 ? "[]" : `[${values.join(", ")}]`
    )(sortedValues);

    const directionHistoryView = lift(
      (history: SortDirection[] | undefined) =>
        Array.isArray(history) ? history : [],
    )(directionHistory);

    const toggleDirection = toggleSortDirection({
      direction,
      history: directionHistory,
    });

    return {
      count,
      entries,
      direction: safeDirection,
      current: safeCount,
      values: safeEntries,
      sortedValues,
      directionLabel,
      sortedValuesLabel,
      directionHistory: directionHistoryView,
      label: str`Sorted ${directionLabel}: ${sortedValuesLabel}`,
      increment: recordValue({ count, entries }),
      toggleDirection,
    };
  },
);
