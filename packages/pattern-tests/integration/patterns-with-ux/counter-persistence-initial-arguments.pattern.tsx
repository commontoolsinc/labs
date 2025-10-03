/// <cts-enable />
// @ts-nocheck
import {
  Cell,
  cell,
  createCell,
  Default,
  derive,
  h,
  handler,
  lift,
  NAME,
  recipe,
  str,
  UI,
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

    const incrementHandler = applyIncrement({
      state,
      current: normalizedState,
      lastChange,
    });

    const changeDescription = lift((change: PersistedChange) => {
      if (change.reason === "initial") {
        return `Initialized with value ${change.next}`;
      }
      return `${change.previous} + ${change.amount} = ${change.next}`;
    })(lastChange);

    const statusBadge = lift((status: "default" | "restored") => {
      return status === "default" ? "New Session" : "Restored from Args";
    })(initializationStatus);

    const statusColor = lift((status: "default" | "restored") => {
      return status === "default" ? "#6366f1" : "#10b981";
    })(initializationStatus);

    const name = str`${labelCell}`;

    const historyDisplay = derive(historyView, (history) => {
      if (!Array.isArray(history) || history.length === 0) {
        return (
          <div style="text-align: center; color: #9ca3af; padding: 20px;">
            No history yet
          </div>
        );
      }

      const items = history.slice().reverse().map((
        val: number,
        idx: number,
      ) => (
        <div
          style={`
            padding: 6px 8px;
            background: ${idx === 0 ? "#dbeafe" : "white"};
            margin-bottom: 4px;
            border-radius: 4px;
            color: #1f2937;
          `}
        >
          [{history.length - idx - 1}] → {val}
        </div>
      ));

      return <div>{items}</div>;
    });

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
      increment: incrementHandler,
      [NAME]: name,
      [UI]: (
        <div style="
          font-family: system-ui, -apple-system, sans-serif;
          max-width: 480px;
          margin: 0 auto;
          padding: 20px;
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          min-height: 100vh;
        ">
          <div style="
            background: white;
            border-radius: 16px;
            padding: 24px;
            box-shadow: 0 4px 6px rgba(0,0,0,0.1);
          ">
            <div style="
              display: flex;
              justify-content: space-between;
              align-items: center;
              margin-bottom: 20px;
            ">
              <h1 style="
                margin: 0;
                font-size: 24px;
                font-weight: 700;
                color: #1f2937;
              ">
                {labelCell}
              </h1>
              <span
                style={lift((color: string) => `
                background: ${color};
                color: white;
                padding: 6px 12px;
                border-radius: 20px;
                font-size: 12px;
                font-weight: 600;
              `)(statusColor)}
              >
                {statusBadge}
              </span>
            </div>

            <div style="
              background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
              border-radius: 12px;
              padding: 32px;
              text-align: center;
              margin-bottom: 20px;
            ">
              <div style="
                font-size: 64px;
                font-weight: 700;
                color: white;
                margin-bottom: 8px;
              ">
                {currentValue}
              </div>
              <div style="
                color: rgba(255,255,255,0.9);
                font-size: 14px;
              ">
                Current Value
              </div>
            </div>

            <div style="
              display: grid;
              gap: 12px;
              margin-bottom: 20px;
            ">
              <ct-button
                onClick={incrementHandler}
                style="
                background: #667eea;
                color: white;
                border: none;
                padding: 14px 24px;
                border-radius: 8px;
                font-size: 16px;
                font-weight: 600;
                cursor: pointer;
                transition: all 0.2s;
              "
              >
                + Increment by {currentStep}
              </ct-button>
            </div>

            <div style="
              background: #f3f4f6;
              border-radius: 8px;
              padding: 16px;
              margin-bottom: 16px;
            ">
              <div style="
                font-size: 12px;
                font-weight: 600;
                color: #6b7280;
                margin-bottom: 8px;
              ">
                LAST CHANGE
              </div>
              <div style="
                color: #1f2937;
                font-size: 14px;
                font-family: 'SF Mono', 'Monaco', monospace;
              ">
                {changeDescription}
              </div>
            </div>

            <div style="
              background: #f3f4f6;
              border-radius: 8px;
              padding: 16px;
            ">
              <div style="
                font-size: 12px;
                font-weight: 600;
                color: #6b7280;
                margin-bottom: 8px;
              ">
                {lift((h: number[]) => `HISTORY (${h.length} entries)`)(
                  historyView,
                )}
              </div>
              <div style="
                max-height: 120px;
                overflow-y: auto;
                font-family: 'SF Mono', 'Monaco', monospace;
                font-size: 13px;
              ">
                {historyDisplay}
              </div>
            </div>
          </div>
        </div>
      ),
    };
  },
);
