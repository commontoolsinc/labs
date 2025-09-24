/// <cts-enable />
import {
  type Cell,
  cell,
  Default,
  handler,
  lift,
  recipe,
  str,
} from "commontools";

const sanitizeCount = (value: number | undefined): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.trunc(value);
};

const resolveAmount = (value: number | undefined): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) return 1;
  return Math.trunc(value);
};

const adjustParent = handler(
  (
    event: { amount?: number } | number | undefined,
    context: { value: Cell<number> },
  ) => {
    const amount = typeof event === "number"
      ? resolveAmount(event)
      : resolveAmount(event?.amount);
    const next = sanitizeCount(context.value.get()) + amount;
    context.value.set(next);
  },
);

const toggleEnabled = handler(
  (_event: unknown, context: { enabled: Cell<boolean> }) => {
    const current = context.enabled.get() === true;
    context.enabled.set(!current);
  },
);

const adjustChild = handler(
  (
    event: { amount?: number } | undefined,
    context: { value: Cell<number> },
  ) => {
    const amount = resolveAmount(event?.amount);
    const next = sanitizeCount(context.value.get()) + amount;
    context.value.set(next);
  },
);

interface ChildCounterState {
  value: number;
  current: number;
  label: string;
  increment: { amount?: number };
}

const conditionalChild = recipe<
  { value: Default<number, 0> },
  ChildCounterState
>(
  "Conditional Child Counter",
  ({ value }) => {
    const current = lift(sanitizeCount)(value);
    const label = str`Child value ${current}`;
    return {
      value,
      current,
      label,
      increment: adjustChild({ value }),
    };
  },
);

interface ConditionalChildArgs {
  value: Default<number, 0>;
  enabled: Default<boolean, false>;
}

export const counterWithConditionalChildInstantiation = recipe<
  ConditionalChildArgs
>(
  "Counter With Conditional Child Instantiation",
  ({ value, enabled }) => {
    const safeValue = lift(sanitizeCount)(value);
    const isActive = lift((flag: boolean | undefined) => flag === true)(
      enabled,
    );
    const activeStatus = lift((flag: boolean) => flag ? "active" : "idle")(
      isActive,
    );
    const childSlot = cell<ChildCounterState | undefined>(undefined);
    const childGuard = lift(
      (
        state: {
          active: boolean;
          seed: number;
          snapshot: ChildCounterState | undefined;
        },
      ) => {
        const existing = childSlot.get();
        if (!state.active) {
          if (existing !== undefined) childSlot.set(undefined);
          return state.active;
        }
        if (existing === undefined) {
          childSlot.set(conditionalChild({ value: state.seed }));
        }
        return state.active;
      },
    )({ active: isActive, seed: safeValue, snapshot: childSlot });
    const childStatus = lift((active: boolean) =>
      active ? "present" : "absent"
    )(
      isActive,
    );
    const label =
      str`Parent ${safeValue} (${activeStatus}) child ${childStatus}`;

    return {
      value,
      enabled,
      current: safeValue,
      isActive,
      label,
      childStatus,
      child: childSlot,
      toggle: toggleEnabled({ enabled }),
      increment: adjustParent({ value }),
      effects: { childGuard },
    };
  },
);
