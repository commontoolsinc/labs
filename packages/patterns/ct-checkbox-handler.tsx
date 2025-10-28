/// <cts-enable />
import { Default, ifElse, NAME, recipe, UI } from "commontools";

interface CheckboxSimpleInput {
  enabled: Default<boolean, false>;
}

interface CheckboxSimpleOutput extends CheckboxSimpleInput {}

export default recipe<CheckboxSimpleInput, CheckboxSimpleOutput>(
  "ct-checkbox simple demo",
  ({ enabled }) => {
    return {
      [NAME]: "Checkbox Demo",
      [UI]: (
        <common-vstack gap="md" style="padding: 2rem; max-width: 400px;">
          <h3>Simple ct-checkbox + ifElse Demo</h3>

          <ct-checkbox $checked={enabled}>
            Enable Feature
          </ct-checkbox>

          <p>Debug: enabled = {ifElse(enabled, "true", "false")}</p>

          <pre id="feature-status">
            {ifElse(enabled, "✓ Feature is enabled!", "⚠ Feature is disabled")}
          </pre>

          <p data-testid="status">
            Status: {ifElse(enabled, "ON", "OFF")}
          </p>
        </common-vstack>
      ),
      enabled,
    };
  },
);
