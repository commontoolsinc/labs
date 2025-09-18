/// <cts-enable />
import { Cell, compute, handler, lift, recipe, str } from "commontools";

interface OptionalFallbackArgs {
  value?: number;
  defaultValue?: number;
}

const bumpWithFallback = handler(
  (
    event: { amount?: number } | undefined,
    context: { value: Cell<number>; defaultValue: Cell<number> },
  ) => {
    const amount = typeof event?.amount === "number" ? event.amount : 1;
    const currentRaw = context.value.get();
    const fallback = context.defaultValue.get();
    const base = typeof currentRaw === "number"
      ? currentRaw
      : typeof fallback === "number"
      ? fallback
      : 10;
    context.value.set(base + amount);
  },
);

export const counterWithOptionalFallback = recipe<OptionalFallbackArgs>(
  "Counter With Optional Fallback",
  ({ value, defaultValue }) => {
    defaultValue.setDefault(10);

    const fallbackEffect = compute(() => {
      const fallback = defaultValue.get() ?? 10;
      const current = value.get();
      if (typeof current !== "number") {
        value.set(fallback);
      }
      return fallback;
    });

    const safeDefault = lift((fallback: number | undefined) =>
      typeof fallback === "number" ? fallback : 10
    )(defaultValue);
    const safeValue = lift((inputs: { value?: number; fallback?: number }) => {
      if (typeof inputs.value === "number") return inputs.value;
      if (typeof inputs.fallback === "number") return inputs.fallback;
      return 10;
    })({ value, fallback: defaultValue });

    return {
      value,
      defaultValue,
      current: safeValue,
      effectiveDefault: safeDefault,
      label: str`Value ${safeValue} (default ${safeDefault})`,
      increment: bumpWithFallback({ value, defaultValue }),
      effects: { fallbackEffect },
    };
  },
);
