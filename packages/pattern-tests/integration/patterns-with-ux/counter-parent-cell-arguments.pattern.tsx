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

const sanitizeCount = (value: number | undefined): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.trunc(value);
};

const sanitizeStep = (value: number | undefined): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) return 1;
  const whole = Math.trunc(value);
  if (whole === 0) return 1;
  return Math.abs(whole);
};

const resolveDelta = (amount: number | undefined, fallback: number): number => {
  if (typeof amount !== "number" || !Number.isFinite(amount)) return fallback;
  const whole = Math.trunc(amount);
  if (whole === 0) return fallback;
  return whole;
};

const incrementShared = handler(
  (
    event: { amount?: number } | undefined,
    context: { value: Cell<number>; step: Cell<number> },
  ) => {
    const step = sanitizeStep(context.step.get());
    const delta = resolveDelta(event?.amount, step);
    const current = sanitizeCount(context.value.get());
    context.value.set(current + delta);
  },
);

const setSharedValue = handler(
  (
    event: { value?: number } | number | undefined,
    context: { value: Cell<number> },
  ) => {
    const candidate = typeof event === "number"
      ? event
      : typeof event?.value === "number"
      ? event.value
      : undefined;
    context.value.set(sanitizeCount(candidate));
  },
);

const updateSharedStep = handler(
  (
    event: { step?: number } | number | undefined,
    context: { step: Cell<number> },
  ) => {
    const candidate = typeof event === "number"
      ? event
      : typeof event?.step === "number"
      ? event.step
      : undefined;
    context.step.set(sanitizeStep(candidate));
  },
);

interface LinkedChildArgs {
  sharedValue: Default<number, 0>;
  sharedStep: Default<number, 1>;
}

const childLinkedCounter = recipe<LinkedChildArgs>(
  "Child Counter Referencing Parent Cells",
  ({ sharedValue, sharedStep }) => {
    const current = lift(sanitizeCount)(sharedValue);
    const step = lift(sanitizeStep)(sharedStep);
    const nextPreview = lift(
      (state: { current: number; step: number }) => state.current + state.step,
    )({
      current,
      step,
    });
    const parity = lift((value: number) => value % 2 === 0 ? "even" : "odd")(
      current,
    );
    const label = str`Child sees ${current} (step ${step}) [${parity}]`;

    return {
      current,
      step,
      parity,
      nextPreview,
      label,
      increment: incrementShared({ value: sharedValue, step: sharedStep }),
      setAbsolute: setSharedValue({ value: sharedValue }),
    };
  },
);

interface ParentCellArgumentArgs {
  value: Default<number, 0>;
  step: Default<number, 1>;
}

