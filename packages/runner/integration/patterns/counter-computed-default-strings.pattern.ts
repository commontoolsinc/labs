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

interface ComputedDefaultStringsArgs {
  value: Default<number, 0>;
  prefix: Default<string, "Count">;
}

const adjustValue = handler(
  (
    event: { amount?: number } | undefined,
    context: { value: Cell<number> },
  ) => {
    const amount = typeof event?.amount === "number" ? event.amount : 1;
    const current = context.value.get();
    const base = typeof current === "number" ? current : 0;
    context.value.set(base + amount);
  },
);

const setOverrideLabel = handler(
  (
    event: { text?: string } | undefined,
    context: { label: Cell<string | undefined> },
  ) => {
    const next = typeof event?.text === "string" && event.text.length > 0
      ? event.text
      : undefined;
    context.label.set(next);
  },
);

export const counterWithComputedDefaultStrings = recipe<
  ComputedDefaultStringsArgs
>(
  "Counter With Computed Default Strings",
  ({ value, prefix }) => {
    const override = cell<string | undefined>();
    const normalizedValue = derive(
      value,
      (count) => (typeof count === "number" ? count : 0),
    );

    const fallbackLabel = lift(
      (
        inputs: { prefix: string | undefined; count: number },
      ) => {
        const base = typeof inputs.prefix === "string" &&
            inputs.prefix.length > 0
          ? inputs.prefix
          : "Count";
        return `${base} ${inputs.count}`;
      },
    )({
      prefix,
      count: normalizedValue,
    });

    const label = lift(
      (
        inputs: { override?: string; fallback: string },
      ) =>
        typeof inputs.override === "string" ? inputs.override : inputs.fallback,
    )({
      override,
      fallback: fallbackLabel,
    });

    const summary = str`${label} (current: ${normalizedValue})`;

    return {
      value,
      prefix,
      current: normalizedValue,
      label,
      fallbackLabel,
      summary,
      overrides: {
        label: override,
      },
      increment: adjustValue({ value }),
      setLabel: setOverrideLabel({ label: override }),
    };
  },
);
