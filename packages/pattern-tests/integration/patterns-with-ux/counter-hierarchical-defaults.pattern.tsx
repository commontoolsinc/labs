/// <cts-enable />
// @ts-nocheck
import {
  type Cell,
  Default,
  h,
  handler,
  lift,
  NAME,
  recipe,
  str,
  UI,
} from "commontools";

interface FormattingConfig {
  prefix?: string;
  suffix?: string;
}

interface SettingsConfig {
  label?: string;
  step?: number;
  formatting?: FormattingConfig;
}

interface HierarchicalDefaultsArgs {
  value: Default<number, 0>;
  settings: Default<
    SettingsConfig,
    {
      label: "Counter";
      step: 1;
      formatting: { prefix: "Count"; suffix: "items" };
    }
  >;
}

interface AdjustContext {
  value: Cell<number>;
  step: Cell<number>;
}

const adjustWithDefaults = handler(
  (
    event: { amount?: number } | undefined,
    context: AdjustContext,
  ) => {
    const stepValue = context.step.get();
    const base = typeof stepValue === "number" && Number.isFinite(stepValue)
      ? stepValue
      : 1;
    const amount = typeof event?.amount === "number" ? event.amount : base;
    const current = context.value.get() ?? 0;
    context.value.set(current + amount);
  },
);

const defaults = {
  label: "Counter",
  step: 1,
  formatting: {
    prefix: "Count",
    suffix: "items",
  },
};

const normalizeSettings = (input: SettingsConfig | undefined) => {
  if (!input) {
    return defaults;
  }
  const formatting = typeof input.formatting === "object" && input.formatting
    ? input.formatting
    : {};
  return {
    label: typeof input.label === "string" && input.label.length > 0
      ? input.label
      : defaults.label,
    step: typeof input.step === "number" && Number.isFinite(input.step)
      ? input.step
      : defaults.step,
    formatting: {
      prefix: typeof formatting.prefix === "string" &&
          formatting.prefix.length > 0
        ? formatting.prefix
        : defaults.formatting.prefix,
      suffix: typeof formatting.suffix === "string" &&
          formatting.suffix.length > 0
        ? formatting.suffix
        : defaults.formatting.suffix,
    },
  };
};

export const counterWithHierarchicalDefaultsUx = recipe<
  HierarchicalDefaultsArgs
