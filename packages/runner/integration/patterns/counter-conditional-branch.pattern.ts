/// <cts-enable />
import { Cell, compute, handler, ifElse, lift, recipe, str } from "commontools";

interface ConditionalBranchArgs {
  value?: number;
  enabled?: boolean;
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
    value.setDefault(0);
    enabled.setDefault(false);

    const initialize = compute(() => {
      if (value.get() === undefined) {
        value.set(0);
      }
      const currentFlag = enabled.get();
      if (typeof currentFlag !== "boolean") {
        enabled.set(false);
      }
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
