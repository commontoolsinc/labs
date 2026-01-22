/// <cts-enable />
import { NAME, pattern, UI, Writable, derive } from "commontools";

/**
 * Test pattern to verify whether the schema subscription bug affects
 * multiple component types beyond ct-input.
 *
 * Components tested:
 * - ct-input (stringSchema) - FIXED in this branch
 * - ct-textarea (stringSchema) - still passes stringSchema
 * - ct-checkbox (booleanSchema) - passes booleanSchema
 *
 * For each, we test if text interpolation {value} updates when
 * the component modifies the same cell.
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

  // Need derive to convert boolean to string reactively
  const checkboxDisplay = derive(
    { checkboxValue },
    ({ checkboxValue }) => (checkboxValue ? "true" : "false"),
  );

  return {
    [NAME]: "Multi-Component Schema Repro",
    [UI]: (
      <ct-screen>
        <ct-vstack gap="4" style="padding: 1rem;">
          {/* ct-input test - FIXED */}
          <ct-card>
            <ct-vstack gap="2">
              <ct-heading level={4}>ct-input (FIXED)</ct-heading>
              <ct-input $value={textValue} placeholder="Type here..." />
              <p>
                <strong>Interpolated:</strong> {textValue}
              </p>
            </ct-vstack>
          </ct-card>

          {/* ct-textarea test */}
          <ct-card>
            <ct-vstack gap="2">
              <ct-heading level={4}>ct-textarea (stringSchema)</ct-heading>
              <ct-textarea $value={textareaValue} placeholder="Type here..." />
              <p>
                <strong>Interpolated:</strong> {textareaValue}
              </p>
            </ct-vstack>
          </ct-card>

          {/* ct-checkbox test */}
          <ct-card>
            <ct-vstack gap="2">
              <ct-heading level={4}>ct-checkbox (booleanSchema)</ct-heading>
              <ct-checkbox $checked={checkboxValue}>Toggle me</ct-checkbox>
              <p>
                <strong>Interpolated (via derive):</strong> {checkboxDisplay}
              </p>
              <p>
                <strong>Raw boolean cell:</strong> [{checkboxValue}]
              </p>
            </ct-vstack>
          </ct-card>

          <p style="color: gray; font-size: 0.875rem;">
            If any "Interpolated" value doesn't update when you interact with
            the component, that component has the schema subscription bug.
          </p>
        </ct-vstack>
      </ct-screen>
    ),
    textValue,
    textareaValue,
    checkboxValue,
  };
});
