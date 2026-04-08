import { Default, ifElse, NAME, pattern, UI, Writable } from "commonfabric";

interface CheckboxSimpleInput {
  enabled: Writable<Default<boolean, false>>;
}

interface CheckboxSimpleOutput extends CheckboxSimpleInput {}

export default pattern<CheckboxSimpleInput, CheckboxSimpleOutput>(
  ({ enabled }) => {
    return {
      [NAME]: "Checkbox Demo",
      [UI]: (
        <cf-vstack gap="2" style="padding: 2rem; max-width: 400px;">
          <h3>Simple cf-checkbox + ifElse Demo</h3>

          <cf-checkbox $checked={enabled}>
            Enable Feature
          </cf-checkbox>

          <p>Debug: enabled = {ifElse(enabled, "true", "false")}</p>

          <pre id="feature-status">
            {ifElse(enabled, "✓ Feature is enabled!", "⚠ Feature is disabled")}
          </pre>

          <p data-testid="status">
            Status: {ifElse(enabled, "ON", "OFF")}
          </p>
        </cf-vstack>
      ),
      enabled,
    };
  },
);
