/// <cts-enable />
// @ts-nocheck
import {
  type Cell,
  cell,
  compute,
  Default,
  h,
  handler,
  lift,
  NAME,
  recipe,
  str,
  UI,
} from "commontools";

type CounterState = "idle" | "running" | "paused" | "complete";

interface EnumerationArgs {
  state: Default<CounterState, "idle">;
  value: Default<number, 0>;
}

interface TransitionRecord {
  from: CounterState;
  to: CounterState;
  kind: "advance" | "retreat" | "reset" | "tick";
  note: string;
}

interface TransitionEvent {
  note?: unknown;
}

interface TickEvent {
  amount?: unknown;
  note?: unknown;
}

const STATE_SEQUENCE: readonly CounterState[] = [
  "idle",
  "running",
  "paused",
  "complete",
] as const;

const clampState = (input: unknown): CounterState => {
  if (input === "running" || input === "paused" || input === "complete") {
    return input;
  }
  return "idle";
};

const toNumber = (input: unknown, fallback = 0): number => {
  if (typeof input !== "number" || Number.isNaN(input)) {
    return fallback;
  }
  return input;
};

const toNote = (input: unknown, fallback: string): string => {
  return typeof input === "string" && input.length > 0 ? input : fallback;
};

const recordTransition = (
  history: Cell<TransitionRecord[]>,
  sequence: Cell<number>,
  record: TransitionRecord,
) => {
  const current = history.get();
  const list = Array.isArray(current) ? current : [];
  history.set([...list, record]);

  const currentId = toNumber(sequence.get(), 0);
  const nextId = currentId + 1;
  sequence.set(nextId);
};

const advanceState = handler(
  (
    event: TransitionEvent | undefined,
    context: {
      state: Cell<CounterState>;
      history: Cell<TransitionRecord[]>;
      sequence: Cell<number>;
    },
  ) => {
    const current = clampState(context.state.get());
    const index = STATE_SEQUENCE.indexOf(current);
    const next = index < STATE_SEQUENCE.length - 1
      ? STATE_SEQUENCE[index + 1]
      : current;
    if (next === current) {
      return;
    }
    context.state.set(next);
    recordTransition(context.history, context.sequence, {
      from: current,
      to: next,
      kind: "advance",
      note: toNote(event?.note, `advance:${current}->${next}`),
    });
  },
);

const retreatState = handler(
  (
    event: TransitionEvent | undefined,
    context: {
      state: Cell<CounterState>;
      history: Cell<TransitionRecord[]>;
      sequence: Cell<number>;
    },
  ) => {
    const current = clampState(context.state.get());
    const index = STATE_SEQUENCE.indexOf(current);
    const next = index > 0 ? STATE_SEQUENCE[index - 1] : current;
    if (next === current) {
      return;
    }
    context.state.set(next);
    recordTransition(context.history, context.sequence, {
      from: current,
      to: next,
      kind: "retreat",
      note: toNote(event?.note, `retreat:${current}->${next}`),
    });
  },
);

const resetState = handler(
  (
    event: TransitionEvent | undefined,
    context: {
      state: Cell<CounterState>;
      value: Cell<number>;
      history: Cell<TransitionRecord[]>;
      sequence: Cell<number>;
    },
  ) => {
    const current = clampState(context.state.get());
    context.state.set("idle");
    context.value.set(0);
    recordTransition(context.history, context.sequence, {
      from: current,
      to: "idle",
      kind: "reset",
      note: toNote(event?.note, `reset:${current}`),
    });
  },
);

const tickValue = handler(
  (
    event: TickEvent | undefined,
    context: {
      state: Cell<CounterState>;
      value: Cell<number>;
      history: Cell<TransitionRecord[]>;
      sequence: Cell<number>;
    },
  ) => {
    const current = clampState(context.state.get());
    if (current !== "running") {
      return;
    }
    const amount = toNumber(event?.amount, 1);
    const currentValue = toNumber(context.value.get(), 0);
    const nextValue = currentValue + amount;
    context.value.set(nextValue);
    recordTransition(context.history, context.sequence, {
      from: current,
      to: current,
      kind: "tick",
      note: toNote(event?.note, `tick:+${amount}=${nextValue}`),
    });
  },
);

