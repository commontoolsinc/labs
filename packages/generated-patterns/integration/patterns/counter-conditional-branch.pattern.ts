/// <cts-enable />
import {
  Cell,
  computed,
  Default,
  handler,
  ifElse,
  lift,
  recipe,
  str,
} from "commontools";

interface ConditionalBranchArgs {
  value: Default<number, 0>;
  enabled: Cell<Default<boolean, false>>;
}

const toggleFlag = handler(
  (_event: unknown, context: { enabled: Cell<boolean> }) => {
    const current = context.enabled.get() ?? false;
    context.enabled.set(!current);
  },
);

const adjustValue = handler(
  (
    event: { amount?: number } | undefined,
    context: { value: Cell<number> },
  ) => {
    const amount = typeof event?.amount === "number" ? event.amount : 1;
    const next = (context.value.get() ?? 0) + amount;
    context.value.set(next);
  },
);

export const counterWithConditionalBranch = recipe<ConditionalBranchArgs>(
  "Counter With Conditional Branch",
  ({ value, enabled }) => {
    const initialize = computed(() => {
      const currentValue = value.get();
      const currentFlag = enabled.get();
      return { value: currentValue, enabled: currentFlag };
    });

    const safeValue = lift((count: number | undefined) =>
      typeof count === "number" ? count : 0
    )(value);
    const active = lift((flag: boolean | undefined) => flag === true)(enabled);
    const branchChoice = ifElse(enabled, { status: "Enabled" }, {
      status: "Disabled",
    });
    const branch = lift((choice: { status: string }) => choice.status)(
      branchChoice,
    );
    const label = str`${branch} ${safeValue}`;

    return {
      value,
      enabled,
      active,
      current: safeValue,
      branch,
      label,
      toggle: toggleFlag({ enabled }),
      increment: adjustValue({ value }),
      effects: { initialize },
    };
  },
);
