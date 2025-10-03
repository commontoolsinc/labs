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

interface RichLabelArgs {
  value: Default<number, 0>;
  prefix: Default<string, "Count">;
  step: Default<number, 2>;
  unit: Default<string, "items">;
}

const toInteger = (input: unknown, fallback = 0): number => {
  if (typeof input !== "number" || !Number.isFinite(input)) {
    return fallback;
  }
  return Math.trunc(input);
};

const formatValue = (value: number): string => {
  const safe = Number.isFinite(value) ? value : 0;
  return `${toInteger(safe)}`;
};

export const counterWithRichLabelUx = recipe<RichLabelArgs>(
  "Counter With Rich Label (UX)",
  ({ value, prefix, step, unit }) => {
    const currentValue = lift((input: number | undefined) => toInteger(input))(
      value,
    );
    const currentStep = lift((input: number | undefined) =>
      toInteger(input, 1)
    )(
      step,
    );

    const detail = str`step ${step} ${unit}`;
    const label = str`${prefix}: ${value} (${detail})`;

    const prefixField = cell<string>("");
    const stepField = cell<string>("");
    const unitField = cell<string>("");

    const sanitizedPrefix = derive(prefixField, (text) => {
      if (typeof text !== "string" || text.trim().length === 0) {
        return "Count";
      }
      return text.trim();
    });

    const sanitizedStep = derive(stepField, (text) => {
      const parsed = Number(text);
      if (!Number.isFinite(parsed)) {
        return 1;
      }
      const normalized = Math.abs(Math.trunc(parsed));
      return normalized === 0 ? 1 : normalized;
    });

    const sanitizedUnit = derive(unitField, (text) => {
      if (typeof text !== "string" || text.trim().length === 0) {
        return "items";
      }
      return text.trim();
    });

    const applyIncrement = handler<
      unknown,
      { value: Cell<number>; step: Cell<number> }
    >((_event, { value, step }) => {
      const stepValue = toInteger(step.get(), 1);
      const current = toInteger(value.get());
      value.set(current + stepValue);
    })({ value, step });

    const applyDecrement = handler<
      unknown,
      { value: Cell<number>; step: Cell<number> }
    >((_event, { value, step }) => {
      const stepValue = toInteger(step.get(), 1);
      const current = toInteger(value.get());
      value.set(current - stepValue);
    })({ value, step });

    const applyReset = handler<unknown, { value: Cell<number> }>(
      (_event, { value }) => {
        value.set(0);
      },
    )({ value });

    const updatePrefix = handler<
      unknown,
      { prefix: Cell<string>; input: Cell<string> }
    >((_event, { prefix, input }) => {
      const text = input.get();
      if (typeof text === "string" && text.trim().length > 0) {
        prefix.set(text.trim());
      }
    })({ prefix, input: prefixField });

    const updateStep = handler<
      unknown,
      { step: Cell<number>; input: Cell<string> }
    >((_event, { step, input }) => {
      const parsed = Number(input.get());
      if (Number.isFinite(parsed)) {
        const normalized = Math.abs(Math.trunc(parsed));
        step.set(normalized === 0 ? 1 : normalized);
      }
    })({ step, input: stepField });

    const updateUnit = handler<
      unknown,
      { unit: Cell<string>; input: Cell<string> }
    >((_event, { unit, input }) => {
      const text = input.get();
      if (typeof text === "string" && text.trim().length > 0) {
        unit.set(text.trim());
      }
    })({ unit, input: unitField });

    const syncPrefixField = compute(() => {
      const current = String(prefix.get() ?? "Count");
      if (prefixField.get() !== current) {
        prefixField.set(current);
      }
    });

    const syncStepField = compute(() => {
      const current = formatValue(step.get() ?? 1);
      if (stepField.get() !== current) {
        stepField.set(current);
      }
    });

    const syncUnitField = compute(() => {
      const current = String(unit.get() ?? "items");
      if (unitField.get() !== current) {
        unitField.set(current);
      }
    });

    const currentDisplay = derive(currentValue, (value) => formatValue(value));
    const name = str`Counter With Rich Label (${currentDisplay})`;

    const richLabel = lift(
      ({ val, pre, st, un }: {
        val: number;
        pre: string;
        st: number;
        un: string;
      }) => {
        const valueStr = String(toInteger(val));
        const stepStr = String(toInteger(st));
        return (
          <div style="
              background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
              color: white;
              padding: 1.5rem;
              border-radius: 1rem;
              display: flex;
              flex-direction: column;
              gap: 0.5rem;
              box-shadow: 0 4px 12px rgba(102, 126, 234, 0.3);
            ">
            <div style="
                display: flex;
                align-items: baseline;
                gap: 0.5rem;
              ">
              <span style="font-size: 0.9rem; opacity: 0.9;">
                {pre}:
              </span>
              <strong style="font-size: 2.5rem; font-weight: 700;">
                {valueStr}
              </strong>
            </div>
            <div style="
                font-size: 0.85rem;
                opacity: 0.85;
                font-style: italic;
              ">
              step {stepStr} {un}
            </div>
          </div>
        );
      },
    )({ val: currentValue, pre: prefix, st: step, un: unit });

    return {
      [NAME]: name,
      [UI]: (
        <div style="
            display: flex;
            flex-direction: column;
            gap: 1.5rem;
            max-width: 48rem;
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
                  Rich Label Pattern
                </span>
                <h2 style="
                    margin: 0;
                    font-size: 1.3rem;
                    color: #0f172a;
                  ">
                  Counter with customizable rich label
                </h2>
                <p style="
                    margin: 0;
                    font-size: 0.9rem;
                    color: #64748b;
                  ">
                  Build dynamic labels from multiple configurable parts: prefix,
                  value, step size, and unit
                </p>
              </div>

              {richLabel}

              <div style="
                  display: grid;
                  grid-template-columns: repeat(2, minmax(0, 1fr));
                  gap: 0.75rem;
                ">
                <ct-button
                  onClick={applyIncrement}
                  aria-label="Increment counter by step size"
                >
                  +{currentStep}
                </ct-button>
                <ct-button
                  variant="secondary"
                  onClick={applyDecrement}
                  aria-label="Decrement counter by step size"
                >
                  -{currentStep}
                </ct-button>
              </div>

              <ct-button
                variant="secondary"
                onClick={applyReset}
                aria-label="Reset counter to zero"
              >
                Reset to 0
              </ct-button>
            </div>
          </ct-card>

          <ct-card>
            <div slot="header">
              <h3 style="margin: 0; font-size: 1rem; color: #0f172a;">
                Label configuration
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
                  display: grid;
                  grid-template-columns: repeat(2, minmax(0, 1fr));
                  gap: 1rem;
                ">
                <div style="
                    display: flex;
                    flex-direction: column;
                    gap: 0.4rem;
                  ">
                  <label
                    for="prefix-input"
                    style="
                      font-size: 0.85rem;
                      font-weight: 500;
                      color: #334155;
                    "
                  >
                    Prefix
                  </label>
                  <ct-input
                    id="prefix-input"
                    type="text"
                    $value={prefixField}
                    placeholder="Count"
                    aria-label="Label prefix text"
                  >
                  </ct-input>
                  <ct-button
                    variant="secondary"
                    onClick={updatePrefix}
                    style="margin-top: 0.25rem;"
                  >
                    Apply prefix
                  </ct-button>
                </div>

                <div style="
                    display: flex;
                    flex-direction: column;
                    gap: 0.4rem;
                  ">
                  <label
                    for="unit-input"
                    style="
                      font-size: 0.85rem;
                      font-weight: 500;
                      color: #334155;
                    "
                  >
                    Unit
                  </label>
                  <ct-input
                    id="unit-input"
                    type="text"
                    $value={unitField}
                    placeholder="items"
                    aria-label="Unit of measurement"
                  >
                  </ct-input>
                  <ct-button
                    variant="secondary"
                    onClick={updateUnit}
                    style="margin-top: 0.25rem;"
                  >
                    Apply unit
                  </ct-button>
                </div>
              </div>

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
                  Step size
                </label>
                <ct-input
                  id="step-input"
                  type="number"
                  step="1"
                  min="1"
                  $value={stepField}
                  aria-label="Increment/decrement step size"
                >
                </ct-input>
                <ct-button
                  variant="secondary"
                  onClick={updateStep}
                  style="margin-top: 0.25rem;"
                >
                  Apply step size
                </ct-button>
              </div>

              <div style="
                  background: #f8fafc;
                  border-radius: 0.5rem;
                  padding: 1rem;
                  font-size: 0.85rem;
                  color: #475569;
                  border: 1px solid #e2e8f0;
                ">
                <strong>Label preview:</strong> {label}
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
      prefix,
      step,
      unit,
      currentValue,
      detail,
      label,
      currentDisplay,
      prefixField,
      stepField,
      unitField,
      sanitizedPrefix,
      sanitizedStep,
      sanitizedUnit,
      effects: {
        syncPrefixField,
        syncStepField,
        syncUnitField,
      },
      controls: {
        applyIncrement,
        applyDecrement,
        applyReset,
        updatePrefix,
        updateStep,
        updateUnit,
      },
    };
  },
);

export default counterWithRichLabelUx;
