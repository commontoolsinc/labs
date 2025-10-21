/// <cts-enable />
import { Cell, Default, handler, ifElse, NAME, recipe, UI } from "commontools";

interface CheckboxDemoInput {
  simpleEnabled: Default<boolean, false>;
  trackedEnabled: Default<boolean, false>;
}

interface CheckboxDemoOutput extends CheckboxDemoInput {}

export default recipe<CheckboxDemoInput, CheckboxDemoOutput>(
  "ct-checkbox demo",
  ({ simpleEnabled, trackedEnabled }) => {
    // Handler for checkbox changes - only needed when you want additional logic
    const toggleWithLogging = handler<
      { detail: { checked: boolean } },
      { enabled: Cell<boolean> }
    >(
      ({ detail }, { enabled }) => {
        const newValue = detail?.checked ?? false;
        enabled.set(newValue);
        // Additional side effects
        console.log("Checkbox toggled to:", newValue);
      },
    );

    return {
      [NAME]: "Checkbox Demo",
      [UI]: (
        <common-vstack gap="md" style="padding: 2rem; max-width: 600px;">
          <h3>ct-checkbox Bidirectional Binding Demo</h3>

          <ct-card>
            <h4>Simple Bidirectional Binding (Preferred)</h4>
            <p>
              Using $checked alone - no handler needed! The cell automatically
              updates.
            </p>
            <ct-checkbox $checked={simpleEnabled}>
              Enable Simple Feature
            </ct-checkbox>

            <p id="feature-status">
              {ifElse(
                simpleEnabled,
                "✓ Feature is enabled!",
                "⚠ Feature is disabled",
              )}
            </p>
          </ct-card>

          <ct-card>
            <h4>With Handler for Additional Logic</h4>
            <p>
              Use a handler when you need to run additional code (logging,
              validation, side effects)
            </p>
            <ct-checkbox
              $checked={trackedEnabled}
              onct-change={toggleWithLogging({ enabled: trackedEnabled })}
            >
              Enable Tracked Feature
            </ct-checkbox>

            <p>
              Value: {ifElse(trackedEnabled, "✓ Enabled", "⚠ Disabled")}
            </p>
            <p>
              <small>(Check console for logging)</small>
            </p>
          </ct-card>

          <ct-card>
            <h4>Key Takeaway</h4>
            <p>
              <strong>$checked automatically updates the cell</strong>{" "}
              - you don't need a handler unless you want to add extra logic
              beyond just updating the value.
            </p>
          </ct-card>
        </common-vstack>
      ),
      simpleEnabled,
      trackedEnabled,
    };
  },
);