export const counterWithParentCellArgumentsUx = recipe<ParentCellArgumentArgs>(
  "Counter With Parent Cell Arguments (UX)",
  ({ value, step }) => {
    const current = lift(sanitizeCount)(value);
    const stepSize = lift(sanitizeStep)(step);
    const parentPreview = lift(
      (state: { current: number; step: number }) => state.current + state.step,
    )({
      current,
      step: stepSize,
    });

    const child = childLinkedCounter({
      sharedValue: value,
      sharedStep: step,
    });

    const alignment = lift(
      (state: { parent: number; child: number }) =>
        state.parent === state.child,
    )({
      parent: current,
      child: child.key("current"),
    });

    const sharedLabel = str`Parent ${current} child ${child.key("current")}`;

    const valueField = cell<string>("");
    const stepField = cell<string>("");

    const syncValueField = compute(() => {
      const currentStr = String(sanitizeCount(value.get()));
      if (valueField.get() !== currentStr) {
        valueField.set(currentStr);
      }
    });

    const syncStepField = compute(() => {
      const stepStr = String(sanitizeStep(step.get()));
      if (stepField.get() !== stepStr) {
        stepField.set(stepStr);
      }
    });

    const applySetValue = handler<
      unknown,
      { value: Cell<number>; field: Cell<string> }
    >((_event, { value, field }) => {
      const parsed = Number(field.get());
      if (Number.isFinite(parsed)) {
        value.set(sanitizeCount(parsed));
      }
    })({ value, field: valueField });

    const applySetStep = handler<
      unknown,
      { step: Cell<number>; field: Cell<string> }
    >((_event, { step, field }) => {
      const parsed = Number(field.get());
      if (Number.isFinite(parsed)) {
        step.set(sanitizeStep(parsed));
      }
    })({ step, field: stepField });

    const name = str`Parent-Child Cell Arguments (${current})`;

    const childParityColor = lift((parity: string) => {
      return parity === "even" ? "#10b981" : "#f59e0b";
    })(child.key("parity"));

    const alignmentIndicator = lift((aligned: boolean) => {
      if (aligned) {
        return (
          <div style="
              display: inline-flex;
              align-items: center;
              gap: 0.5rem;
              background: #dcfce7;
              color: #16a34a;
              padding: 0.5rem 1rem;
              border-radius: 0.5rem;
              font-size: 0.85rem;
              font-weight: 500;
            ">
            <span style="
                width: 8px;
                height: 8px;
                border-radius: 50%;
                background: #16a34a;
              ">
            </span>
            Values aligned
          </div>
        );
      }
      return (
        <div style="
            display: inline-flex;
            align-items: center;
            gap: 0.5rem;
            background: #fee2e2;
            color: #dc2626;
            padding: 0.5rem 1rem;
            border-radius: 0.5rem;
            font-size: 0.85rem;
            font-weight: 500;
          ">
          <span style="
              width: 8px;
              height: 8px;
              border-radius: 50%;
              background: #dc2626;
            ">
          </span>
          Values misaligned
        </div>
      );
    })(alignment);

    return {
      [NAME]: name,
      [UI]: (
        <div style="
            display: flex;
            flex-direction: column;
            gap: 1.5rem;
            max-width: 56rem;
          ">
          <ct-card>
            <div
              slot="content"
              style="
                display: flex;
                flex-direction: column;
                gap: 1rem;
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
                  Parent Cell Arguments Pattern
                </span>
                <h2 style="
                    margin: 0;
                    font-size: 1.3rem;
                    color: #0f172a;
                  ">
                  Parent cells passed to child recipe
                </h2>
                <p style="
                    margin: 0;
                    font-size: 0.9rem;
                    color: #64748b;
                  ">
                  Demonstrates sharing state between parent and child recipes by
                  passing parent cells as arguments. Both parent and child
                  handlers mutate the same underlying cells.
                </p>
              </div>

              {alignmentIndicator}

              <div style="
                  display: grid;
                  grid-template-columns: repeat(2, 1fr);
                  gap: 1rem;
                ">
                <ct-card>
                  <div slot="header">
                    <h3 style="
                        margin: 0;
                        font-size: 1rem;
                        color: #2563eb;
                        display: flex;
                        align-items: center;
                        gap: 0.5rem;
                      ">
                      <span style="
                          width: 8px;
                          height: 8px;
                          border-radius: 50%;
                          background: #2563eb;
                        ">
                      </span>
                      Parent Counter
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
                        background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%);
                        color: white;
                        padding: 1.5rem;
                        border-radius: 0.75rem;
                        text-align: center;
                      ">
                      <div style="
                          font-size: 0.75rem;
                          opacity: 0.9;
                          margin-bottom: 0.5rem;
                        ">
                        Current value
                      </div>
                      <div style="font-size: 2.5rem; font-weight: 700;">
                        {current}
                      </div>
                      <div style="
                          font-size: 0.85rem;
                          opacity: 0.85;
                          margin-top: 0.5rem;
                        ">
                        Next: {parentPreview}
                      </div>
                    </div>

                    <ct-button
                      onClick={incrementShared({ value, step })}
                      aria-label="Parent increment"
                    >
                      Parent +{stepSize}
                    </ct-button>

                    <div style="
                        display: flex;
                        flex-direction: column;
                        gap: 0.5rem;
                      ">
                      <label style="
                          font-size: 0.85rem;
                          font-weight: 500;
                          color: #334155;
                        ">
                        Set value
                      </label>
                      <div style="
                          display: flex;
                          gap: 0.5rem;
                        ">
                        <ct-input
                          type="number"
                          $value={valueField}
                          placeholder="0"
                          aria-label="Parent set value"
                        >
                        </ct-input>
                        <ct-button
                          variant="secondary"
                          onClick={applySetValue}
                          style="white-space: nowrap;"
                        >
                          Set
                        </ct-button>
                      </div>
                    </div>

                    <div style="
                        display: flex;
                        flex-direction: column;
                        gap: 0.5rem;
                      ">
                      <label style="
                          font-size: 0.85rem;
                          font-weight: 500;
                          color: #334155;
                        ">
                        Step size
                      </label>
                      <div style="
                          display: flex;
                          gap: 0.5rem;
                        ">
                        <ct-input
                          type="number"
                          $value={stepField}
                          min="1"
                          placeholder="1"
                          aria-label="Parent set step"
                        >
                        </ct-input>
                        <ct-button
                          variant="secondary"
                          onClick={applySetStep}
                          style="white-space: nowrap;"
                        >
                          Set
                        </ct-button>
                      </div>
                    </div>
                  </div>
                </ct-card>

                <ct-card>
                  <div slot="header">
                    <h3 style="
                        margin: 0;
                        font-size: 1rem;
                        color: #ec4899;
                        display: flex;
                        align-items: center;
                        gap: 0.5rem;
                      ">
                      <span style="
                          width: 8px;
                          height: 8px;
                          border-radius: 50%;
                          background: #ec4899;
                        ">
                      </span>
                      Child Counter
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
                        background: linear-gradient(135deg, #ec4899 0%, #db2777 100%);
                        color: white;
                        padding: 1.5rem;
                        border-radius: 0.75rem;
                        text-align: center;
                      ">
                      <div style="
                          font-size: 0.75rem;
                          opacity: 0.9;
                          margin-bottom: 0.5rem;
                        ">
                        Current value
                      </div>
                      <div style="font-size: 2.5rem; font-weight: 700;">
                        {child.key("current")}
                      </div>
                      <div style="
                          font-size: 0.85rem;
                          opacity: 0.85;
                          margin-top: 0.5rem;
                        ">
                        Next: {child.key("nextPreview")}
                      </div>
                    </div>

                    <ct-button
                      onClick={child.key("increment")}
                      aria-label="Child increment"
                    >
                      Child +{child.key("step")}
                    </ct-button>

                    <div style="
                        background: #fef3f2;
                        border-radius: 0.5rem;
                        padding: 1rem;
                        border: 1px solid #fee2e2;
                      ">
                      <div style="
                          font-size: 0.85rem;
                          font-weight: 500;
                          color: #334155;
                          margin-bottom: 0.5rem;
                        ">
                        Child derives
                      </div>
                      <div style="
                          display: flex;
                          flex-direction: column;
                          gap: 0.5rem;
                          font-size: 0.85rem;
                          color: #475569;
                        ">
                        <div style="
                            display: flex;
                            justify-content: space-between;
                          ">
                          <span>Parity:</span>
                          <strong
                            style={lift(
                              (color: string) => "color: " + color + ";",
                            )(childParityColor)}
                          >
                            {child.key("parity")}
                          </strong>
                        </div>
                        <div style="
                            display: flex;
                            justify-content: space-between;
                          ">
                          <span>Step:</span>
                          <strong>{child.key("step")}</strong>
                        </div>
                      </div>
                    </div>
                  </div>
                </ct-card>
              </div>
            </div>
          </ct-card>

          <ct-card>
            <div slot="header">
              <h3 style="margin: 0; font-size: 1rem; color: #0f172a;">
                Shared state demonstration
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
                  background: #f8fafc;
                  border-radius: 0.5rem;
                  padding: 1rem;
                  border: 1px solid #e2e8f0;
                ">
                <div style="
                    font-size: 0.85rem;
                    color: #475569;
                    line-height: 1.6;
                  ">
                  <strong>Pattern behavior:</strong>{" "}
                  The parent recipe passes its <code>value</code> and{" "}
                  <code>step</code>{" "}
                  cells directly to the child recipe. When either parent or
                  child handlers modify these cells, both UIs update instantly
                  because they reference the same underlying state. This
                  demonstrates cell-level state sharing across recipe
                  boundaries.
                </div>
              </div>

              <div style="
                  background: #eff6ff;
                  border-radius: 0.5rem;
                  padding: 1rem;
                  border: 1px solid #dbeafe;
                ">
                <div style="
                    font-size: 0.85rem;
                    color: #1e40af;
                    font-family: monospace;
                  ">
                  {sharedLabel}
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
            {sharedLabel}
          </div>
        </div>
      ),
      value,
      step,
      current,
      stepSize,
      parentPreview,
      alignment,
      sharedLabel,
      child,
      valueField,
      stepField,
      effects: {
        syncValueField,
        syncStepField,
      },
      controls: {
        increment: incrementShared({ value, step }),
        setAbsolute: setSharedValue({ value }),
        setStep: updateSharedStep({ step }),
        applySetValue,
        applySetStep,
      },
    };
  },
);

export default counterWithParentCellArgumentsUx;
