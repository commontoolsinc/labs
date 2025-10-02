/// <cts-enable />
import {
  type Cell,
  cell,
  Default,
  handler,
  lift,
  recipe,
  str,
  type Stream,
} from "commontools";

interface ParentChildBubbleArgs {
  parent: Default<number, 0>;
  child: Default<number, 0>;
}

type BubbleEvent = {
  amount?: unknown;
  via?: unknown;
};

type BubbleRecord = {
  amount: number;
  via: string;
};

const asIncrementStream = (
  ref: unknown,
): Stream<{ amount?: number }> => ref as Stream<{ amount?: number }>;

const sanitizeAmount = (value: unknown): number => {
  return typeof value === "number" && Number.isFinite(value) ? value : 1;
};

const sanitizeVia = (value: unknown): string => {
  return typeof value === "string" && value.length > 0 ? value : "parent";
};

const childIncrement = handler(
  (
    event: { amount?: number } | undefined,
    context: { value: Cell<number> },
  ) => {
    const amount = sanitizeAmount(event?.amount);
    const current = context.value.get() ?? 0;
    context.value.set(current + amount);
  },
);

const childCounter = recipe<{ value: Default<number, 0> }>(
  "Bubbled Child Counter",
  ({ value }) => {
    const safeValue = lift((count: number | undefined) =>
      typeof count === "number" && Number.isFinite(count) ? count : 0
    )(value);
    return {
      value,
      label: str`Child count ${safeValue}`,
      increment: childIncrement({ value }),
    };
  },
);

const bubbleToChild = handler(
  (
    event: BubbleEvent | undefined,
    context: {
      childIncrement: Stream<{ amount?: number }>;
      parent: Cell<number>;
      history: Cell<BubbleRecord[]>;
      forwardedCount: Cell<number>;
    },
  ) => {
    const amount = sanitizeAmount(event?.amount);
    const via = sanitizeVia(event?.via);

    const parentCurrent = context.parent.get() ?? 0;
    context.parent.set(parentCurrent + amount);

    const existingHistory = context.history.get();
    const history = Array.isArray(existingHistory)
      ? existingHistory.slice()
      : [];
    history.push({ amount, via });
    context.history.set(history);

    const forwarded = context.forwardedCount.get() ?? 0;
    context.forwardedCount.set(forwarded + 1);

    context.childIncrement.send({ amount });
  },
);

const parentIncrement = handler(
  (
    event: { amount?: number } | undefined,
    context: { parent: Cell<number> },
  ) => {
    const amount = sanitizeAmount(event?.amount);
    const parentCurrent = context.parent.get() ?? 0;
    context.parent.set(parentCurrent + amount);
  },
);

/** Pattern simulating parent handler bubbling events into a child stream. */
export const counterWithParentChildBubbling = recipe<ParentChildBubbleArgs>(
  "Counter With Parent-Child Event Bubbling",
  ({ parent, child }) => {
    const parentView = lift((count: number | undefined) =>
      typeof count === "number" && Number.isFinite(count) ? count : 0
    )(parent);

    const forwardedCount = cell(0);
    const history = cell<BubbleRecord[]>([]);

    const forwardedView = lift((count: number | undefined) =>
      typeof count === "number" && Number.isFinite(count) ? count : 0
    )(forwardedCount);

    const historyView = lift((records: BubbleRecord[] | undefined) =>
      Array.isArray(records) ? records : []
    )(history);

    const childState = childCounter({ value: child });

    return {
      parentValue: parentView,
      child: childState,
      forwardedCount: forwardedView,
      bubbleHistory: historyView,
      bubbleToChild: bubbleToChild({
        childIncrement: asIncrementStream(childState.key("increment")),
        parent,
        history,
        forwardedCount,
      }),
      parentIncrement: parentIncrement({ parent }),
    };
  },
);
