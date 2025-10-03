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

interface DynamicStepArgs {
  value: Default<number, 0>;
  step: Default<number, 1>;
}

const toFiniteNumber = (input: unknown, fallback: number): number => {
  if (typeof input !== "number" || !Number.isFinite(input)) {
    return fallback;
  }
  return input;
};

const formatNumber = (value: number): string => {
  const safe = Number.isFinite(value) ? value : 0;
  return `${safe}`;
};

const incrementWithStepMutation = (
  context: { value: Cell<number>; step: Cell<number> },
) => {
  const step = toFiniteNumber(context.step.get(), 1);
  const next = toFiniteNumber(context.value.get(), 0) + step;
  context.value.set(next);
};

const incrementHandler = handler<
  unknown,
  { value: Cell<number>; step: Cell<number> }
>((_event, context) => {
  incrementWithStepMutation(context);
});

const setStepTo1 = handler<
  unknown,
  { step: Cell<number>; stepField: Cell<string> }
>((_event, context) => {
  context.step.set(1);
  context.stepField.set("1");
});

const setStepTo5 = handler<
  unknown,
  { step: Cell<number>; stepField: Cell<string> }
>((_event, context) => {
  context.step.set(5);
  context.stepField.set("5");
});

const setStepTo10 = handler<
  unknown,
  { step: Cell<number>; stepField: Cell<string> }
>((_event, context) => {
  context.step.set(10);
  context.stepField.set("10");
});

const setStepTo25 = handler<
  unknown,
  { step: Cell<number>; stepField: Cell<string> }
>((_event, context) => {
  context.step.set(25);
  context.stepField.set("25");
});

const setStepTo100 = handler<
  unknown,
  { step: Cell<number>; stepField: Cell<string> }
>((_event, context) => {
  context.step.set(100);
  context.stepField.set("100");
});

const applyStepFromField = handler<
  unknown,
  { step: Cell<number>; stepField: Cell<string> }
>((_event, context) => {
  const text = context.stepField.get();
  const parsed = Number(text);
  const size = Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
  context.step.set(size);
});

