/// <cts-enable />
import {
  Cell,
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

interface ResetCounterArgs {
  value: Default<number, 0>;
  baseline: Default<number, 0>;
}

const applyDelta = handler(
  (
    event: { amount?: number } | undefined,
    context: { value: Cell<number> },
  ) => {
    const amount = typeof event?.amount === "number" ? event.amount : 1;
    const next = (context.value.get() ?? 0) + amount;
    context.value.set(next);
  },
);

const resetCounter = handler(
  (
    _event: unknown,
    context: { value: Cell<number>; baseline: Cell<number> },
  ) => {
    const target = context.baseline.get() ?? 0;
    context.value.set(target);
  },
);

// UI-specific handlers
const incrementBy = (amount: number) =>
  handler(
    (_event: unknown, context: { value: Cell<number> }) => {
      const current = context.value.get();
      const next = (current ?? 0) + amount;
      context.value.set(next);
    },
  );

const resetToBaseline = handler(
  (
    _event: unknown,
    context: { value: Cell<number>; baseline: Cell<number> },
  ) => {
    const target = context.baseline.get() ?? 0;
    context.value.set(target);
  },
);

const setBaseline = handler(
  (
    _event: unknown,
    context: { baseline: Cell<number>; field: Cell<string> },
  ) => {
    const text = context.field.get();
    if (typeof text === "string" && text.trim() !== "") {
      const parsed = parseInt(text.trim(), 10);
      if (!isNaN(parsed)) {
        context.baseline.set(parsed);
        context.field.set("");
      }
    }
  },
);

export const counterWithReset = recipe<ResetCounterArgs>(
  "Counter With Reset",
  ({ value, baseline }) => {
    const normalizedValue = derive(
      value,
      (v) => (typeof v === "number" ? v : 0),
    );

    const normalizedBaseline = derive(
      baseline,
      (b) => (typeof b === "number" ? b : 0),
    );

    const difference = lift(
      (inputs: { val: number; base: number }) => inputs.val - inputs.base,
    )({ val: normalizedValue, base: normalizedBaseline });

    const isAtBaseline = lift(
      (diff: number) => diff === 0,
    )(difference);

    // UI state
    const baselineField = cell("");

    const statusColor = lift((atBase: boolean) =>
      atBase
        ? "background: linear-gradient(135deg, #10b981 0%, #059669 100%);"
        : "background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%);"
    )(isAtBaseline);

    const resetBtnDisabled = lift((atBase: boolean) => atBase)(isAtBaseline);

    const name = str`Counter with Reset: ${normalizedValue}`;
    const ui = (
      <div style="max-width: 600px; margin: 0 auto; padding: 1rem; font-family: system-ui, -apple-system, sans-serif;">
        <div style="background: #f8fafc; border-radius: 8px; padding: 1.5rem; margin-bottom: 1.5rem;">
          <h2 style="margin: 0 0 0.5rem 0; font-size: 1.125rem; color: #1e293b; font-weight: 600;">
            Counter With Reset
          </h2>
          <p style="margin: 0; font-size: 0.875rem; color: #64748b; line-height: 1.5;">
            Increment or decrement the counter, then reset it back to the
            baseline value.
          </p>
        </div>

        <div style={statusColor}>
          <div style="padding: 2rem; text-align: center; color: white;">
            <div style="font-size: 3.5rem; font-weight: 700; margin-bottom: 0.5rem;">
              {normalizedValue}
            </div>
            <div
              style={lift(
                (atBase: boolean) =>
                  atBase
                    ? "font-size: 1rem; font-weight: 500; opacity: 0.95;"
                    : "display: none;",
              )(isAtBaseline)}
            >
              ✓ At baseline
            </div>
          </div>
        </div>

        <div style="margin-top: 1.5rem; background: white; border: 2px solid #e2e8f0; border-radius: 8px; padding: 1rem;">
          <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 0.75rem; margin-bottom: 1rem;">
            <div style="text-align: center;">
              <div style="font-size: 0.875rem; color: #64748b; margin-bottom: 0.25rem;">
                Baseline
              </div>
              <div style="font-size: 1.5rem; font-weight: 600; color: #1e293b; font-family: monospace;">
                {normalizedBaseline}
              </div>
            </div>
            <div style="text-align: center;">
              <div style="font-size: 0.875rem; color: #64748b; margin-bottom: 0.25rem;">
                Current
              </div>
              <div style="font-size: 1.5rem; font-weight: 600; color: #1e293b; font-family: monospace;">
                {normalizedValue}
              </div>
            </div>
            <div style="text-align: center;">
              <div style="font-size: 0.875rem; color: #64748b; margin-bottom: 0.25rem;">
                Difference
              </div>
              <div
                style={lift(
                  (diff: number) => {
                    const color = diff > 0
                      ? "#10b981"
                      : diff < 0
                      ? "#ef4444"
                      : "#64748b";
                    return (
                      "font-size: 1.5rem; font-weight: 600; font-family: monospace; color: " +
                      color +
                      ";"
                    );
                  },
                )(difference)}
              >
                {lift((diff: number) =>
                  diff > 0 ? "+" + String(diff) : String(diff)
                )(difference)}
              </div>
            </div>
          </div>
        </div>

        <div style="margin-top: 1.5rem; display: flex; gap: 0.5rem; flex-wrap: wrap; justify-content: center;">
          <ct-button
            onClick={incrementBy(-10)({ value })}
            style="flex: 1; min-width: 80px;"
          >
            -10
          </ct-button>
          <ct-button
            onClick={incrementBy(-5)({ value })}
            style="flex: 1; min-width: 80px;"
          >
            -5
          </ct-button>
          <ct-button
            onClick={incrementBy(-1)({ value })}
            style="flex: 1; min-width: 80px;"
          >
            -1
          </ct-button>
          <ct-button
            onClick={incrementBy(1)({ value })}
            style="flex: 1; min-width: 80px;"
          >
            +1
          </ct-button>
          <ct-button
            onClick={incrementBy(5)({ value })}
            style="flex: 1; min-width: 80px;"
          >
            +5
          </ct-button>
          <ct-button
            onClick={incrementBy(10)({ value })}
            style="flex: 1; min-width: 80px;"
          >
            +10
          </ct-button>
        </div>

        <div style="margin-top: 1rem; text-align: center;">
          <ct-button
            onClick={resetToBaseline({ value, baseline })}
            disabled={resetBtnDisabled}
            style="padding: 0.75rem 2rem; font-size: 1rem; font-weight: 600;"
          >
            Reset to Baseline
          </ct-button>
        </div>

        <div style="margin-top: 2rem; background: white; border: 2px solid #e2e8f0; border-radius: 8px; padding: 1.5rem;">
          <h3 style="margin: 0 0 1rem 0; font-size: 1rem; color: #1e293b; font-weight: 600;">
            Update Baseline
          </h3>
          <div style="display: flex; gap: 0.5rem;">
            <ct-input
              $value={baselineField}
              type="number"
              placeholder="New baseline..."
              style="flex: 1;"
            />
            <ct-button
              onClick={setBaseline({
                baseline,
                field: baselineField,
              })}
            >
              Set Baseline
            </ct-button>
          </div>
          <div style="margin-top: 0.75rem; font-size: 0.875rem; color: #64748b;">
            The baseline is the target value when you reset the counter.
          </div>
        </div>

        <div style="margin-top: 1.5rem; background: #fefce8; border: 2px solid #fde047; border-radius: 8px; padding: 1rem;">
          <div style="font-size: 0.875rem; color: #854d0e; font-weight: 500; margin-bottom: 0.5rem;">
            Pattern Details
          </div>
          <div style="font-size: 0.875rem; color: #a16207; line-height: 1.5;">
            This pattern demonstrates a counter that can be reset to a
            configurable baseline value. The counter turns green when it matches
            the baseline, and the reset button is disabled to prevent redundant
            operations.
          </div>
        </div>
      </div>
    );

    return {
      [NAME]: name,
      [UI]: ui,
      value,
      baseline,
      label: str`Value ${normalizedValue}`,
      increment: applyDelta({ value }),
      reset: resetCounter({ value, baseline }),
    };
  },
);
