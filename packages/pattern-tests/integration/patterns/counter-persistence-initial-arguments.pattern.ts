/// <cts-enable />
import {
  Cell,
  cell,
  createCell,
  Default,
  handler,
  lift,
  recipe,
  str,
} from "commontools";

interface PersistedState {
  value?: number;
  step?: number;
  history?: (number | null | undefined)[];
}

interface MetadataArgs {
  label?: string;
}

interface PersistenceInitialArgs {
  state: Default<
    PersistedState,
    { value: 0; step: 1; history: [] }
  >;
  metadata: Default<MetadataArgs, { label: "Persisted counter" }>;
}

interface NormalizedState {
  value: number;
  step: number;
  history: number[];
}

interface PersistedChange {
  reason: "initial" | "increment";
  previous: number;
  next: number;
  amount: number;
  step: number;
  historyLength: number;
}

interface IncrementEvent {
  amount?: number;
  step?: number;
}

const DEFAULT_NORMALIZED_STATE: NormalizedState = {
  value: 0,
  step: 1,
  history: [0],
};

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const sanitizeStep = (value: unknown, fallback: number): number => {
  if (isFiniteNumber(value) && Math.abs(value) > 0) {
    return value;
  }
  return fallback;
};

const sanitizeHistory = (
  value: (number | null | undefined)[] | undefined,
  fallbackValue: number,
): number[] => {
  if (!Array.isArray(value)) {
    return [fallbackValue];
  }
  const sanitized: number[] = [];
  for (const entry of value) {
    if (isFiniteNumber(entry)) {
      sanitized.push(entry);
    }
  }
  if (sanitized.length === 0) {
    sanitized.push(fallbackValue);
  }
  return sanitized;
};

const cloneNormalizedState = (
  state: NormalizedState,
): NormalizedState => ({
  value: state.value,
  step: state.step,
  history: [...state.history],
});

const normalizeState = (
  input: PersistedState | undefined,
): NormalizedState => {
  const explicitValue = isFiniteNumber(input?.value)
    ? input.value as number
    : undefined;
  const step = sanitizeStep(input?.step, DEFAULT_NORMALIZED_STATE.step);
  const history = sanitizeHistory(
    input?.history,
    explicitValue ?? DEFAULT_NORMALIZED_STATE.value,
  );
  const value = explicitValue ?? history[history.length - 1];
  if (history[history.length - 1] !== value) {
    history.push(value);
  } else {
    history[history.length - 1] = value;
  }
  return { value, step, history };
};

export const counterPersistenceViaInitialArguments = recipe<
  PersistenceInitialArgs
>(
  "Counter Persistence Via Initial Arguments",
  ({ state, metadata }) => {
    let snapshotRecorded = false;
    const lastChange = cell<PersistedChange>({
      reason: "initial",
      previous: DEFAULT_NORMALIZED_STATE.value,
      next: DEFAULT_NORMALIZED_STATE.value,
      amount: 0,
      step: DEFAULT_NORMALIZED_STATE.step,
      historyLength: DEFAULT_NORMALIZED_STATE.history.length,
    });

    const normalizedState = lift((raw: PersistedState | undefined) => {
      const sanitized = normalizeState(raw);
      if (!snapshotRecorded) {
        const seeded = cloneNormalizedState(sanitized);
        createCell<NormalizedState>(
          undefined,
          "initial-argument",
          seeded,
        );
        snapshotRecorded = true;
        lastChange.set({
          reason: "initial",
          previous: sanitized.value,
          next: sanitized.value,
          amount: 0,
          step: sanitized.step,
          historyLength: sanitized.history.length,
        });
      }
      return sanitized;
    })(state);

    const normalizedMetadata = lift((input: MetadataArgs | undefined) => {
      const raw = typeof input?.label === "string" ? input.label.trim() : "";
      const label = raw.length > 0 ? raw : "Persisted counter";
      return { label };
    })(metadata);

    const currentValue = normalizedState.key("value");
    const currentStep = normalizedState.key("step");
    const historyView = normalizedState.key("history");

    const initializationStatus = lift(
      (
        state: NormalizedState,
      ): "default" | "restored" => {
        const matchesDefault = state.value === DEFAULT_NORMALIZED_STATE.value &&
          state.step === DEFAULT_NORMALIZED_STATE.step &&
          state.history.length ===
            DEFAULT_NORMALIZED_STATE.history.length &&
          state.history[state.history.length - 1] ===
            DEFAULT_NORMALIZED_STATE.value;
        return matchesDefault ? "default" : "restored";
      },
    )(normalizedState);

    const historyPreview = lift((entries: number[]) =>
      entries.map((value, index) => `${index}:${value}`).join(" | ")
    )(historyView);

    const labelCell = normalizedMetadata.key("label");
    const summary =
      str`${labelCell}: value ${currentValue} (mode ${initializationStatus})`;
    const details = str`${summary} history ${historyPreview}`;

    const applyIncrement = handler(
      (
        event: IncrementEvent | undefined,
        context: {
          state: Cell<PersistedState>;
          current: Cell<NormalizedState>;
          lastChange: Cell<PersistedChange>;
        },
      ) => {
        const current = context.current.get();
        const step = sanitizeStep(event?.step, current.step);
        const amount = isFiniteNumber(event?.amount)
          ? event.amount as number
          : step;
        const nextValue = current.value + amount;
        const nextHistory = [...current.history, nextValue];
        const nextState: PersistedState = {
          value: nextValue,
          step,
          history: nextHistory,
        };
        context.state.set(nextState);
        context.lastChange.set({
          reason: "increment",
          previous: current.value,
          next: nextValue,
          amount,
          step,
          historyLength: nextHistory.length,
        });
      },
    );

    return {
      state,
      metadata: normalizedMetadata,
      normalizedState,
      value: currentValue,
      step: currentStep,
      history: historyView,
      historyPreview,
      initializationStatus,
      summary,
      details,
      lastPersistedChange: lastChange,
      increment: applyIncrement({
        state,
        current: normalizedState,
        lastChange,
      }),
    };
  },
);