export const counterDynamicStepUx = recipe<DynamicStepArgs>(
  "Counter With Dynamic Step (UX)",
  ({ value, step }) => {
    const stepField = cell<string>("1");

    const sanitizedValue = lift((raw: number | undefined) =>
      toFiniteNumber(raw, 0)
    )(value);

    const sanitizedStep = lift((raw: number | undefined) => {
      const normalized = toFiniteNumber(raw, 1);
      return normalized > 0 ? normalized : 1;
    })(step);

    const valueDisplay = derive(sanitizedValue, (v) => formatNumber(v));
    const stepDisplay = derive(sanitizedStep, (s) => formatNumber(s));

    const label = str`Value ${sanitizedValue} (step ${sanitizedStep})`;
    const name = str`Dynamic Step Counter (${valueDisplay})`;

    const increment = incrementHandler({ value, step });
    const stepTo1 = setStepTo1({ step, stepField });
    const stepTo5 = setStepTo5({ step, stepField });
    const stepTo10 = setStepTo10({ step, stepField });
    const stepTo25 = setStepTo25({ step, stepField });
    const stepTo100 = setStepTo100({ step, stepField });
    const applyStep = applyStepFromField({ step, stepField });

    const syncStepField = compute(() => {
      const text = stepDisplay.get();
      if (stepField.get() !== text) {
        stepField.set(text);
      }
    });

    const status =
      str`Current value: ${valueDisplay} • Step size: ${stepDisplay}`;

    return {
      [NAME]: name,
      [UI]: (
        <div style="
            display: flex;
            flex-direction: column;
            gap: 1.5rem;
            max-width: 34rem;
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
              <div style="display: flex; flex-direction: column; gap: 0.35rem;">
                <span style="
                    color: #475569;
                    font-size: 0.75rem;
                    text-transform: uppercase;
                    letter-spacing: 0.08em;
                  ">
                  Dynamic step counter
                </span>
                <h2 style="
                    margin: 0;
                    font-size: 1.25rem;
                    line-height: 1.4;
                    color: #0f172a;
                  ">
                  Increment by configurable steps
                </h2>
                <p style="
                    margin: 0;
                    font-size: 0.9rem;
                    color: #64748b;
                    line-height: 1.5;
                  ">
                  Adjust the step size to control how much the counter increases
                  with each click. Perfect for scenarios where you need variable
                  increment amounts.
                </p>
              </div>

              <div style="
                  display: grid;
                  gap: 0.75rem;
                  grid-template-columns: repeat(2, minmax(0, 1fr));
                ">
                <div style="
                    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                    border-radius: 0.75rem;
                    padding: 1rem;
                    display: flex;
                    flex-direction: column;
                    gap: 0.25rem;
                    color: white;
                  ">
                  <span style="
                      font-size: 0.75rem;
                      opacity: 0.9;
                    ">
                    Current value
                  </span>
                  <strong
                    data-testid="current-value"
                    style="font-size: 2.5rem; line-height: 1;"
                  >
                    {valueDisplay}
                  </strong>
                </div>

                <div style="
                    background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%);
                    border-radius: 0.75rem;
                    padding: 1rem;
                    display: flex;
                    flex-direction: column;
                    gap: 0.25rem;
                    color: white;
                  ">
                  <span style="
                      font-size: 0.75rem;
                      opacity: 0.9;
                    ">
                    Step size
                  </span>
                  <strong
                    data-testid="step-size"
                    style="font-size: 2.5rem; line-height: 1;"
                  >
                    +{stepDisplay}
                  </strong>
                </div>
              </div>

              <div style="
                  background: #f8fafc;
                  border-radius: 0.75rem;
                  padding: 1rem;
                  display: flex;
                  align-items: center;
                  justify-content: center;
                ">
                <ct-button
                  data-testid="increment-button"
                  onClick={increment}
                  variant="primary"
                  style="font-size: 1.1rem; padding: 0.75rem 2rem;"
                >
                  Increment by {stepDisplay}
                </ct-button>
              </div>

              <div style="
                  border-top: 1px solid #e2e8f0;
                  padding-top: 1rem;
                  display: flex;
                  flex-direction: column;
                  gap: 0.75rem;
                ">
                <h3 style="
                    margin: 0;
                    font-size: 0.95rem;
                    color: #0f172a;
                    font-weight: 600;
                  ">
                  Configure step size
                </h3>

                <div style="
                    display: flex;
                    gap: 0.5rem;
                    flex-wrap: wrap;
                  ">
                  <ct-button
                    data-testid="step-1"
                    variant="secondary"
                    onClick={stepTo1}
                  >
                    Step 1
                  </ct-button>
                  <ct-button
                    data-testid="step-5"
                    variant="secondary"
                    onClick={stepTo5}
                  >
                    Step 5
                  </ct-button>
                  <ct-button
                    data-testid="step-10"
                    variant="secondary"
                    onClick={stepTo10}
                  >
                    Step 10
                  </ct-button>
                  <ct-button
                    data-testid="step-25"
                    variant="secondary"
                    onClick={stepTo25}
                  >
                    Step 25
                  </ct-button>
                  <ct-button
                    data-testid="step-100"
                    variant="secondary"
                    onClick={stepTo100}
                  >
                    Step 100
                  </ct-button>
                </div>

                <div style="
                    display: flex;
                    flex-direction: column;
                    gap: 0.45rem;
                  ">
                  <label
                    for="custom-step"
                    style="font-size: 0.85rem; font-weight: 500; color: #334155;"
                  >
                    Or set a custom step size
                  </label>
                  <div style="
                      display: flex;
                      gap: 0.5rem;
                      align-items: center;
                    ">
                    <ct-input
                      id="custom-step"
                      data-testid="custom-step-input"
                      type="number"
                      min="1"
                      step="1"
                      $value={stepField}
                      aria-label="Set custom step size"
                    >
                    </ct-input>
                    <ct-button
                      data-testid="apply-custom-step"
                      onClick={applyStep}
                    >
                      Apply
                    </ct-button>
                  </div>
                  <span style="font-size: 0.75rem; color: #64748b;">
                    Enter any positive number. Negative values and zero will
                    default to 1.
                  </span>
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
            {status}
          </div>
        </div>
      ),
      value: sanitizedValue,
      step: sanitizedStep,
      label,
      valueDisplay,
      stepDisplay,
      controls: {
        increment,
        stepTo1,
        stepTo5,
        stepTo10,
        stepTo25,
        stepTo100,
        applyStep,
      },
      inputs: {
        stepField,
      },
      status,
      effects: {
        syncStepField,
      },
    };
  },
);

export default counterDynamicStepUx;
