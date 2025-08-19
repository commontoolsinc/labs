/// <cts-enable />
import {
  Cell,
  Default,
  h,
  handler,
  ifElse,
  NAME,
  recipe,
  UI,
} from "commontools";

interface CheckboxSimpleInput {
  enabled: Default<boolean, false>;
}

interface CheckboxSimpleOutput extends CheckboxSimpleInput {}

export default recipe<CheckboxSimpleInput, CheckboxSimpleOutput>(
  "ct-checkbox simple demo",
  ({ enabled }) => {
    // Handler for checkbox changes
    const toggle = handler<
      { detail: { checked: boolean } },
      { enabled: Cell<boolean> }
    >(
      ({ detail }, { enabled }) => {
        enabled.set(detail?.checked ?? false);
      },
    );

    const toggleHandler = toggle({ enabled });

    return {
      [NAME]: "Checkbox Demo",
      [UI]: (
        <common-vstack gap="md" style="padding: 2rem; max-width: 400px;">
          <h3>Simple ct-checkbox + ifElse Demo</h3>

          <ct-checkbox
            $checked={enabled}
            onct-change={toggleHandler}
            data-testid="main-checkbox"
          >
            Enable Feature
          </ct-checkbox>

          <p>Debug: enabled = {ifElse(enabled, "true", "false")}</p>

          {ifElse(
            enabled,
            <div
              style="padding: 1rem; background: #e8f5e8; border: 1px solid #4caf50; border-radius: 4px;"
              data-testid="enabled-content"
            >
              <p style="margin: 0; color: #2e7d32;">✓ Feature is enabled!</p>
            </div>,
            <div
              style="padding: 1rem; background: #fff3e0; border: 1px solid #ff9800; border-radius: 4px;"
              data-testid="disabled-content"
            >
              <p style="margin: 0; color: #e65100;">⚠ Feature is disabled</p>
            </div>,
          )}

          <p data-testid="status">
            Status: {ifElse(enabled, "ON", "OFF")}
          </p>
        </common-vstack>
      ),
      enabled,
    };
  },
);
