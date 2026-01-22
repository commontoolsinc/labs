/// <cts-enable />
import { NAME, pattern, UI, Writable } from "commontools";

/**
 * Reproduction case for late subscriber initial value bug.
 *
 * Bug: When multiple CellHandle instances subscribe to the same cell with the
 * same schema key, late subscribers would miss the initial value. This happened
 * because the subscription was already established, so no new backend request
 * was made, and the late subscriber's CellHandle never received the cached value.
 *
 * Example: ct-input binds to a cell with stringSchema, creating a new CellHandle.
 * Text interpolation {value} also subscribes to the same cell with the same schema.
 * On initial page load, the text interpolation would show blank because it subscribed
 * after the initial value was already sent to the first subscriber.
 *
 * Fix: In connection.subscribe(), when adding a CellHandle to an existing
 * subscription, copy the cached value from an existing subscriber to the new one.
 *
 * To test:
 * 1. Deploy this pattern with `charm new`
 * 2. On initial page load, all "Interpolated" values should show their initial values
 * 3. Interacting with any component should update its interpolated value
 */

interface Output {
  [NAME]: string;
  textValue: string;
  textareaValue: string;
  checkboxValue: boolean;
}

export default pattern<{}, Output>(() => {
  const textValue = Writable.of<string>("hello");
  const textareaValue = Writable.of<string>("multi\nline");
  const checkboxValue = Writable.of<boolean>(true);

  return {
    [NAME]: "Late Subscriber Repro",
    [UI]: (
      <ct-screen>
        <ct-vstack gap="4" style="padding: 1rem;">
          <ct-card>
            <ct-vstack gap="2">
              <ct-heading level={4}>ct-input</ct-heading>
              <ct-input $value={textValue} placeholder="Type here..." />
              <p>
                <strong>Interpolated:</strong> {textValue}
              </p>
            </ct-vstack>
          </ct-card>

          <ct-card>
            <ct-vstack gap="2">
              <ct-heading level={4}>ct-textarea</ct-heading>
              <ct-textarea $value={textareaValue} placeholder="Type here..." />
              <p>
                <strong>Interpolated:</strong> {textareaValue}
              </p>
            </ct-vstack>
          </ct-card>

          <ct-card>
            <ct-vstack gap="2">
              <ct-heading level={4}>ct-checkbox</ct-heading>
              <ct-checkbox $checked={checkboxValue}>Toggle me</ct-checkbox>
              <p>
                <strong>Interpolated:</strong> [{checkboxValue}]
              </p>
            </ct-vstack>
          </ct-card>

          <p style="color: gray; font-size: 0.875rem;">
            If any "Interpolated" value is blank on initial page load, the late
            subscriber bug is present. All values should appear immediately.
          </p>
        </ct-vstack>
      </ct-screen>
    ),
    textValue,
    textareaValue,
    checkboxValue,
  };
});
