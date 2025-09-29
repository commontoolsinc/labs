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

interface CrossFieldValidationArgs {
  value: Default<number, 0>;
  limit: Default<number, 10>;
  step: Default<number, 1>;
}

interface ValidationEntry {
  value: number;
  limit: number;
  hasError: boolean;
}

const toInteger = (value: unknown, fallback: number): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.trunc(value);
};

const toPositiveStep = (value: unknown, fallback: number): number => {
  const sanitized = Math.abs(toInteger(value, fallback));
  if (sanitized === 0) {
    const safeFallback = Math.abs(fallback) || 1;
    return safeFallback;
  }
  return sanitized;
};

const formatCount = (value: number): string => {
  const safe = Number.isFinite(value) ? value : 0;
  return `${toInteger(safe)}`;
};

const recordSnapshot = (
  auditTrail: Cell<ValidationEntry[]>,
  value: Cell<number>,
  limit: Cell<number>,
): void => {
  const currentValue = toInteger(value.get(), 0);
  const limitValue = toInteger(limit.get(), 10);
  auditTrail.push({
    value: currentValue,
    limit: limitValue,
    hasError: currentValue > limitValue,
  });
};

export const counterCrossFieldValidationUx = recipe<CrossFieldValidationArgs>(
  "Counter With Cross Field Validation (UX)",
  ({ value, limit, step }) => {
    const auditTrail = cell<ValidationEntry[]>([]);

    const sanitizedValue = lift((input: number | undefined) =>
      toInteger(input, 0)
    )(value);
    const sanitizedLimit = lift((input: number | undefined) =>
      toInteger(input, 10)
    )(limit);
    const sanitizedStep = lift((input: number | undefined) =>
      toPositiveStep(input, 1)
    )(step);

    const difference = lift(
      ({ val, lim }: { val: number; lim: number }) => val - lim,
    )({ val: sanitizedValue, lim: sanitizedLimit });

    const hasError = lift(
      ({ val, lim }: { val: number; lim: number }) => val > lim,
    )({ val: sanitizedValue, lim: sanitizedLimit });

    const valueDisplay = derive(sanitizedValue, (v) => formatCount(v));
    const limitDisplay = derive(sanitizedLimit, (l) => formatCount(l));
    const differenceDisplay = derive(difference, (d) => formatCount(d));

    const summary =
      str`Value ${valueDisplay} / Limit ${limitDisplay} (Δ ${differenceDisplay})`;

    const stepField = cell<string>("1");
    const valueField = cell<string>("0");
    const limitField = cell<string>("10");

    const syncStepField = compute(() => {
      const text = formatCount(sanitizedStep.get());
      if (stepField.get() !== text) {
        stepField.set(text);
      }
    });

    const syncValueField = compute(() => {
      const text = formatCount(sanitizedValue.get());
      if (valueField.get() !== text) {
        valueField.set(text);
      }
    });

    const syncLimitField = compute(() => {
      const text = formatCount(sanitizedLimit.get());
      if (limitField.get() !== text) {
        limitField.set(text);
      }
    });

    const increaseValue = handler<
      unknown,
      {
        step: Cell<number>;
        value: Cell<number>;
        limit: Cell<number>;
        audit: Cell<ValidationEntry[]>;
      }
    >((_event, { step, value, limit, audit }) => {
      const stepVal = toPositiveStep(step.get(), 1);
      const current = toInteger(value.get(), 0);
      value.set(current + stepVal);
      recordSnapshot(audit, value, limit);
    })({ step, value, limit, audit: auditTrail });

    const decreaseValue = handler<
      unknown,
      {
        step: Cell<number>;
        value: Cell<number>;
        limit: Cell<number>;
        audit: Cell<ValidationEntry[]>;
      }
    >((_event, { step, value, limit, audit }) => {
      const stepVal = toPositiveStep(step.get(), 1);
      const current = toInteger(value.get(), 0);
      value.set(current - stepVal);
      recordSnapshot(audit, value, limit);
    })({ step, value, limit, audit: auditTrail });

    const applyValueChange = handler<
      unknown,
      {
        input: Cell<string>;
        value: Cell<number>;
        limit: Cell<number>;
        audit: Cell<ValidationEntry[]>;
      }
    >((_event, { input, value, limit, audit }) => {
      const text = input.get() ?? "0";
      const parsed = Number(text);
      const newValue = toInteger(parsed, 0);
      value.set(newValue);
      recordSnapshot(audit, value, limit);
    })({ input: valueField, value, limit, audit: auditTrail });

    const applyLimitChange = handler<
      unknown,
      {
        input: Cell<string>;
        limit: Cell<number>;
        value: Cell<number>;
        audit: Cell<ValidationEntry[]>;
      }
    >((_event, { input, limit, value, audit }) => {
      const text = input.get() ?? "10";
      const parsed = Number(text);
      const newLimit = toInteger(parsed, 10);
      limit.set(newLimit);
      recordSnapshot(audit, value, limit);
    })({ input: limitField, limit, value, audit: auditTrail });

    const applyStepChange = handler<
      unknown,
      {
        input: Cell<string>;
        step: Cell<number>;
      }
    >((_event, { input, step }) => {
      const text = input.get() ?? "1";
      const parsed = Number(text);
      const newStep = toPositiveStep(parsed, 1);
      step.set(newStep);
    })({ input: stepField, step });

    const auditLength = derive(auditTrail, (trail) => trail.length);

    const name = str`Cross-field validation (${valueDisplay})`;

    const errorBorder = lift((error: boolean) =>
      error ? "border: 2px solid #ef4444;" : "border: 2px solid #10b981;"
    )(hasError);

    const errorBg = lift((error: boolean) =>
      error ? "background: #fee2e2;" : "background: #d1fae5;"
    )(hasError);

    const errorText = lift((error: boolean) =>
      error ? "color: #991b1b;" : "color: #065f46;"
    )(hasError);

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
                  Cross-field validation
                </span>
                <h2 style="
                    margin: 0;
                    font-size: 1.3rem;
                    color: #0f172a;
                  ">
                  Value must not exceed limit
                </h2>
                <p style="
                    margin: 0;
                    font-size: 0.9rem;
                    color: #64748b;
                  ">
                  Demonstrates validation that depends on multiple fields. The
                  audit trail records each state change.
                </p>
              </div>

              <div
                style={lift(
                  (border: string) =>
                    `${border} border-radius: 0.75rem; padding: 1rem; display: flex; flex-direction: column; gap: 0.75rem;`,
                )(errorBorder)}
              >
                <div style="
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                  ">
                  <div style="
                      display: flex;
                      flex-direction: column;
                      gap: 0.25rem;
                    ">
                    <span style="font-size: 0.8rem; color: #475569;">
                      Current value
                    </span>
                    <strong style="font-size: 2.5rem; color: #0f172a;">
                      {valueDisplay}
                    </strong>
                  </div>
                  <div style="
                      display: flex;
                      flex-direction: column;
                      gap: 0.25rem;
                      align-items: flex-end;
                    ">
                    <span style="font-size: 0.8rem; color: #475569;">
                      Limit
                    </span>
                    <strong style="font-size: 2.5rem; color: #0f172a;">
                      {limitDisplay}
                    </strong>
                  </div>
                </div>

                <div
                  style={lift(
                    (bg: string) =>
                      `${bg} padding: 0.75rem; border-radius: 0.5rem; display: flex; justify-content: space-between; align-items: center;`,
                  )(errorBg)}
                >
                  <span
                    style={lift(
                      (text: string) => `${text} font-weight: 500;`,
                    )(errorText)}
                  >
                    {lift((error: boolean) =>
                      error ? "⚠️ Value exceeds limit" : "✓ Valid state"
                    )(hasError)}
                  </span>
                  <span
                    style={lift(
                      (text: string) => `${text} font-size: 0.85rem;`,
                    )(errorText)}
                  >
                    Difference: {differenceDisplay}
                  </span>
                </div>
              </div>

              <div style="
                  display: grid;
                  grid-template-columns: repeat(3, minmax(0, 1fr));
                  gap: 0.75rem;
                ">
                <div style="
                    display: flex;
                    flex-direction: column;
                    gap: 0.4rem;
                  ">
                  <label
                    for="value-input"
                    style="
                      font-size: 0.85rem;
                      font-weight: 500;
                      color: #334155;
                    "
                  >
                    Value
                  </label>
                  <ct-input
                    id="value-input"
                    type="number"
                    step="1"
                    $value={valueField}
                    aria-label="Set current value"
                  >
                  </ct-input>
                  <ct-button
                    variant="secondary"
                    onClick={applyValueChange}
                    style="margin-top: 0.25rem;"
                  >
                    Apply
                  </ct-button>
                </div>

                <div style="
                    display: flex;
                    flex-direction: column;
                    gap: 0.4rem;
                  ">
                  <label
                    for="limit-input"
                    style="
                      font-size: 0.85rem;
                      font-weight: 500;
                      color: #334155;
                    "
                  >
                    Limit
                  </label>
                  <ct-input
                    id="limit-input"
                    type="number"
                    step="1"
                    $value={limitField}
                    aria-label="Set limit"
                  >
                  </ct-input>
                  <ct-button
                    variant="secondary"
                    onClick={applyLimitChange}
                    style="margin-top: 0.25rem;"
                  >
                    Apply
                  </ct-button>
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
                    aria-label="Set step size"
                  >
                  </ct-input>
                  <ct-button
                    variant="secondary"
                    onClick={applyStepChange}
                    style="margin-top: 0.25rem;"
                  >
                    Apply
                  </ct-button>
                </div>
              </div>

              <div style="
                  display: flex;
                  gap: 0.5rem;
                  flex-wrap: wrap;
                ">
                <ct-button onClick={increaseValue} aria-label="Increase value">
                  Increase by {sanitizedStep}
                </ct-button>
                <ct-button
                  variant="secondary"
                  onClick={decreaseValue}
                  aria-label="Decrease value"
                >
                  Decrease by {sanitizedStep}
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
                Audit trail
              </h3>
              <span style="
                  background: #e2e8f0;
                  color: #475569;
                  padding: 0.25rem 0.5rem;
                  border-radius: 0.25rem;
                  font-size: 0.75rem;
                  font-weight: 600;
                ">
                {auditLength} entries
              </span>
            </div>
            <div
              slot="content"
              style="
                display: flex;
                flex-direction: column;
                gap: 0.5rem;
                max-height: 16rem;
                overflow-y: auto;
              "
            >
              {lift((trail: ValidationEntry[]) => {
                if (trail.length === 0) {
                  return (
                    <div style="
                        padding: 1rem;
                        text-align: center;
                        color: #94a3b8;
                        font-size: 0.9rem;
                      ">
                      No validation events recorded yet
                    </div>
                  );
                }
                return trail
                  .slice()
                  .reverse()
                  .map((entry, index) => (
                    <div
                      key={trail.length - index}
                      style={entry.hasError
                        ? "background: #fef2f2; border: 1px solid #fecaca; padding: 0.75rem; border-radius: 0.5rem;"
                        : "background: #f0fdf4; border: 1px solid #bbf7d0; padding: 0.75rem; border-radius: 0.5rem;"}
                    >
                      <div style="
                          display: flex;
                          justify-content: space-between;
                          font-size: 0.85rem;
                        ">
                        <span
                          style={entry.hasError
                            ? "color: #991b1b;"
                            : "color: #166534;"}
                        >
                          {entry.hasError ? "⚠️ Invalid" : "✓ Valid"}
                        </span>
                        <span style="color: #475569; font-weight: 500;">
                          Value: {entry.value} / Limit: {entry.limit}
                        </span>
                      </div>
                    </div>
                  ));
              })(auditTrail)}
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
      value,
      limit,
      step,
      currentValue: sanitizedValue,
      limitValue: sanitizedLimit,
      stepSize: sanitizedStep,
      difference,
      hasError,
      summary,
      auditTrail,
      valueDisplay,
      limitDisplay,
      differenceDisplay,
      auditLength,
      effects: {
        syncStepField,
        syncValueField,
        syncLimitField,
      },
      controls: {
        increaseValue,
        decreaseValue,
        applyValueChange,
        applyLimitChange,
        applyStepChange,
      },
    };
  },
);

export default counterCrossFieldValidationUx;
