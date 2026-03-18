/// <cts-enable />
import {
  Cell,
  computed,
  Default,
  derive,
  handler,
  lift,
  pattern,
} from "commontools";

interface SmokeState {
  value: Default<number, 0>;
  step: Default<number, 1>;
}

interface IncrementEvent {
  amount?: number;
}

interface StepEvent {
  step: number;
}

const scale = 2;

const projectValue = lift((value: number) => value * scale);

const increment = handler(
  (event: IncrementEvent | undefined, context: {
    value: Cell<number>;
    step: Cell<number>;
  }) => {
    const fallbackStep = context.step.get() ?? 1;
    const amount = typeof event?.amount === "number"
      ? event.amount
      : fallbackStep;
    context.value.set((context.value.get() ?? 0) + amount);
  },
);

const setStep = handler((event: StepEvent, context: { step: Cell<number> }) => {
  context.step.set(event.step);
});

export const sesSandboxSmoke = pattern<SmokeState>(({ value, step }) => {
  const doubled = projectValue(value);
  const summary = derive(doubled, (current) => `value:${current}`);
  const isEven = computed(() => ((value ?? 0) % 2) === 0);

  return {
    value,
    step,
    doubled,
    summary,
    isEven,
    increment: increment({ value, step }),
    setStep: setStep({ step }),
  };
});

export default sesSandboxSmoke;
