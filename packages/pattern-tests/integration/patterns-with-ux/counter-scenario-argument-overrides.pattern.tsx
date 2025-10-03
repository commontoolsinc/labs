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

export const counterWithScenarioArgumentOverridesUx = recipe<
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

    // UI-specific cells
    const customAmountField = cell<string>("");
    const overrideValueField = cell<string>("");
    const overrideStepField = cell<string>("");
    const overrideNoteField = cell<string>("");

    // Sync override fields with sanitized arguments
    compute(() => {
      const args = sanitizedArguments.get();
      const currentOverrideValue = overrideValueField.get();
      const currentOverrideStep = overrideStepField.get();

      if (currentOverrideValue === "" || currentOverrideValue === undefined) {
        overrideValueField.set(String(args.value));
      }
      if (currentOverrideStep === "" || currentOverrideStep === undefined) {
        overrideStepField.set(String(args.step));
      }
    });

    // UI handlers
    const uiIncrement = handler<
      unknown,
      {
        value: Cell<number>;
        step: Cell<number>;
        history: Cell<number[]>;
        customAmount: Cell<string>;
      }
    >((_event, { value, step, history, customAmount }) => {
      const customAmountStr = customAmount.get();
      const baseStep = sanitizeStepValue(step.get());

      let applied = baseStep;
      if (
        typeof customAmountStr === "string" && customAmountStr.trim() !== ""
      ) {
        const parsed = Number(customAmountStr);
        if (Number.isFinite(parsed)) {
          const normalized = Math.trunc(parsed);
          if (normalized !== 0) {
            applied = normalized;
          }
        }
      }

      const current = sanitizeCounterValue(value.get());
      const next = current + applied;
      value.set(next);

      const hist = sanitizeHistory(history.get());
      history.set([...hist, next]);

      customAmount.set("");
    });

    const uiChangeStep = handler<
      unknown,
      { step: Cell<number>; customAmount: Cell<string> }
    >((_event, { step, customAmount }) => {
      const customAmountStr = customAmount.get();
      if (
        typeof customAmountStr === "string" && customAmountStr.trim() !== ""
      ) {
        const parsed = Number(customAmountStr);
        if (Number.isFinite(parsed)) {
          const next = sanitizeStepValue(parsed);
          step.set(next);
          customAmount.set("");
        }
      }
    });

    const uiApplyOverrides = handler<
      unknown,
      {
        valueField: Cell<string>;
        stepField: Cell<string>;
        noteField: Cell<string>;
        value: Cell<number>;
        step: Cell<number>;
        history: Cell<number[]>;
        overrides: Cell<number>;
        note: Cell<string>;
      }
    >(
      (
        _event,
        {
          valueField,
          stepField,
          noteField,
          value,
          step,
          history,
          overrides,
          note,
        },
      ) => {
        const valueStr = valueField.get();
        const stepStr = stepField.get();
        const noteText = noteField.get();

        const nextValue = sanitizeCounterValue(Number(valueStr));
        const nextStep = sanitizeStepValue(Number(stepStr));

        value.set(nextValue);
        step.set(nextStep);
        history.set([nextValue]);

        const overrideNum = nextOverrideCount(overrides.get());
        overrides.set(overrideNum);

        const noteFinal = typeof noteText === "string" && noteText.trim() !== ""
          ? noteText.trim()
          : `override-${overrideNum}`;
        note.set(`Applied ${noteFinal} -> value ${nextValue} step ${nextStep}`);

        noteField.set("");
      },
    );

    const name = str`Counter (arg overrides) ${currentValue}`;

    const ui = (
      <div style="font-family: system-ui, sans-serif; max-width: 600px; margin: 0 auto; padding: 1rem;">
        <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 1.5rem; border-radius: 8px; margin-bottom: 1rem;">
          <h2 style="margin: 0 0 0.5rem 0; font-size: 1.25rem; font-weight: 600;">
            Scenario Argument Overrides
          </h2>
          <div style="font-size: 3rem; font-weight: 700; margin: 1rem 0;">
            {currentValue}
          </div>
          <div style="font-size: 0.875rem; opacity: 0.9;">
            Step size: {activeStep} • Overrides: {overrideCount}
          </div>
        </div>

        <ct-card style="margin-bottom: 1rem;">
          <div style="padding: 1rem;">
            <h3 style="margin: 0 0 0.75rem 0; font-size: 1rem; font-weight: 600; color: #4a5568;">
              Baseline Arguments
            </h3>
            <div style="background: #f7fafc; padding: 0.75rem; border-radius: 4px; border-left: 4px solid #4299e1;">
              <div style="font-family: monospace; font-size: 0.875rem;">
                value: {sanitizedValue} • step: {sanitizedStep}
              </div>
            </div>
          </div>
        </ct-card>

        <ct-card style="margin-bottom: 1rem;">
          <div style="padding: 1rem;">
            <h3 style="margin: 0 0 0.75rem 0; font-size: 1rem; font-weight: 600; color: #4a5568;">
              Counter Controls
            </h3>
            <div style="display: flex; gap: 0.5rem; margin-bottom: 1rem;">
              <ct-button
                onClick={uiIncrement({
                  value: runtimeValue,
                  step: runtimeStep,
                  history: historyStore,
                  customAmount: customAmountField,
                })}
                style="flex: 1;"
              >
                Increment by step
              </ct-button>
            </div>
            <div style="margin-bottom: 0.75rem;">
              <label style="display: block; font-size: 0.875rem; color: #4a5568; margin-bottom: 0.25rem;">
                Custom amount (optional)
              </label>
              <ct-input
                $value={customAmountField}
                placeholder="Leave empty to use step size"
                style="width: 100%;"
              />
            </div>
          </div>
        </ct-card>

        <ct-card style="margin-bottom: 1rem;">
          <div style="padding: 1rem;">
            <h3 style="margin: 0 0 0.75rem 0; font-size: 1rem; font-weight: 600; color: #4a5568;">
              Update Step Size
            </h3>
            <div style="display: flex; gap: 0.5rem; align-items: flex-end;">
              <div style="flex: 1;">
                <label style="display: block; font-size: 0.875rem; color: #4a5568; margin-bottom: 0.25rem;">
                  New step value
                </label>
                <ct-input
                  $value={customAmountField}
                  placeholder="Enter new step"
                  style="width: 100%;"
                />
              </div>
              <ct-button
                onClick={uiChangeStep({
                  step: runtimeStep,
                  customAmount: customAmountField,
                })}
              >
                Update step
              </ct-button>
            </div>
          </div>
        </ct-card>

        <ct-card style="margin-bottom: 1rem;">
          <div style="padding: 1rem;">
            <h3 style="margin: 0 0 0.75rem 0; font-size: 1rem; font-weight: 600; color: #4a5568;">
              Apply Argument Overrides
            </h3>
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 0.5rem; margin-bottom: 0.75rem;">
              <div>
                <label style="display: block; font-size: 0.875rem; color: #4a5568; margin-bottom: 0.25rem;">
                  Override value
                </label>
                <ct-input
                  $value={overrideValueField}
                  placeholder="Value"
                  style="width: 100%;"
                />
              </div>
              <div>
                <label style="display: block; font-size: 0.875rem; color: #4a5568; margin-bottom: 0.25rem;">
                  Override step
                </label>
                <ct-input
                  $value={overrideStepField}
                  placeholder="Step"
                  style="width: 100%;"
                />
              </div>
            </div>
            <div style="margin-bottom: 0.75rem;">
              <label style="display: block; font-size: 0.875rem; color: #4a5568; margin-bottom: 0.25rem;">
                Override note (optional)
              </label>
              <ct-input
                $value={overrideNoteField}
                placeholder="e.g., 'reset to baseline'"
                style="width: 100%;"
              />
            </div>
            <ct-button
              onClick={uiApplyOverrides({
                valueField: overrideValueField,
                stepField: overrideStepField,
                noteField: overrideNoteField,
                value: runtimeValue,
                step: runtimeStep,
                history: historyStore,
                overrides: overrideSource,
                note: overrideNote,
              })}
              style="width: 100%;"
            >
              Apply overrides
            </ct-button>
            <div style="margin-top: 0.75rem; padding: 0.75rem; background: #edf2f7; border-radius: 4px; font-size: 0.875rem;">
              {overrideNote}
            </div>
          </div>
        </ct-card>

        <ct-card>
          <div style="padding: 1rem;">
            <h3 style="margin: 0 0 0.75rem 0; font-size: 1rem; font-weight: 600; color: #4a5568;">
              History
            </h3>
            <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 0.5rem; margin-bottom: 0.75rem;">
              <div style="text-align: center; padding: 0.5rem; background: #f7fafc; border-radius: 4px;">
                <div style="font-size: 0.75rem; color: #718096; text-transform: uppercase; margin-bottom: 0.25rem;">
                  Entries
                </div>
                <div style="font-size: 1.5rem; font-weight: 700; color: #2d3748;">
                  {historyCount}
                </div>
              </div>
              <div style="text-align: center; padding: 0.5rem; background: #f7fafc; border-radius: 4px;">
                <div style="font-size: 0.75rem; color: #718096; text-transform: uppercase; margin-bottom: 0.25rem;">
                  Last
                </div>
                <div style="font-size: 1.5rem; font-weight: 700; color: #2d3748;">
                  {lastRecorded}
                </div>
              </div>
              <div style="text-align: center; padding: 0.5rem; background: #f7fafc; border-radius: 4px;">
                <div style="font-size: 0.75rem; color: #718096; text-transform: uppercase; margin-bottom: 0.25rem;">
                  Current
                </div>
                <div style="font-size: 1.5rem; font-weight: 700; color: #2d3748;">
                  {currentValue}
                </div>
              </div>
            </div>
            {lift((hist: number[]) => {
              if (hist.length === 0) {
                return h(
                  "div",
                  {
                    style:
                      "padding: 1rem; text-align: center; color: #718096; font-size: 0.875rem; border: 2px dashed #e2e8f0; border-radius: 4px;",
                  },
                  "No history yet. Increment to start tracking.",
                );
              }

              const reversed = hist.slice().reverse();
              const display = reversed.slice(0, 10);
              const elements = [];

              for (let i = 0; i < display.length; i++) {
                const val = display[i];
                const bg = i % 2 === 0 ? "#ffffff" : "#f7fafc";
                elements.push(
                  h(
                    "div",
                    {
                      style: "padding: 0.5rem; background: " + bg +
                        "; border-bottom: 1px solid #e2e8f0; display: flex; justify-content: space-between; align-items: center;",
                    },
                    h("span", {
                      style: "font-family: monospace; color: #718096;",
                    }, "#" + String(hist.length - i)),
                    h("span", {
                      style:
                        "font-family: monospace; font-weight: 600; font-size: 1.125rem;",
                    }, String(val)),
                  ),
                );
              }

              return h("div", {
                style:
                  "border: 1px solid #e2e8f0; border-radius: 4px; overflow: hidden;",
              }, ...elements);
            })(history)}
          </div>
        </ct-card>
      </div>
    );

    return {
      [NAME]: name,
      [UI]: ui,
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
