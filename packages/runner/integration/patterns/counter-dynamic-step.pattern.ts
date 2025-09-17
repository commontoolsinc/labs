/// <cts-enable />
import { Cell, handler, recipe, str } from "commontools";

interface DynamicStepArgs {
  value?: number;
  step?: number;
}

const incrementWithStep = handler(
  (
    _event: unknown,
    context: { value: Cell<number>; step: Cell<number> },
  ) => {
    const step = context.step.get() ?? 1;
    const next = (context.value.get() ?? 0) + step;
    context.value.set(next);
  },
);

const updateStep = handler(
  (
    event: { size?: number } | undefined,
    context: { step: Cell<number> },
  ) => {
    const size = typeof event?.size === "number" ? event.size : 1;
    context.step.set(size);
  },
);

export const counterWithDynamicStep = recipe<DynamicStepArgs>(
  "Counter With Dynamic Step",
  ({ value, step }) => {
    value.setDefault(0);
    step.setDefault(1);

    return {
      value,
      step,
      label: str`Value ${value} (step ${step})`,
      controls: {
        increment: incrementWithStep({ value, step }),
        setStep: updateStep({ step }),
      },
    };
  },
);
