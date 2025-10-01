/// <cts-enable />
// @ts-nocheck
import {
  type Cell,
  cell,
  compute,
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

interface AlternateInitialStateSeed {
  id?: unknown;
  label?: unknown;
  value?: unknown;
  step?: unknown;
}

interface AlternateInitialState {
  id: string;
  label: string;
  value: number;
  step: number;
}

interface SelectionLogEntry {
  id: string;
  value: number;
  step: number;
  reason: string;
  index: number;
}

interface AlternateInitialStatesArgs {
  states: Default<
    AlternateInitialStateSeed[],
    typeof defaultInitialStateSeeds
  >;
}

interface SelectInitialEvent {
  id?: unknown;
  reason?: unknown;
}

interface IncrementEvent {
  amount?: unknown;
}

const defaultInitialStateSeeds = [
  { id: "baseline", label: "Baseline", value: 0, step: 1 },
  { id: "boost", label: "Momentum Boost", value: 8, step: 3 },
] satisfies AlternateInitialStateSeed[];

const fallbackState = (): AlternateInitialState => ({
  id: "baseline",
  label: "Baseline",
  value: 0,
  step: 1,
});

const toFiniteNumber = (input: unknown, fallback: number): number => {
  if (typeof input !== "number" || !Number.isFinite(input)) {
    return fallback;
  }
  return input;
};

const toPositiveStep = (input: unknown, fallback: number): number => {
  const value = toFiniteNumber(input, fallback);
  if (value > 0) {
    return value;
  }
  return fallback > 0 ? fallback : 1;
};

const toStateId = (input: unknown, fallback: string): string => {
  if (typeof input !== "string") return fallback;
  const trimmed = input.trim();
  return trimmed.length > 0 ? trimmed : fallback;
};

const toLabel = (input: unknown, fallback: string): string => {
  if (typeof input !== "string") return fallback;
  const trimmed = input.trim();
  return trimmed.length > 0 ? trimmed : fallback;
};

const sanitizeStateSeeds = (
  seeds: AlternateInitialStateSeed[] | undefined,
): AlternateInitialState[] => {
  if (!Array.isArray(seeds)) {
    return [fallbackState()];
  }

  const sanitized: AlternateInitialState[] = [];
  const seen = new Set<string>();

  for (const seed of seeds) {
    if (!seed || typeof seed !== "object") continue;
    const provisionalId = toStateId(
      (seed as { id?: unknown }).id,
      `state-${sanitized.length + 1}`,
    );
    if (seen.has(provisionalId)) continue;
    seen.add(provisionalId);

    const label = toLabel((seed as { label?: unknown }).label, provisionalId);
    const value = toFiniteNumber(
      (seed as { value?: unknown }).value,
      fallbackState().value,
    );
    const step = toPositiveStep(
      (seed as { step?: unknown }).step,
      fallbackState().step,
    );

    sanitized.push({ id: provisionalId, label, value, step });
  }

  if (sanitized.length === 0) {
    sanitized.push(fallbackState());
  }

  return sanitized;
};

const applyIncrement = handler(
  (
    event: IncrementEvent | undefined,
    context: { value: Cell<number>; step: Cell<number> },
  ) => {
    const stepSize = toPositiveStep(context.step.get(), 1);
    const amount = toFiniteNumber(event?.amount, stepSize);
    const current = toFiniteNumber(context.value.get(), 0);
    context.value.set(current + amount);
  },
);

const selectInitialState = handler(
  (
    event: SelectInitialEvent | undefined,
    context: {
      value: Cell<number>;
      step: Cell<number>;
      activeId: Cell<string>;
      states: Cell<AlternateInitialState[]>;
      log: Cell<SelectionLogEntry[]>;
    },
  ) => {
    const available = context.states.get();
    const baseList = Array.isArray(available) && available.length > 0
      ? available
      : [fallbackState()];

    const requestedId = toStateId(event?.id, baseList[0].id);
    const target = baseList.find((entry) => entry.id === requestedId) ??
      baseList[0];

    context.activeId.set(target.id);
    context.value.set(target.value);
    context.step.set(target.step);

    const existing = context.log.get();
    const history = Array.isArray(existing) ? existing.slice() : [];
    const index = history.length + 1;
    const entry: SelectionLogEntry = {
      id: target.id,
      value: target.value,
      step: target.step,
      reason: toLabel(event?.reason, "selectInitial"),
      index,
    };
    history.push(entry);
    context.log.set(history);
  },
);

export const counterWithAlternateInitialStates = recipe<
  AlternateInitialStatesArgs
>("Counter With Alternate Initial States", ({ states }) => {
  const sanitizedStates = lift(sanitizeStateSeeds)(states);

  const activeStateId = cell(fallbackState().id);
  const valueCell = cell(0);
  const stepCell = cell(1);
  const selectionLog = cell<SelectionLogEntry[]>([]);

  const activeState = lift(
    (
      input:
        | {
          states?: AlternateInitialState[];
          active?: string;
        }
        | undefined,
    ): AlternateInitialState => {
      const candidate = Array.isArray(input?.states)
        ? input?.states?.slice() ?? []
        : [];
      const list = candidate.length > 0 ? candidate : [fallbackState()];
      const desiredId = toStateId(input?.active, list[0].id);
      return list.find((entry) => entry.id === desiredId) ?? list[0];
    },
  )({ states: sanitizedStates, active: activeStateId });

  const selectionCount = derive(
    selectionLog,
    (entries) => Array.isArray(entries) ? entries.length : 0,
  );

  const label = str`State ${
    activeState.key("label")
  }=${valueCell} (step ${stepCell})`;

  // UI-specific handlers
  const incrementByStep = handler(
    (
      _event: unknown,
      context: { value: Cell<number>; step: Cell<number> },
    ) => {
      const stepSize = toPositiveStep(context.step.get(), 1);
      const current = toFiniteNumber(context.value.get(), 0);
      context.value.set(current + stepSize);
    },
  );

  const decrementByStep = handler(
    (
      _event: unknown,
      context: { value: Cell<number>; step: Cell<number> },
    ) => {
      const stepSize = toPositiveStep(context.step.get(), 1);
      const current = toFiniteNumber(context.value.get(), 0);
      context.value.set(current - stepSize);
    },
  );

  const selectStateById = handler(
    (
      event: { id?: unknown } | undefined,
      context: {
        value: Cell<number>;
        step: Cell<number>;
        activeId: Cell<string>;
        states: Cell<AlternateInitialState[]>;
        log: Cell<SelectionLogEntry[]>;
      },
    ) => {
      const available = context.states.get();
      const baseList = Array.isArray(available) && available.length > 0
        ? available
        : [fallbackState()];

      const requestedId = toStateId(event?.id, baseList[0].id);
      const target = baseList.find((entry) => entry.id === requestedId) ??
        baseList[0];

      context.activeId.set(target.id);
      context.value.set(target.value);
      context.step.set(target.step);

      const existing = context.log.get();
      const history = Array.isArray(existing) ? existing.slice() : [];
      const index = history.length + 1;
      const entry: SelectionLogEntry = {
        id: target.id,
        value: target.value,
        step: target.step,
        reason: "UI selection",
        index,
      };
      history.push(entry);
      context.log.set(history);
    },
  );

  const resetToActive = handler(
    (
      _event: unknown,
      context: {
        value: Cell<number>;
        step: Cell<number>;
        activeId: Cell<string>;
        states: Cell<AlternateInitialState[]>;
      },
    ) => {
      const available = context.states.get();
      const baseList = Array.isArray(available) && available.length > 0
        ? available
        : [fallbackState()];

      const activeId = toStateId(context.activeId.get(), baseList[0].id);
      const target = baseList.find((entry) => entry.id === activeId) ??
        baseList[0];

      context.value.set(target.value);
      context.step.set(target.step);
    },
  );

  const name = str`Alternate Initial States`;

  const currentValue = derive(valueCell, (v) => toFiniteNumber(v, 0));
  const currentStep = derive(stepCell, (s) => toPositiveStep(s, 1));

  return {
    value: valueCell,
    step: stepCell,
    activeStateId,
    activeState,
    availableStates: sanitizedStates,
    label,
    selectionLog,
    selectionCount,
    increment: applyIncrement({ value: valueCell, step: stepCell }),
    selectInitial: selectInitialState({
      value: valueCell,
      step: stepCell,
      activeId: activeStateId,
      states: sanitizedStates,
      log: selectionLog,
    }),
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
          <h1 style="
              margin: 0 0 8px 0;
              font-size: 24px;
              font-weight: 700;
              color: #1f2937;
              text-align: center;
            ">
            Alternate Initial States
          </h1>
          <p style="
              margin: 0 0 24px 0;
              font-size: 14px;
              color: #6b7280;
              text-align: center;
            ">
            Choose a starting configuration
          </p>

          {/* Current Value Display */}
          <div style="
              background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
              border-radius: 12px;
              padding: 24px;
              text-align: center;
              margin-bottom: 24px;
            ">
            <div style="
                color: rgba(255,255,255,0.9);
                font-size: 14px;
                margin-bottom: 8px;
              ">
              Current Value
            </div>
            <div style="
                font-size: 56px;
                font-weight: 700;
                color: white;
              ">
              {currentValue}
            </div>
            <div style="
                color: rgba(255,255,255,0.8);
                font-size: 14px;
                margin-top: 8px;
              ">
              Step size: {currentStep}
            </div>
          </div>

          {/* State Selector */}
          <div style="
              background: #f3f4f6;
              border-radius: 12px;
              padding: 20px;
              margin-bottom: 20px;
            ">
            <div style="
                font-size: 12px;
                font-weight: 600;
                color: #6b7280;
                margin-bottom: 12px;
                text-align: center;
              ">
              INITIAL STATE
            </div>
            {lift((data: {
              states?: AlternateInitialState[];
              activeId?: string;
            }) => {
              const states = Array.isArray(data.states)
                ? data.states
                : [fallbackState()];
              const activeId = toStateId(data.activeId, states[0].id);

              return (
                <div style="display: flex; flex-direction: column; gap: 8px;">
                  {states.map((state) => {
                    const isActive = state.id === activeId;
                    return (
                      <div
                        style={`
                          background: ${isActive ? "#667eea" : "white"};
                          color: ${isActive ? "white" : "#1f2937"};
                          border: 2px solid ${isActive ? "#667eea" : "#e5e7eb"};
                          border-radius: 8px;
                          padding: 12px 16px;
                          cursor: pointer;
                          transition: all 0.2s;
                        `}
                      >
                        <ct-button
                          onClick={selectStateById({
                            value: valueCell,
                            step: stepCell,
                            activeId: activeStateId,
                            states: sanitizedStates,
                            log: selectionLog,
                          }, { id: state.id })}
                          style="
                            background: transparent;
                            border: none;
                            width: 100%;
                            text-align: left;
                            cursor: pointer;
                            padding: 0;
                          "
                        >
                          <div style="
                              font-weight: 600;
                              margin-bottom: 4px;
                            ">
                            {state.label}
                          </div>
                          <div
                            style={`
                              font-size: 12px;
                              opacity: ${isActive ? 0.9 : 0.6};
                            `}
                          >
                            Value: {state.value} • Step: {state.step}
                          </div>
                        </ct-button>
                      </div>
                    );
                  })}
                </div>
              );
            })({ states: sanitizedStates, activeId: activeStateId })}
          </div>

          {/* Counter Controls */}
          <div style="
              display: flex;
              gap: 12px;
              margin-bottom: 16px;
            ">
            <ct-button
              onClick={decrementByStep({ value: valueCell, step: stepCell })}
              style="
                flex: 1;
                background: #ef4444;
                color: white;
                border: none;
                padding: 16px;
                border-radius: 8px;
                font-size: 24px;
                font-weight: 700;
                cursor: pointer;
              "
            >
              −{currentStep}
            </ct-button>
            <ct-button
              onClick={incrementByStep({ value: valueCell, step: stepCell })}
              style="
                flex: 1;
                background: #10b981;
                color: white;
                border: none;
                padding: 16px;
                border-radius: 8px;
                font-size: 24px;
                font-weight: 700;
                cursor: pointer;
              "
            >
              +{currentStep}
            </ct-button>
          </div>

          {/* Reset Button */}
          <ct-button
            onClick={resetToActive({
              value: valueCell,
              step: stepCell,
              activeId: activeStateId,
              states: sanitizedStates,
            })}
            style="
              width: 100%;
              background: #6b7280;
              color: white;
              border: none;
              padding: 14px;
              border-radius: 8px;
              font-size: 16px;
              font-weight: 600;
              cursor: pointer;
              margin-bottom: 20px;
            "
          >
            Reset to Initial Value
          </ct-button>

          {/* Selection History */}
          <div style="
              background: #f9fafb;
              border-radius: 8px;
              padding: 16px;
            ">
            <div style="
                font-size: 12px;
                font-weight: 600;
                color: #6b7280;
                margin-bottom: 12px;
              ">
              SELECTION HISTORY ({selectionCount} selections)
            </div>
            {lift((entries: SelectionLogEntry[]) => {
              const history = Array.isArray(entries) ? entries : [];
              if (history.length === 0) {
                return (
                  <div style="
                      color: #9ca3af;
                      font-size: 14px;
                      text-align: center;
                      padding: 8px;
                    ">
                    No selections yet
                  </div>
                );
              }
              return (
                <div style="display: flex; flex-direction: column; gap: 8px;">
                  {history.slice().reverse().map((entry) => (
                    <div style="
                        background: white;
                        border-radius: 6px;
                        padding: 10px;
                        font-size: 13px;
                        border-left: 3px solid #667eea;
                      ">
                      <div style="
                          color: #1f2937;
                          font-weight: 600;
                          margin-bottom: 4px;
                        ">
                        #{entry.index}: {entry.id}
                      </div>
                      <div style="color: #6b7280; font-size: 12px;">
                        Value: {entry.value} • Step: {entry.step} • {entry
                          .reason}
                      </div>
                    </div>
                  ))}
                </div>
              );
            })(selectionLog)}
          </div>
        </div>
      </div>
    ),
  };
});
