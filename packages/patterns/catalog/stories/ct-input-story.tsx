/// <cts-enable />
import {
  computed,
  NAME,
  pattern,
  UI,
  type VNode,
  Writable,
} from "commontools";

interface InputStoryInput {}
interface InputStoryOutput {
  [NAME]: string;
  [UI]: VNode;
}

export default pattern<InputStoryInput, InputStoryOutput>(() => {
  const placeholder = Writable.of("Type something...");
  const disabled = Writable.of(false);
  const value = Writable.of("");

  return {
    [NAME]: "ct-input Story",
    [UI]: (
      <ct-vstack gap="4" style="padding: 1rem;">
        <ct-heading level={4}>ct-input</ct-heading>

        {/* Preview */}
        <ct-vstack gap="2" style="padding: 2rem 0;">
          <ct-input
            $value={value}
            placeholder={placeholder}
            disabled={disabled}
          />
          <span style="font-size: 0.875rem; color: var(--ct-color-gray-500);">
            Current value: "{value}"
          </span>
        </ct-vstack>

        {/* Static examples */}
        <ct-vstack gap="2">
          <ct-heading level={5}>Examples</ct-heading>
          <ct-vstack gap="2">
            <label style="font-weight: 500; font-size: 0.875rem;">Default</label>
            <ct-input placeholder="Default input" />
            <label style="font-weight: 500; font-size: 0.875rem;">With value</label>
            <ct-input value="Pre-filled value" />
            <label style="font-weight: 500; font-size: 0.875rem;">Disabled</label>
            <ct-input value="Cannot edit this" disabled />
          </ct-vstack>
        </ct-vstack>

        {/* Controls */}
        <ct-vstack gap="3" style="border-top: 1px solid var(--ct-color-gray-200); padding-top: 1rem;">
          <ct-heading level={5}>Controls</ct-heading>
          <ct-hstack gap="3" align="center">
            <ct-vstack gap="1" style="flex: 1;">
              <label style="font-weight: 500; font-size: 0.875rem;">Placeholder</label>
              <ct-input $value={placeholder} placeholder="Enter placeholder text" />
            </ct-vstack>
            <ct-vstack gap="1">
              <label style="font-weight: 500; font-size: 0.875rem;">Disabled</label>
              <ct-switch $checked={disabled}>Off</ct-switch>
            </ct-vstack>
          </ct-hstack>
        </ct-vstack>
      </ct-vstack>
    ),
  };
});
