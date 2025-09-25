/// <cts-enable />
import {
  type Cell,
  cell,
  Default,
  derive,
  handler,
  lift,
  recipe,
  str,
} from "commontools";

interface MultiStepArgs {
  value: Default<number, 0>;
  phase: Default<string, "idle">;
}

interface StartSequenceEvent {
  label?: unknown;
}

interface StepEvent {
  amount?: unknown;
  note?: unknown;
}

interface CompleteEvent {
  note?: unknown;
}

interface StepEntry {
  index: number;
  delta: number;
  total: number;
  note: string;
}

const toNumber = (input: unknown, fallback = 0): number => {
  if (typeof input !== "number" || Number.isNaN(input)) {
    return fallback;
  }
  return input;
};

const toSafeString = (input: unknown, fallback: string): string => {
  if (typeof input !== "string" || input.trim().length === 0) {
    return fallback;
  }
  return input.trim();
};

const sanitizeStepEntries = (input: unknown): StepEntry[] => {
  if (!Array.isArray(input)) return [];
  const result: StepEntry[] = [];
  for (const value of input) {
    if (!value || typeof value !== "object") continue;
    const index = toNumber((value as StepEntry).index, Number.NaN);
    const delta = toNumber((value as StepEntry).delta, Number.NaN);
    const total = toNumber((value as StepEntry).total, Number.NaN);
    const note = toSafeString((value as StepEntry).note, "step");
    if (
      Number.isFinite(index) &&
      Number.isFinite(delta) &&
      Number.isFinite(total)
    ) {
      result.push({
        index,
        delta,
        total,
        note,
      });
    }
  }
  return result;
};

const startSequence = handler(
  (
    event: StartSequenceEvent | undefined,
    context: {
      phase: Cell<string>;
      value: Cell<number>;
      stepIndex: Cell<number>;
      stepLog: Cell<StepEntry[]>;
    },
  ) => {
    const label = toSafeString(event?.label, "active");
    const currentValue = context.value.get();
    context.phase.set(label);
    context.value.set(toNumber(currentValue, 0));
    context.stepIndex.set(0);
    context.stepLog.set([]);
  },
);

const applyStep = handler(
  (
    event: StepEvent | undefined,
    context: {
      phase: Cell<string>;
      value: Cell<number>;
      stepIndex: Cell<number>;
      stepLog: Cell<StepEntry[]>;
    },
  ) => {
    const currentPhase = context.phase.get();
    const delta = toNumber(event?.amount, 1);
    const note = toSafeString(
      event?.note,
      `step ${toSafeString(currentPhase, "active")}`,
    );

    const rawValue = context.value.get();
    const current = toNumber(rawValue, 0);
    const next = current + delta;
    context.value.set(next);

    const rawIndex = context.stepIndex.get();
    const index = toNumber(rawIndex, 0) + 1;
    context.stepIndex.set(index);

    const log = sanitizeStepEntries(context.stepLog.get());
    log.push({ index, delta, total: next, note });
    context.stepLog.set(log);
  },
);

const completeSequence = handler(
  (
    event: CompleteEvent | undefined,
    context: {
      phase: Cell<string>;
      value: Cell<number>;
      stepLog: Cell<StepEntry[]>;
      phaseHistory: Cell<string[]>;
    },
  ) => {
    const phaseValue = toSafeString(context.phase.get(), "active");
    const note = toSafeString(event?.note, "complete");
    const steps = sanitizeStepEntries(context.stepLog.get());
    const total = toNumber(context.value.get(), 0);

    const history = Array.isArray(context.phaseHistory.get())
      ? context.phaseHistory.get()
      : [];
    const summary =
      `${phaseValue} (${note}) steps: ${steps.length} total: ${total}`;
    context.phaseHistory.set([...history, summary]);
  },
);

export const counterWithScenarioDrivenSteps = recipe<MultiStepArgs>(
  "Counter With Scenario Driven Multi Step Events",
  ({ value, phase }) => {
    const stepIndex = cell(0);
    const stepLog = cell<StepEntry[]>([]);
    const phaseHistory = cell<string[]>([]);

    const currentValue = lift((input: unknown) => toNumber(input, 0))(value);
    const currentPhase = lift((input: unknown) => toSafeString(input, "idle"))(
      phase,
    );
    const steps = lift(sanitizeStepEntries)(stepLog);
    const completedPhases = lift((input: unknown) => {
      if (!Array.isArray(input)) return [];
      const result: string[] = [];
      for (const value of input) {
        result.push(toSafeString(value, "unknown phase"));
      }
      return result;
    })(phaseHistory);

    const stepCount = derive(steps, (entries) => entries.length);
    const lastRecordedTotal = derive(steps, (entries) => {
      if (entries.length === 0) {
        return currentValue.get();
      }
      return entries[entries.length - 1].total;
    });

    const summary =
      str`Phase ${currentPhase} total ${currentValue} over ${stepCount} steps`;

    return {
      value,
      phase,
      currentValue,
      currentPhase,
      stepCount,
      steps,
      lastRecordedTotal,
      phases: completedPhases,
      summary,
      sequence: {
        start: startSequence({ phase, value, stepIndex, stepLog }),
        apply: applyStep({ phase, value, stepIndex, stepLog }),
        complete: completeSequence({
          phase,
          value,
          stepLog,
          phaseHistory,
        }),
      },
    };
  },
);
