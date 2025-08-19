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
            <div data-testid="enabled-content">
              <p>✓ Feature is enabled!</p>
            </div>,
            <div data-testid="disabled-content">
              <p>⚠ Feature is disabled</p>
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
