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

type LoadingState = {
  status: "loading";
  attempts: number;
  note: string;
};

type ReadyState = {
  status: "ready";
  attempts: number;
  note: string;
  value: number;
  history: number[];
};

type CounterUnionState = LoadingState | ReadyState;

interface ComplexUnionArgs {
  state: Default<
    CounterUnionState,
    { status: "loading"; attempts: 0; note: "booting" }
  >;
  initialValue: Default<number, 0>;
}

const READY_NOTE = "ready";

const pushTransition = (
  logCell: Cell<string[]>,
  entry: string,
) => {
  const current = logCell.get();
  const history = Array.isArray(current) ? current : [];
  logCell.set([...history.slice(-5), entry]);
};

const startLoading = handler(
  (
    event: { note?: string } | undefined,
    context: {
      state: Cell<CounterUnionState>;
      history: Cell<string[]>;
    },
  ) => {
    const nextNote = typeof event?.note === "string" ? event.note : "booting";
    const current = context.state.get();
    const attempts = current?.status === "loading"
      ? current.attempts + 1
      : (current?.attempts ?? 0) + 1;
    context.state.set({
      status: "loading",
      attempts,
      note: nextNote,
    });
    pushTransition(
      context.history,
      `loading:${attempts}:${nextNote}`,
    );
  },
);

const completeLoading = handler(
  (
    event: { value?: number; note?: string } | undefined,
    context: {
      state: Cell<CounterUnionState>;
      initialValue: Cell<number>;
      history: Cell<string[]>;
      readyNote: Cell<string>;
    },
  ) => {
    const fallback = context.initialValue.get();
    const base = typeof event?.value === "number"
      ? event.value
      : typeof fallback === "number"
      ? fallback
      : 0;
    const readyLabel = typeof event?.note === "string"
      ? event.note
      : context.readyNote.get();
    const attempts = context.state.get()?.attempts ?? 0;
    const readyState: ReadyState = {
      status: "ready",
      attempts,
      note: readyLabel ?? "ready",
      value: base,
      history: [base],
    };
    context.state.set(readyState);
    pushTransition(
      context.history,
      `ready:${readyState.value}:${readyLabel}`,
    );
  },
);

const incrementReady = handler(
  (
    event: { amount?: number; note?: string } | undefined,
    context: {
      state: Cell<CounterUnionState>;
      history: Cell<string[]>;
    },
  ) => {
    const current = context.state.get();
    if (!current || current.status !== "ready") {
      return;
    }
    const amount = typeof event?.amount === "number" ? event.amount : 1;
    const note = typeof event?.note === "string" ? event.note : current.note;
    const nextValue = current.value + amount;
    const nextHistory = [...current.history, nextValue];
    const nextState: ReadyState = {
      status: "ready",
      attempts: current.attempts,
      note,
      value: nextValue,
      history: nextHistory,
    };
    context.state.set(nextState);
    pushTransition(
      context.history,
      `increment:${nextValue}:${note}`,
    );
  },
);

