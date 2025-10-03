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

interface PersistenceDefaultsArgs {
  value: Default<number, 0>;
  step: Default<number, 1>;
}

const toInteger = (input: unknown, fallback = 0): number => {
  if (typeof input !== "number" || !Number.isFinite(input)) {
    return fallback;
  }
  return Math.trunc(input);
};

const formatCount = (value: number): string => {
  const safe = Number.isFinite(value) ? value : 0;
  return `${toInteger(safe)}`;
};

const applyIncrement = handler(
  (
    event: { amount?: number } | undefined,
    context: { value: Cell<number>; step: Cell<number> },
  ) => {
    const amount = typeof event?.amount === "number"
      ? event.amount
      : context.step.get() ?? 1;
    const next = (context.value.get() ?? 0) + amount;
    context.value.set(next);
  },
);

export const counterWithPersistenceDefaultsUx = recipe<PersistenceDefaultsArgs>(
  "Counter With Persistence Defaults (UX)",
  ({ value, step }) => {
    const initialize = compute(() => {
      if (typeof value.get() !== "number") {
        value.set(0);
      }
      if (typeof step.get() !== "number") {
        step.set(1);
      }
    });

    const safeValue = lift((input: number | undefined) =>
      typeof input === "number" ? input : 0
    )(value);

    const safeStep = lift((input: number | undefined) =>
      typeof input === "number" ? input : 1
    )(step);

    const valueDisplay = derive(safeValue, (v) => formatCount(v));
    const stepDisplay = derive(safeStep, (s) => formatCount(s));

    const label = str`Value ${safeValue} (step ${safeStep})`;
    const name = str`Counter with defaults (${safeValue})`;

    const increment = applyIncrement({ value, step });

    const stepField = cell<string>("1");

    const applyCustomIncrement = handler<
      unknown,
      { value: Cell<number>; field: Cell<string> }
    >((_event, { value, field }) => {
      const text = field.get() ?? "1";
      const parsed = Number(text);
      const amount = Number.isFinite(parsed) ? Math.trunc(parsed) : 1;
      const next = (value.get() ?? 0) + amount;
      value.set(next);
      field.set("1");
    })({ value, field: stepField });

    const updateStep = handler<
      unknown,
      { step: Cell<number>; field: Cell<string> }
    >((_event, { step, field }) => {
      const text = field.get() ?? "1";
      const parsed = Number(text);
      const newStep = Number.isFinite(parsed) ? Math.trunc(parsed) : 1;
      step.set(newStep);
    })({ step, field: stepField });

    const syncStepField = compute(() => {
      const text = formatCount(safeStep.get());
      if (stepField.get() !== text) {
        stepField.set(text);
      }
    });

    const resetCounter = handler<unknown, { value: Cell<number> }>(
      (_event, { value }) => {
        value.set(0);
      },
    )({ value });

    return {
      [NAME]: name,
      [UI]: (
        <div style="
            display: flex;
            flex-direction: column;
            gap: 1.5rem;
            max-width: 32rem;
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
                  Persistence Defaults
                </span>
                <h2 style="
                    margin: 0;
                    font-size: 1.3rem;
                    color: #0f172a;
                  ">
                  Counter with default values that persist
                </h2>
                <p style="
                    margin: 0;
                    font-size: 0.9rem;
                    color: #64748b;
                    line-height: 1.5;
                  ">
                  Demonstrates how Default&lt;T&gt; types ensure persistent
                  state gets initialized with sensible defaults.
                </p>
              </div>

              <div style="
                  background: linear-gradient(135deg, #f0f9ff 0%, #e0f2fe 100%);
                  border-radius: 0.75rem;
                  padding: 1.5rem;
                  display: flex;
                  flex-direction: column;
                  gap: 0.5rem;
                  border: 2px solid #bae6fd;
                ">
                <div style="
                    display: flex;
                    justify-content: space-between;
                    align-items: baseline;
                  ">
                  <span style="font-size: 0.8rem; color: #0369a1; font-weight: 500;">
                    Current value
                  </span>
                  <strong style="
                      font-size: 3rem;
                      color: #0c4a6e;
                      font-family: monospace;
                    ">
                    {valueDisplay}
                  </strong>
                </div>

                <div style="
                    display: flex;
                    justify-content: space-between;
                    font-size: 0.8rem;
                    color: #0369a1;
                  ">
                  <span>Default: 0</span>
                  <span>Current step: {stepDisplay}</span>
                </div>
              </div>

              <div style="
                  display: flex;
                  gap: 0.75rem;
                  flex-wrap: wrap;
                ">
                <ct-button
                  onClick={increment}
                  aria-label="Increment by current step"
                >
                  Increment +{stepDisplay}
                </ct-button>
                <ct-button
                  variant="secondary"
                  onClick={resetCounter}
                  aria-label="Reset counter to default"
                >
                  Reset to 0
                </ct-button>
              </div>
            </div>
          </ct-card>

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
                Configuration
              </h3>
            </div>
            <div
              slot="content"
              style="
                display: flex;
                flex-direction: column;
                gap: 1rem;
              "
            >
              <div style="
                  background: #fef3c7;
                  border: 1px solid #fde047;
                  border-radius: 0.5rem;
                  padding: 1rem;
                  display: flex;
                  flex-direction: column;
                  gap: 0.5rem;
                ">
                <div style="
                    display: flex;
                    align-items: center;
                    gap: 0.5rem;
                  ">
                  <span style="
                      display: inline-block;
                      width: 1.5rem;
                      height: 1.5rem;
                      border-radius: 50%;
                      background: #fbbf24;
                      color: white;
                      text-align: center;
                      line-height: 1.5rem;
                      font-weight: bold;
                      font-size: 0.9rem;
                    ">
                    ⚙
                  </span>
                  <span style="
                      font-weight: 600;
                      color: #78350f;
                      font-size: 0.9rem;
                    ">
                    Step size (default: 1)
                  </span>
                </div>
                <p style="
                    margin: 0;
                    font-size: 0.85rem;
                    color: #92400e;
                    line-height: 1.4;
                  ">
                  The step size controls how much the counter increases with
                  each increment. If not set, it defaults to 1.
                </p>
              </div>

              <div style="
                  display: grid;
                  grid-template-columns: 1fr auto;
                  gap: 0.75rem;
                  align-items: end;
                ">
                <div style="
                    display: flex;
                    flex-direction: column;
                    gap: 0.4rem;
                  ">
                  <label
                    for="step-input"
                    style="
                      font-size: 0.85rem;
                      font-weight: 500;
                      color: #334155;
                    "
                  >
                    Custom step size
                  </label>
                  <ct-input
                    id="step-input"
                    type="number"
                    step="1"
                    $value={stepField}
                    aria-label="Enter custom step size"
                  >
                  </ct-input>
                </div>
                <div style="
                    display: flex;
                    gap: 0.5rem;
                  ">
                  <ct-button
                    variant="secondary"
                    onClick={updateStep}
                    aria-label="Update step size"
                  >
                    Update step
                  </ct-button>
                  <ct-button
                    onClick={applyCustomIncrement}
                    aria-label="Increment by custom amount"
                  >
                    Apply once
                  </ct-button>
                </div>
              </div>
            </div>
          </ct-card>

          <div
            role="status"
            aria-live="polite"
            data-testid="status"
            style="font-size: 0.85rem; color: #475569;"
          >
            {label}
          </div>
        </div>
      ),
      value,
      step,
      safeValue,
      safeStep,
      valueDisplay,
      stepDisplay,
      label,
      increment,
      stepField,
      effects: {
        initialize,
        syncStepField,
      },
      controls: {
        applyCustomIncrement,
        updateStep,
        resetCounter,
      },
    };
  },
);

export default counterWithPersistenceDefaultsUx;