>(
  "Counter With Hierarchical Defaults (UX)",
  ({ value, settings }) => {
    const resolvedSettings = lift(normalizeSettings)(settings);
    const labelCell = resolvedSettings.key("label");
    const stepCell = resolvedSettings.key("step");
    const formattingCell = resolvedSettings.key("formatting");
    const prefixCell = formattingCell.key("prefix");
    const suffixCell = formattingCell.key("suffix");

    const display = str`${prefixCell} ${value} ${suffixCell}`;
    const summary = str`${labelCell}: ${value}`;

    const incrementValue = handler<
      unknown,
      { value: Cell<number>; step: Cell<number> }
    >((_event, ctx) => {
      const current = ctx.value.get() ?? 0;
      const stepValue = ctx.step.get() ?? 1;
      ctx.value.set(current + stepValue);
    })({ value, step: stepCell });

    const decrementValue = handler<
      unknown,
      { value: Cell<number>; step: Cell<number> }
    >((_event, ctx) => {
      const current = ctx.value.get() ?? 0;
      const stepValue = ctx.step.get() ?? 1;
      ctx.value.set(current - stepValue);
    })({ value, step: stepCell });

    const resetValue = handler<unknown, { value: Cell<number> }>(
      (_event, ctx) => {
        ctx.value.set(0);
      },
    )({ value });

    const name = str`${labelCell} with hierarchical defaults`;

    return {
      [NAME]: name,
      [UI]: (
        <div style="
            display: flex;
            flex-direction: column;
            gap: 1.5rem;
            max-width: 40rem;
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
                  Hierarchical defaults pattern
                </span>
                <h2 style="
                    margin: 0;
                    font-size: 1.25rem;
                    line-height: 1.4;
                    color: #0f172a;
                  ">
                  Counter with cascading configuration
                </h2>
                <p style="
                    margin: 0;
                    font-size: 0.9rem;
                    color: #64748b;
                    line-height: 1.5;
                  ">
                  Demonstrates how settings cascade from partial input through
                  normalization to resolved output, with multi-level defaults
                  for nested structures.
                </p>
              </div>

              <div style="
                  display: flex;
                  flex-direction: column;
                  gap: 0.75rem;
                  background: linear-gradient(135deg, #f1f5f9 0%, #e2e8f0 100%);
                  border-radius: 0.75rem;
                  padding: 1rem;
                  border: 2px solid #cbd5e1;
                ">
                <div style="
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                  ">
                  <span style="
                      font-size: 0.75rem;
                      color: #475569;
                      text-transform: uppercase;
                      letter-spacing: 0.08em;
                    ">
                    Formatted display
                  </span>
                  <ct-badge variant="outline">{summary}</ct-badge>
                </div>
                <div
                  data-testid="formatted-display"
                  style="
                    font-size: 2rem;
                    font-weight: 700;
                    text-align: center;
                    color: #0f172a;
                    padding: 0.5rem;
                  "
                >
                  {display}
                </div>
              </div>

              <div style="
                  display: flex;
                  gap: 0.5rem;
                  justify-content: center;
                  flex-wrap: wrap;
                ">
                <ct-button onClick={decrementValue} variant="secondary">
                  - Decrement
                </ct-button>
                <ct-button onClick={incrementValue}>+ Increment</ct-button>
                <ct-button onClick={resetValue} variant="outline">
                  Reset to 0
                </ct-button>
              </div>
            </div>
          </ct-card>

          <ct-card>
            <div slot="header">
              <h3 style="margin: 0; font-size: 1rem;">
                Resolved configuration (after defaults)
              </h3>
            </div>
            <div
              slot="content"
              style="
                display: grid;
                grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr));
                gap: 0.75rem;
              "
            >
              <div style="
                  display: flex;
                  flex-direction: column;
                  gap: 0.5rem;
                  padding: 0.75rem;
                  background: #f8fafc;
                  border-radius: 0.5rem;
                  border: 1px solid #e2e8f0;
                ">
                <span style="font-size: 0.75rem; color: #64748b;">Label</span>
                <div style="font-weight: 600; font-size: 1.1rem; color: #0f172a;">
                  {labelCell}
                </div>
              </div>

              <div style="
                  display: flex;
                  flex-direction: column;
                  gap: 0.5rem;
                  padding: 0.75rem;
                  background: #f8fafc;
                  border-radius: 0.5rem;
                  border: 1px solid #e2e8f0;
                ">
                <span style="font-size: 0.75rem; color: #64748b;">
                  Step size
                </span>
                <div style="font-weight: 600; font-size: 1.1rem; color: #0f172a;">
                  {stepCell}
                </div>
              </div>

              <div style="
                  display: flex;
                  flex-direction: column;
                  gap: 0.5rem;
                  padding: 0.75rem;
                  background: #f8fafc;
                  border-radius: 0.5rem;
                  border: 1px solid #e2e8f0;
                ">
                <span style="font-size: 0.75rem; color: #64748b;">Prefix</span>
                <div style="font-weight: 600; font-size: 1.1rem; color: #0f172a;">
                  {prefixCell}
                </div>
              </div>

              <div style="
                  display: flex;
                  flex-direction: column;
                  gap: 0.5rem;
                  padding: 0.75rem;
                  background: #f8fafc;
                  border-radius: 0.5rem;
                  border: 1px solid #e2e8f0;
                ">
                <span style="font-size: 0.75rem; color: #64748b;">Suffix</span>
                <div style="font-weight: 600; font-size: 1.1rem; color: #0f172a;">
                  {suffixCell}
                </div>
              </div>
            </div>
          </ct-card>

          <ct-card>
            <div slot="header">
              <h3 style="margin: 0; font-size: 1rem;">
                Built-in default values
              </h3>
            </div>
            <div
              slot="content"
              style="
                display: grid;
                grid-template-columns: repeat(auto-fill, minmax(10rem, 1fr));
                gap: 0.5rem;
              "
            >
              <div style="
                  padding: 0.5rem;
                  background: #f1f5f9;
                  border-radius: 0.5rem;
                  border: 1px dashed #cbd5e1;
                ">
                <span style="font-size: 0.75rem; color: #64748b;">Label</span>
                <div style="font-weight: 600; color: #475569; font-family: monospace;">
                  "Counter"
                </div>
              </div>
              <div style="
                  padding: 0.5rem;
                  background: #f1f5f9;
                  border-radius: 0.5rem;
                  border: 1px dashed #cbd5e1;
                ">
                <span style="font-size: 0.75rem; color: #64748b;">Step</span>
                <div style="font-weight: 600; color: #475569; font-family: monospace;">
                  1
                </div>
              </div>
              <div style="
                  padding: 0.5rem;
                  background: #f1f5f9;
                  border-radius: 0.5rem;
                  border: 1px dashed #cbd5e1;
                ">
                <span style="font-size: 0.75rem; color: #64748b;">Prefix</span>
                <div style="font-weight: 600; color: #475569; font-family: monospace;">
                  "Count"
                </div>
              </div>
              <div style="
                  padding: 0.5rem;
                  background: #f1f5f9;
                  border-radius: 0.5rem;
                  border: 1px dashed #cbd5e1;
                ">
                <span style="font-size: 0.75rem; color: #64748b;">Suffix</span>
                <div style="font-weight: 600; color: #475569; font-family: monospace;">
                  "items"
                </div>
              </div>
            </div>
          </ct-card>

          <div style="
              padding: 0.75rem;
              background: #fef3c7;
              border-radius: 0.5rem;
              border-left: 4px solid #f59e0b;
            ">
            <strong style="
                font-size: 0.85rem;
                color: #92400e;
                display: block;
                margin-bottom: 0.25rem;
              ">
              About hierarchical defaults:
            </strong>
            <span style="font-size: 0.8rem; color: #78350f; line-height: 1.5;">
              The pattern normalizes partial settings through multiple levels.
              If a field is missing or invalid, it falls back to the default
              value. Nested structures (like formatting) cascade independently
              at each level.
            </span>
          </div>
        </div>
      ),
      value,
      settings,
      resolvedSettings,
      effectiveStep: stepCell,
      label: labelCell,
      prefix: prefixCell,
      suffix: suffixCell,
      display,
      summary,
      controls: {
        adjust: adjustWithDefaults({ value, step: stepCell }),
        incrementValue,
        decrementValue,
        resetValue,
      },
    };
  },
);

export default counterWithHierarchicalDefaultsUx;
