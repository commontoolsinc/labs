/// <cts-enable />
import { NAME, pattern, UI, Writable } from "commontools";

/**
 * Minimal reproduction case for schema-compatible subscription bug.
 *
 * Bug: When a cell is bound to ct-input (which was subscribing with a simplified
 * schema like {type: "string"}), text interpolation of the same cell (which
 * subscribes with the full schema including {default: ...}) didn't receive updates.
 *
 * Fix: ct-input no longer overrides the cell's schema when binding.
 *
 * To test:
 * 1. Deploy this pattern
 * 2. Type in the input field
 * 3. The "Current value:" text should update as you type
 */

interface Output {
  [NAME]: string;
  text: string;
}

export default pattern<{}, Output>(() => {
  const text = Writable.of<string>("hello");

  return {
    [NAME]: "Schema Subscription Repro",
    [UI]: (
      <ct-screen>
        <ct-vstack gap="4" style="padding: 1rem;">
          <ct-card>
            <ct-vstack gap="2">
              <ct-heading level={4}>Schema Subscription Bug Repro</ct-heading>
              <p>Type in the input below. The text interpolation should update.</p>

              <ct-input $value={text} placeholder="Type here..." />

              <p>
                <strong>Current value:</strong> {text}
              </p>

              <p style="color: gray; font-size: 0.875rem;">
                If the "Current value" doesn't update when you type, the bug is present.
              </p>
            </ct-vstack>
          </ct-card>
        </ct-vstack>
      </ct-screen>
    ),
    text,
  };
});