export const counterWithComplexUnionStateUx = recipe<ComplexUnionArgs>(
  "Counter With Complex Union State (UX)",
  ({ state, initialValue }) => {
    const defaultReadyNote = cell(READY_NOTE);
    const unionState = lift((value: CounterUnionState | undefined) => {
      if (!value) {
        return {
          status: "loading" as const,
          attempts: 0,
          note: "booting",
        } satisfies LoadingState;
      }
      if (value.status === "loading") {
        return {
          status: "loading" as const,
          attempts: value.attempts,
          note: value.note,
        } satisfies LoadingState;
      }
      return {
        status: "ready" as const,
        attempts: value.attempts,
        note: value.note,
        value: value.value,
        history: Array.isArray(value.history) ? value.history : [value.value],
      } satisfies ReadyState;
    })(state);

    const transitions = cell<string[]>([]);

    const mode = derive(unionState, (current) => current.status);
    const readyValue = lift((current: CounterUnionState) =>
      current.status === "ready" ? current.value : 0
    )(unionState);
    const historyView = lift((current: CounterUnionState) =>
      current.status === "ready" ? current.history : []
    )(unionState);
    const attemptCount = lift((current: CounterUnionState) => current.attempts)(
      unionState,
    );
    const historyCount = lift((items: number[] | undefined) =>
      Array.isArray(items) ? items.length : 0
    )(historyView);
    const summary =
      str`mode:${mode} value:${readyValue} attempts:${attemptCount} history:${historyCount}`;

    // UI form fields
    const loadValueField = cell<string>("");
    const loadNoteField = cell<string>("");
    const incrementAmountField = cell<string>("1");
    const incrementNoteField = cell<string>("");
    const resetNoteField = cell<string>("");

    // Sync initial value to load value field
    compute(() => {
      const init = initialValue.get();
      const current = loadValueField.get();
      if (current === "" && typeof init === "number") {
        loadValueField.set(String(init));
      }
    });

    // UI handlers
    const uiLoad = handler(
      (
        _event: unknown,
        context: {
          valueField: Cell<string>;
          noteField: Cell<string>;
          state: Cell<CounterUnionState>;
          initialValue: Cell<number>;
          history: Cell<string[]>;
          readyNote: Cell<string>;
        },
      ) => {
        const valueText = context.valueField.get();
        const noteText = context.noteField.get();
        const parsedValue = Number(valueText);
        const value =
          typeof parsedValue === "number" && Number.isFinite(parsedValue)
            ? parsedValue
            : context.initialValue.get();
        const note = (typeof noteText === "string" && noteText.trim() !== "")
          ? noteText
          : context.readyNote.get();

        const fallback = context.initialValue.get();
        const base = typeof value === "number"
          ? value
          : (typeof fallback === "number" ? fallback : 0);
        const readyLabel = note ?? "ready";
        const attempts = context.state.get()?.attempts ?? 0;
        const readyState: ReadyState = {
          status: "ready",
          attempts,
          note: readyLabel,
          value: base,
          history: [base],
        };
        context.state.set(readyState);
        pushTransition(
          context.history,
          `ready:${readyState.value}:${readyLabel}`,
        );

        context.valueField.set("");
        context.noteField.set("");
      },
    )({
      valueField: loadValueField,
      noteField: loadNoteField,
      state,
      initialValue,
      history: transitions,
      readyNote: defaultReadyNote,
    });

    const uiIncrement = handler(
      (
        _event: unknown,
        context: {
          amountField: Cell<string>;
          noteField: Cell<string>;
          state: Cell<CounterUnionState>;
          history: Cell<string[]>;
        },
      ) => {
        const current = context.state.get();
        if (!current || current.status !== "ready") {
          return;
        }

        const amountText = context.amountField.get();
        const noteText = context.noteField.get();
        const parsedAmount = Number(amountText);
        const amount =
          typeof parsedAmount === "number" && Number.isFinite(parsedAmount)
            ? parsedAmount
            : 1;
        const note = (typeof noteText === "string" && noteText.trim() !== "")
          ? noteText
          : current.note;

        const nextValue = current.value + amount;
        const nextHistory = [...current.history, nextValue];
        const nextState: ReadyState = {
          status: "ready",
          attempts: current.attempts,
          note,
          value: nextValue,
          history: nextHistory,
        };
        context.state.set(nextState);
        pushTransition(context.history, `increment:${nextValue}:${note}`);

        context.noteField.set("");
      },
    )({
      amountField: incrementAmountField,
      noteField: incrementNoteField,
      state,
      history: transitions,
    });

    const uiReset = handler(
      (
        _event: unknown,
        context: {
          noteField: Cell<string>;
          state: Cell<CounterUnionState>;
          history: Cell<string[]>;
        },
      ) => {
        const noteText = context.noteField.get();
        const nextNote =
          (typeof noteText === "string" && noteText.trim() !== "")
            ? noteText
            : "booting";
        const current = context.state.get();
        const attempts = current?.status === "loading"
          ? current.attempts + 1
          : (current?.attempts ?? 0) + 1;

        context.state.set({
          status: "loading",
          attempts,
          note: nextNote,
        });
        pushTransition(context.history, `loading:${attempts}:${nextNote}`);

        context.noteField.set("");
      },
    )({ noteField: resetNoteField, state, history: transitions });

    // Derived display values
    const isLoading = lift((current: CounterUnionState) =>
      current.status === "loading"
    )(unionState);
    const isReady = lift((current: CounterUnionState) =>
      current.status === "ready"
    )(unionState);

    const currentNote = lift((current: CounterUnionState) => current.note)(
      unionState,
    );

    const statusColor = lift((current: CounterUnionState) => {
      if (current.status === "loading") return "#f59e0b";
      return "#10b981";
    })(unionState);

    const statusStyle = lift((color: string) => {
      return "display: inline-block; padding: 4px 12px; border-radius: 12px; " +
        "background: " + color + "; color: white; font-weight: 600; " +
        "font-size: 14px;";
    })(statusColor);

    const loadingControlStyle = lift((loading: boolean) => {
      return loading ? "display: block;" : "display: none;";
    })(isLoading);

    const readyControlStyle = lift((ready: boolean) => {
      return ready ? "display: block;" : "display: none;";
    })(isReady);

    const historyDisplay = lift((items: number[]) => {
      if (!Array.isArray(items) || items.length === 0) {
        return (
          <div style="color: #9ca3af; font-style: italic; padding: 8px;">
            No history yet
          </div>
        );
      }
      const elements = [];
      const reversed = items.slice().reverse();
      for (const val of reversed) {
        const elem = (
          <div style="padding: 4px 8px; margin: 2px 0; background: #f3f4f6; border-radius: 4px; font-family: monospace;">
            {String(val)}
          </div>
        );
        elements.push(elem);
      }
      return <div>{elements}</div>;
    })(historyView);

    const transitionDisplay = lift((items: string[]) => {
      if (!Array.isArray(items) || items.length === 0) {
        return (
          <div style="color: #9ca3af; font-style: italic; padding: 8px;">
            No transitions yet
          </div>
        );
      }
      const elements = [];
      const reversed = items.slice().reverse();
      for (const entry of reversed) {
        const parts = entry.split(":");
        const action = parts[0] || "";
        let badgeColor = "#6b7280";
        if (action === "loading") badgeColor = "#f59e0b";
        if (action === "ready") badgeColor = "#10b981";
        if (action === "increment") badgeColor = "#3b82f6";

        const badgeStyle = "display: inline-block; padding: 2px 8px; " +
          "border-radius: 8px; background: " + badgeColor + "; color: white; " +
          "font-size: 12px; font-weight: 600; margin-right: 8px;";

        const elem = (
          <div style="padding: 6px 8px; margin: 2px 0; background: #f9fafb; border-left: 3px solid #e5e7eb; font-family: monospace; font-size: 13px;">
            <span style={badgeStyle}>{action}</span>
            <span style="color: #4b5563;">{parts.slice(1).join(":")}</span>
          </div>
        );
        elements.push(elem);
      }
      return <div>{elements}</div>;
    })(transitions);

    const name = str`Union State Counter (${mode})`;

    const ui = (
      <ct-card style="max-width: 800px; margin: 20px auto; font-family: system-ui, -apple-system, sans-serif;">
        <div style="padding: 24px;">
          <h2 style="margin: 0 0 8px 0; font-size: 24px; color: #111827;">
            Union State Counter
          </h2>
          <p style="margin: 0 0 24px 0; color: #6b7280; font-size: 14px;">
            A counter that manages complex state transitions between loading and
            ready modes.
          </p>

          <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 16px; margin-bottom: 24px;">
            <div style="padding: 16px; background: #f9fafb; border-radius: 8px; border: 1px solid #e5e7eb;">
              <div style="font-size: 12px; color: #6b7280; margin-bottom: 4px; text-transform: uppercase; font-weight: 600;">
                Status
              </div>
              <div style={statusStyle}>{mode}</div>
            </div>
            <div style="padding: 16px; background: #f9fafb; border-radius: 8px; border: 1px solid #e5e7eb;">
              <div style="font-size: 12px; color: #6b7280; margin-bottom: 4px; text-transform: uppercase; font-weight: 600;">
                Value
              </div>
              <div style="font-size: 32px; font-weight: 700; color: #111827; font-family: monospace;">
                {readyValue}
              </div>
            </div>
            <div style="padding: 16px; background: #f9fafb; border-radius: 8px; border: 1px solid #e5e7eb;">
              <div style="font-size: 12px; color: #6b7280; margin-bottom: 4px; text-transform: uppercase; font-weight: 600;">
                Attempts
              </div>
              <div style="font-size: 32px; font-weight: 700; color: #6b7280; font-family: monospace;">
                {attemptCount}
              </div>
            </div>
          </div>

          <div style="margin-bottom: 24px; padding: 12px; background: #eff6ff; border-radius: 8px; border-left: 4px solid #3b82f6;">
            <div style="font-size: 12px; color: #1e40af; font-weight: 600; margin-bottom: 4px;">
              Current Note
            </div>
            <div style="color: #1e3a8a; font-family: monospace;">
              {currentNote}
            </div>
          </div>

          <div style={loadingControlStyle}>
            <ct-card style="margin-bottom: 24px; background: #fef3c7; border: 2px solid #f59e0b;">
              <div style="padding: 16px;">
                <h3 style="margin: 0 0 12px 0; font-size: 16px; color: #92400e;">
                  Loading Mode - Complete Loading
                </h3>
                <div style="display: flex; gap: 8px; margin-bottom: 8px;">
                  <ct-input
                    $value={loadValueField}
                    placeholder="Initial value (number)"
                    style="flex: 1;"
                  />
                  <ct-input
                    $value={loadNoteField}
                    placeholder="Note (optional)"
                    style="flex: 1;"
                  />
                </div>
                <ct-button onClick={uiLoad} style="width: 100%;">
                  Complete Loading
                </ct-button>
              </div>
            </ct-card>
          </div>

          <div style={readyControlStyle}>
            <ct-card style="margin-bottom: 24px; background: #d1fae5; border: 2px solid #10b981;">
              <div style="padding: 16px;">
                <h3 style="margin: 0 0 12px 0; font-size: 16px; color: #065f46;">
                  Ready Mode - Increment Counter
                </h3>
                <div style="display: flex; gap: 8px; margin-bottom: 8px;">
                  <ct-input
                    $value={incrementAmountField}
                    placeholder="Amount"
                    style="flex: 1;"
                  />
                  <ct-input
                    $value={incrementNoteField}
                    placeholder="Note (optional)"
                    style="flex: 1;"
                  />
                </div>
                <ct-button onClick={uiIncrement} style="width: 100%;">
                  Increment
                </ct-button>
              </div>
            </ct-card>
          </div>

          <ct-card style="margin-bottom: 24px; background: #fee2e2; border: 2px solid #ef4444;">
            <div style="padding: 16px;">
              <h3 style="margin: 0 0 12px 0; font-size: 16px; color: #991b1b;">
                Reset to Loading
              </h3>
              <div style="display: flex; gap: 8px;">
                <ct-input
                  $value={resetNoteField}
                  placeholder="Note (optional)"
                  style="flex: 1;"
                />
                <ct-button onClick={uiReset}>Reset</ct-button>
              </div>
            </div>
          </ct-card>

          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 16px;">
            <div>
              <h3 style="margin: 0 0 12px 0; font-size: 16px; color: #374151;">
                Value History ({historyCount})
              </h3>
              <div style="max-height: 200px; overflow-y: auto; border: 1px solid #e5e7eb; border-radius: 8px; padding: 8px; background: white;">
                {historyDisplay}
              </div>
            </div>
            <div>
              <h3 style="margin: 0 0 12px 0; font-size: 16px; color: #374151;">
                Transition Log
              </h3>
              <div style="max-height: 200px; overflow-y: auto; border: 1px solid #e5e7eb; border-radius: 8px; padding: 8px; background: white;">
                {transitionDisplay}
              </div>
            </div>
          </div>
        </div>
      </ct-card>
    );

    return {
      [NAME]: name,
      [UI]: ui,
      state: unionState,
      mode,
      readyValue,
      historyView,
      attemptCount,
      summary,
      transitions,
      load: completeLoading({
        state,
        initialValue,
        history: transitions,
        readyNote: defaultReadyNote,
      }),
      increment: incrementReady({ state, history: transitions }),
      reset: startLoading({ state, history: transitions }),
    };
  },
);