export const counterWithEnumerationStateUx = recipe<EnumerationArgs>(
  "Counter With Enumeration State (UX)",
  ({ state, value }) => {
    const transitions = cell<TransitionRecord[]>([]);
    const transitionSequence = cell(0);

    const initialize = compute(() => {
      if (state.get() === undefined) {
        state.set("idle");
      }
      if (value.get() === undefined) {
        value.set(0);
      }
    });

    const normalizedState = lift(
      (input: CounterState | undefined) => clampState(input),
    )(state);
    const normalizedValue = lift((input: number | undefined) =>
      toNumber(input, 0)
    )(value);
    const transitionView = lift(
      (input: TransitionRecord[] | undefined) =>
        Array.isArray(input) ? input : [],
    )(transitions);
    const transitionCount = lift((list: TransitionRecord[] | undefined) =>
      Array.isArray(list) ? list.length : 0
    )(transitionView);

    const stateIndex = lift((current: CounterState) =>
      STATE_SEQUENCE.indexOf(current)
    )(normalizedState);
    const canAdvance = lift((index: number) =>
      index < STATE_SEQUENCE.length - 1
    )(stateIndex);
    const canRetreat = lift((index: number) => index > 0)(stateIndex);
    const isRunning = lift((current: CounterState) => current === "running")(
      normalizedState,
    );

    const phaseLabel =
      str`state:${normalizedState} index:${stateIndex} value:${normalizedValue}`;
    const summary = str`transitions:${transitionCount} running:${isRunning}`;

    const name = str`Enumeration State Counter (${normalizedState})`;

    // State color mapping
    const stateColor = lift((current: CounterState) => {
      if (current === "idle") return "#64748b";
      if (current === "running") return "#10b981";
      if (current === "paused") return "#f59e0b";
      if (current === "complete") return "#8b5cf6";
      return "#64748b";
    })(normalizedState);

    const stateBgColor = lift((current: CounterState) => {
      if (current === "idle") return "#f1f5f9";
      if (current === "running") return "#d1fae5";
      if (current === "paused") return "#fef3c7";
      if (current === "complete") return "#ede9fe";
      return "#f1f5f9";
    })(normalizedState);

    // State indicator style
    const stateIndicatorStyle = lift((data: { color: string; bg: string }) => {
      return "padding: 1rem; border-radius: 0.75rem; text-align: center; font-weight: 600; font-size: 1.1rem; border: 2px solid " +
        data.color + "; background: " + data.bg + "; color: " + data.color +
        ";";
    })({ color: stateColor, bg: stateBgColor });

    // Progress indicator
    const progressPercentage = lift((data: { index: number }) => {
      const pct = (data.index / (STATE_SEQUENCE.length - 1)) * 100;
      return String(Math.round(pct));
    })({ index: stateIndex });

    const progressStyle = lift((data: { pct: string }) => {
      return "width: " + data.pct +
        "%; height: 0.5rem; background: #10b981; border-radius: 0.25rem; transition: width 0.3s ease;";
    })({ pct: progressPercentage });

    // Render transition history
    const transitionHistoryUi = lift((hist: TransitionRecord[]) => {
      if (!Array.isArray(hist) || hist.length === 0) {
        return (
          <div style="color: #94a3b8; font-style: italic; text-align: center; padding: 1rem;">
            No transitions yet
          </div>
        );
      }

      const recent = hist.slice().reverse().slice(0, 6);
      const items = recent.map((record, idx) => {
        const kindColor = record.kind === "advance"
          ? "#10b981"
          : record.kind === "retreat"
          ? "#f59e0b"
          : record.kind === "reset"
          ? "#ef4444"
          : "#3b82f6";

        const kindBg = record.kind === "advance"
          ? "#d1fae5"
          : record.kind === "retreat"
          ? "#fef3c7"
          : record.kind === "reset"
          ? "#fee2e2"
          : "#dbeafe";

        const kindStyle =
          "display: inline-block; padding: 0.25rem 0.5rem; border-radius: 0.375rem; font-size: 0.75rem; font-weight: 600; background: " +
          kindBg + "; color: " + kindColor + ";";

        return (
          <div
            key={String(idx)}
            style="display: flex; justify-content: space-between; align-items: center; padding: 0.75rem; background: #f8fafc; border-radius: 0.5rem; gap: 0.75rem;"
          >
            <div style="display: flex; flex-direction: column; gap: 0.25rem; flex: 1;">
              <div style="display: flex; gap: 0.5rem; align-items: center;">
                <span style={kindStyle}>{record.kind}</span>
                <span style="font-size: 0.875rem; color: #475569;">
                  {record.from} → {record.to}
                </span>
              </div>
              <span style="font-size: 0.75rem; color: #64748b; font-family: monospace;">
                {record.note}
              </span>
            </div>
          </div>
        );
      });

      return (
        <div style="display: flex; flex-direction: column; gap: 0.5rem;">
          {items}
        </div>
      );
    })(transitionView);

    return {
      [NAME]: name,
      [UI]: (
        <div style="
            display: flex;
            flex-direction: column;
            gap: 1.5rem;
            max-width: 36rem;
          ">
          <ct-card>
            <div
              slot="content"
              style="
                display: flex;
                flex-direction: column;
                gap: 1.25rem;
              "
            >
              <div style="
                  display: flex;
                  flex-direction: column;
                  gap: 0.25rem;
                ">
                <span style="
                    color: #475569;
                    font-size: 0.75rem;
                    letter-spacing: 0.08em;
                    text-transform: uppercase;
                  ">
                  Enumeration State Counter
                </span>
                <h2 style="
                    margin: 0;
                    font-size: 1.3rem;
                    color: #0f172a;
                  ">
                  Step through state lifecycle: idle → running → paused →
                  complete
                </h2>
              </div>

              {/* Current state indicator */}
              <div
                style={stateIndicatorStyle}
                data-testid="state-indicator"
                role="status"
                aria-live="polite"
              >
                <div style="display: flex; align-items: center; justify-content: center; gap: 0.75rem;">
                  <span style="text-transform: uppercase; letter-spacing: 0.05em;">
                    {normalizedState}
                  </span>
                  <span style="opacity: 0.7; font-size: 0.9rem;">
                    ({stateIndex}/3)
                  </span>
                </div>
              </div>

              {/* Progress bar */}
              <div style="display: flex; flex-direction: column; gap: 0.5rem;">
                <div style="display: flex; justify-content: space-between; align-items: center;">
                  <span style="font-size: 0.8rem; color: #475569;">
                    Progress
                  </span>
                  <span style="font-size: 0.8rem; font-weight: 600; color: #0f172a;">
                    {progressPercentage}%
                  </span>
                </div>
                <div style="width: 100%; height: 0.5rem; background: #e2e8f0; border-radius: 0.25rem; overflow: hidden;">
                  <div style={progressStyle}></div>
                </div>
              </div>

              {/* Value display */}
              <div style="
                  background: #f8fafc;
                  border-radius: 0.75rem;
                  padding: 1rem;
                  display: flex;
                  justify-content: space-between;
                  align-items: baseline;
                ">
                <span style="font-size: 0.8rem; color: #475569;">
                  Counter value
                </span>
                <strong style="font-size: 2rem; color: #0f172a;">
                  {normalizedValue}
                </strong>
              </div>

              {/* State controls */}
              <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 0.75rem;">
                <ct-button
                  onClick={retreatState({
                    state,
                    history: transitions,
                    sequence: transitionSequence,
                  })}
                  disabled={lift((can: boolean) => !can)(canRetreat)}
                  variant="secondary"
                  aria-label="Retreat to previous state"
                  data-testid="retreat-button"
                >
                  ← Previous
                </ct-button>

                <ct-button
                  onClick={advanceState({
                    state,
                    history: transitions,
                    sequence: transitionSequence,
                  })}
                  disabled={lift((can: boolean) => !can)(canAdvance)}
                  aria-label="Advance to next state"
                  data-testid="advance-button"
                >
                  Next →
                </ct-button>
              </div>

              {/* Tick button (only works in running state) */}
              <ct-button
                onClick={tickValue({
                  state,
                  value,
                  history: transitions,
                  sequence: transitionSequence,
                })}
                disabled={lift((running: boolean) => !running)(isRunning)}
                aria-label="Increment counter value"
                data-testid="tick-button"
              >
                Tick (+1){" "}
                {lift((running: boolean) =>
                  running ? "" : "(requires running state)"
                )(isRunning)}
              </ct-button>

              {/* Reset button */}
              <ct-button
                onClick={resetState({
                  state,
                  value,
                  history: transitions,
                  sequence: transitionSequence,
                })}
                variant="secondary"
                aria-label="Reset to idle state"
                data-testid="reset-button"
              >
                Reset to Idle
              </ct-button>
            </div>
          </ct-card>

          {/* Transition history */}
          <ct-card>
            <div
              slot="header"
              style="
                display: flex;
                justify-content: space-between;
                align-items: center;
              "
            >
              <h3 style="margin: 0; font-size: 1rem; color: #0f172a;">
                Transition history
              </h3>
              <span style="font-size: 0.85rem; color: #64748b;">
                {transitionCount} transitions
              </span>
            </div>
            <div slot="content">
              {transitionHistoryUi}
            </div>
          </ct-card>

          {/* Pattern explanation */}
          <ct-card>
            <div
              slot="header"
              style="
                display: flex;
                justify-content: space-between;
                align-items: center;
              "
            >
              <h3 style="margin: 0; font-size: 1rem; color: #0f172a;">
                Pattern explanation
              </h3>
            </div>
            <div
              slot="content"
              style="
                display: flex;
                flex-direction: column;
                gap: 0.75rem;
                font-size: 0.9rem;
                color: #475569;
                line-height: 1.6;
              "
            >
              <p style="margin: 0;">
                This pattern demonstrates{" "}
                <strong>enumeration state management</strong>{" "}
                using a fixed sequence of states. The counter progresses through
                four distinct phases:{" "}
                <code style="background: #f1f5f9; padding: 0.125rem 0.375rem; border-radius: 0.25rem; font-family: monospace;">
                  idle
                </code>,{" "}
                <code style="background: #f1f5f9; padding: 0.125rem 0.375rem; border-radius: 0.25rem; font-family: monospace;">
                  running
                </code>,{" "}
                <code style="background: #f1f5f9; padding: 0.125rem 0.375rem; border-radius: 0.25rem; font-family: monospace;">
                  paused
                </code>, and{" "}
                <code style="background: #f1f5f9; padding: 0.125rem 0.375rem; border-radius: 0.25rem; font-family: monospace;">
                  complete
                </code>.
              </p>
              <p style="margin: 0;">
                The <strong>tick</strong>{" "}
                action only increments the value when the state is{" "}
                <code style="background: #f1f5f9; padding: 0.125rem 0.375rem; border-radius: 0.25rem; font-family: monospace;">
                  running
                </code>, showcasing how state can gate handler behavior. All
                transitions are recorded in the history log for audit purposes.
              </p>
              <p style="margin: 0;">
                State transitions are constrained to the sequence: you can
                advance forward or retreat backward, but you can't jump directly
                to an arbitrary state (except via reset, which always returns to
                idle).
              </p>
            </div>
          </ct-card>

          <div
            role="status"
            aria-live="polite"
            data-testid="status"
            style="font-size: 0.85rem; color: #475569;"
          >
            {summary}
          </div>
        </div>
      ),
      state: normalizedState,
      value: normalizedValue,
      stateIndex,
      canAdvance,
      canRetreat,
      isRunning,
      phaseLabel,
      summary,
      transitions: transitionView,
      transitionCount,
      advance: advanceState({
        state,
        history: transitions,
        sequence: transitionSequence,
      }),
      retreat: retreatState({
        state,
        history: transitions,
        sequence: transitionSequence,
      }),
      reset: resetState({
        state,
        value,
        history: transitions,
        sequence: transitionSequence,
      }),
      tick: tickValue({
        state,
        value,
        history: transitions,
        sequence: transitionSequence,
      }),
      effects: { initialize },
    };
  },
);

export default counterWithEnumerationStateUx;
