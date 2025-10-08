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

interface ScenarioArgumentOverrideArgs {
  value: Default<number, 0>;
  step: Default<number, 1>;
}

interface IncrementEvent {
  amount?: unknown;
}

interface StepChangeEvent {
  step?: unknown;
}

interface ApplyOverrideEvent {
  note?: unknown;
}

interface SanitizedArguments {
  value: number;
  step: number;
}

const toFiniteInteger = (input: unknown, fallback: number): number => {
  if (typeof input !== "number" || !Number.isFinite(input)) {
    return fallback;
  }
  const rounded = Math.trunc(input);
  return Number.isFinite(rounded) ? rounded : fallback;
};

const sanitizeCounterValue = (input: unknown): number => {
  return toFiniteInteger(input, 0);
};

const sanitizeStepValue = (input: unknown): number => {
  const normalized = Math.abs(toFiniteInteger(input, 1));
  return normalized === 0 ? 1 : normalized;
};

const resolveIncrementAmount = (
  payload: unknown,
  fallback: number,
): number => {
  if (typeof payload !== "number" || !Number.isFinite(payload)) {
    return fallback;
  }
  const normalized = Math.trunc(payload);
  return normalized === 0 ? fallback : normalized;
};

const sanitizeHistory = (input: unknown): number[] => {
  if (!Array.isArray(input)) return [];
  const entries: number[] = [];
  for (const value of input) {
    entries.push(sanitizeCounterValue(value));
  }
  return entries;
};

const sanitizeOverrideCount = (value: unknown): number => {
  const current = sanitizeCounterValue(value);
  return current >= 0 ? current : 0;
};

const nextOverrideCount = (value: unknown): number => {
  return sanitizeOverrideCount(value) + 1;
};

const incrementCounter = handler(
  (
    event: IncrementEvent | undefined,
    context: {
      value: Cell<number>;
      step: Cell<number>;
      history: Cell<number[]>;
    },
  ) => {
    const baseStep = sanitizeStepValue(context.step.get());
    const applied = resolveIncrementAmount(event?.amount, baseStep);
    const current = sanitizeCounterValue(context.value.get());
    const next = current + applied;

    context.value.set(next);

    const history = sanitizeHistory(context.history.get());
    context.history.set([...history, next]);
  },
);

const changeStepFromEvent = handler(
  (
    event: StepChangeEvent | undefined,
    context: { step: Cell<number> },
  ) => {
    if (!event || !("step" in event)) return;
    const next = sanitizeStepValue(event.step);
    context.step.set(next);
  },
);

const applyArgumentOverrides = handler(
  (
    event: ApplyOverrideEvent | undefined,
    context: {
      args: Cell<SanitizedArguments>;
      value: Cell<number>;
      step: Cell<number>;
      history: Cell<number[]>;
      overrides: Cell<number>;
      note: Cell<string>;
    },
  ) => {
    const sanitized = context.args.get();
    const nextValue = sanitizeCounterValue(sanitized.value);
    const nextStep = sanitizeStepValue(sanitized.step);

    context.value.set(nextValue);
    context.step.set(nextStep);
    context.history.set([nextValue]);

    const overrides = nextOverrideCount(context.overrides.get());
    context.overrides.set(overrides);

    const note = typeof event?.note === "string" && event.note.trim().length > 0
      ? event.note.trim()
      : `override-${overrides}`;
    context.note.set(`Applied ${note} -> value ${nextValue} step ${nextStep}`);
  },
);

export const counterWithScenarioArgumentOverrides = recipe<
  ScenarioArgumentOverrideArgs
>(
  "Counter With Scenario Driven Argument Overrides",
  ({ value, step }) => {
    const sanitizedArguments = lift((
      inputs: { value?: number; step?: number },
    ) => ({
      value: sanitizeCounterValue(inputs.value),
      step: sanitizeStepValue(inputs.step),
    }))({ value, step });

    const sanitizedValue = sanitizedArguments.key("value");
    const sanitizedStep = sanitizedArguments.key("step");

    const runtimeValue = cell(0);
    const runtimeStep = cell(1);
    const historyStore = cell<number[]>([]);
    const overrideSource = cell(0);
    const overrideCount = lift((value: number | undefined) =>
      sanitizeOverrideCount(value)
    )(overrideSource);
    const overrideNote = cell("initial arguments applied");

    const currentValue = lift((input: number | undefined) =>
      sanitizeCounterValue(input)
    )(runtimeValue);
    const activeStep = lift((input: number | undefined) =>
      sanitizeStepValue(input)
    )(runtimeStep);

    const history = lift(sanitizeHistory)(historyStore);
    const historyCount = lift((entries: number[]) => entries.length)(history);
    const lastRecorded = lift((entries: number[]) =>
      entries.length > 0 ? entries[entries.length - 1] : 0
    )(history);

    const argumentLabel =
      str`Argument baseline value ${sanitizedValue} step ${sanitizedStep}`;
    const summary =
      str`Current ${currentValue} step ${activeStep} overrides ${overrideCount} history ${historyCount}`;

    return {
      argumentInputs: { value, step },
      argumentState: sanitizedArguments,
      currentValue,
      activeStep,
      history,
      historyCount,
      lastRecorded,
      overrideCount,
      overrideNote,
      argumentLabel,
      summary,
      controls: {
        increment: incrementCounter({
          value: runtimeValue,
          step: runtimeStep,
          history: historyStore,
        }),
        changeStep: changeStepFromEvent({ step: runtimeStep }),
        applyArgumentOverrides: applyArgumentOverrides({
          args: sanitizedArguments,
          value: runtimeValue,
          step: runtimeStep,
          history: historyStore,
          overrides: overrideSource,
          note: overrideNote,
        }),
      },
    };
  },
);
