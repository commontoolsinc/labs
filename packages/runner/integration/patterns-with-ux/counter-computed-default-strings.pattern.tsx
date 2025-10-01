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

interface ComputedDefaultStringsArgs {
  value: Default<number, 0>;
  prefix: Default<string, "Count">;
}

const adjustValue = handler(
  (
    event: { amount?: number } | undefined,
    context: { value: Cell<number> },
  ) => {
    const amount = typeof event?.amount === "number" ? event.amount : 1;
    const current = context.value.get();
    const base = typeof current === "number" ? current : 0;
    context.value.set(base + amount);
  },
);

const setOverrideLabel = handler(
  (
    event: { text?: string } | undefined,
    context: { label: Cell<string | undefined> },
  ) => {
    const next = typeof event?.text === "string" && event.text.length > 0
      ? event.text
      : undefined;
    context.label.set(next);
  },
);

// UI-specific handlers
const incrementBy = (amount: number) =>
  handler(
    (_event: unknown, context: { value: Cell<number> }) => {
      const current = context.value.get();
      const base = typeof current === "number" ? current : 0;
      context.value.set(base + amount);
    },
  );

const clearOverride = handler(
  (_event: unknown, context: { label: Cell<string | undefined> }) => {
    context.label.set(undefined);
  },
);

const setOverrideFromField = handler(
  (
    _event: unknown,
    context: { label: Cell<string | undefined>; field: Cell<string> },
  ) => {
    const text = context.field.get();
    const next = typeof text === "string" && text.trim().length > 0
      ? text.trim()
      : undefined;
    context.label.set(next);
    context.field.set("");
  },
);

export const counterWithComputedDefaultStrings = recipe<
  ComputedDefaultStringsArgs
>(
  "Counter With Computed Default Strings",
  ({ value, prefix }) => {
    const override = cell<string | undefined>();
    const normalizedValue = derive(
      value,
      (count) => (typeof count === "number" ? count : 0),
    );

    const fallbackLabel = lift(
      (
        inputs: { prefix: string | undefined; count: number },
      ) => {
        const base = typeof inputs.prefix === "string" &&
            inputs.prefix.length > 0
          ? inputs.prefix
          : "Count";
        return `${base} ${inputs.count}`;
      },
    )({
      prefix,
      count: normalizedValue,
    });

    const label = lift(
      (
        inputs: { override?: string; fallback: string },
      ) =>
        typeof inputs.override === "string" ? inputs.override : inputs.fallback,
    )({
      override,
      fallback: fallbackLabel,
    });

    const summary = str`${label} (current: ${normalizedValue})`;

    // UI state
    const labelField = cell("");

    compute(() => {
      const o = override.get();
      const current = labelField.get();
      if (o === undefined && (!current || current === "")) {
        labelField.set("");
      }
    });

    const hasOverride = lift(
      (o: string | undefined) => typeof o === "string",
    )(override);

    const statusColor = lift((has: boolean) =>
      has
        ? "background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);"
        : "background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%);"
    )(hasOverride);

    const name = str`Counter: ${label}`;
    const ui = (
      <div style="max-width: 600px; margin: 0 auto; padding: 1rem; font-family: system-ui, -apple-system, sans-serif;">
        <div style="background: #f8fafc; border-radius: 8px; padding: 1.5rem; margin-bottom: 1.5rem;">
          <h2 style="margin: 0 0 0.5rem 0; font-size: 1.125rem; color: #1e293b; font-weight: 600;">
            Computed Default Strings
          </h2>
          <p style="margin: 0; font-size: 0.875rem; color: #64748b; line-height: 1.5;">
            Label falls back to "
            <span style="font-family: monospace; color: #3b82f6;">
              {fallbackLabel}
            </span>" unless overridden
          </p>
        </div>

        <div style={statusColor}>
          <div style="padding: 2rem; text-align: center; color: white;">
            <div style="font-size: 3rem; font-weight: 700; margin-bottom: 0.5rem;">
              {normalizedValue}
            </div>
            <div style="font-size: 1.25rem; font-weight: 500; opacity: 0.95;">
              {label}
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
            onClick={incrementBy(10)({ value })}
            style="flex: 1; min-width: 80px;"
          >
            +10
          </ct-button>
        </div>

        <div style="margin-top: 2rem; background: white; border: 2px solid #e2e8f0; border-radius: 8px; padding: 1.5rem;">
          <h3 style="margin: 0 0 1rem 0; font-size: 1rem; color: #1e293b; font-weight: 600;">
            Label Override
          </h3>

          <div
            style={lift(
              (has: boolean) =>
                has
                  ? "background: #dbeafe; border: 2px solid #3b82f6; border-radius: 6px; padding: 1rem; margin-bottom: 1rem;"
                  : "display: none;",
            )(hasOverride)}
          >
            <div style="display: flex; justify-content: space-between; align-items: center;">
              <span style="font-size: 0.875rem; color: #1e40af; font-weight: 500;">
                Override active:
                <span style="font-family: monospace; margin-left: 0.5rem;">
                  {override}
                </span>
              </span>
              <ct-button
                onClick={clearOverride({ label: override })}
                style="font-size: 0.75rem; padding: 0.25rem 0.75rem;"
              >
                Clear
              </ct-button>
            </div>
          </div>

          <div style="display: flex; gap: 0.5rem;">
            <ct-input
              $value={labelField}
              placeholder="Custom label..."
              style="flex: 1;"
            />
            <ct-button
              onClick={setOverrideFromField({
                label: override,
                field: labelField,
              })}
            >
              Set Label
            </ct-button>
          </div>

          <div style="margin-top: 0.75rem; font-size: 0.875rem; color: #64748b;">
            Default behavior:
            <span style="font-family: monospace; color: #475569; margin-left: 0.5rem;">
              prefix + " " + value
            </span>
          </div>
        </div>

        <div style="margin-top: 1.5rem; background: #fefce8; border: 2px solid #fde047; border-radius: 8px; padding: 1rem;">
          <div style="font-size: 0.875rem; color: #854d0e; font-weight: 500; margin-bottom: 0.5rem;">
            Pattern Details
          </div>
          <div style="font-size: 0.875rem; color: #a16207; line-height: 1.5;">
            <div>
              <strong>Prefix:</strong>
              <span style="font-family: monospace; margin-left: 0.5rem;">
                {prefix}
              </span>
            </div>
            <div style="margin-top: 0.25rem;">
              <strong>Fallback:</strong>
              <span style="font-family: monospace; margin-left: 0.5rem;">
                {fallbackLabel}
              </span>
            </div>
          </div>
        </div>
      </div>
    );

    return {
      [NAME]: name,
      [UI]: ui,
      value,
      prefix,
      current: normalizedValue,
      label,
      fallbackLabel,
      summary,
      overrides: {
        label: override,
      },
      increment: adjustValue({ value }),
      setLabel: setOverrideLabel({ label: override }),
    };
  },
);
