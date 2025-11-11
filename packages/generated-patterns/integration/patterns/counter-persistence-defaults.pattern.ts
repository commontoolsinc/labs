/// <cts-enable />
import {
  Cell,
  computed,
  Default,
  handler,
  lift,
  recipe,
  str,
} from "commontools";

interface PersistenceDefaultsArgs {
  value: Default<number, 0>;
  step: Default<number, 1>;
}

const applyIncrement = handler(
  (
    event: { amount?: number } | undefined,
    context: { value: Cell<number>; step: Cell<number> },
  ) => {
    const amount = typeof event?.amount === "number"
      ? event.amount
      : context.step.get() ?? 1;
    const next = (context.value.get() ?? 0) + amount;
    context.value.set(next);
  },
);

export const counterWithPersistenceDefaults = recipe<PersistenceDefaultsArgs>(
  "Counter With Persistence Defaults",
  ({ value, step }) => {
    const initialize = computed(() => {
      const currentValue = value.get();
      const currentStep = step.get();
      return { value: currentValue, step: currentStep };
    });

    const safeStep = lift((input: number | undefined) =>
      typeof input === "number" ? input : 1
    )(step);

    return {
      value,
      step,
      currentStep: safeStep,
      label: str`Value ${value} (step ${safeStep})`,
      increment: applyIncrement({ value, step }),
      effects: { initialize },
    };
  },
);
