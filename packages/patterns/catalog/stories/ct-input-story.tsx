/// <cts-enable />
import { NAME, pattern, UI, type VNode, Writable } from "commontools";

import {
  Controls,
  SwitchControl,
  TextControl,
} from "../ui/controls/index.ts";

// deno-lint-ignore no-empty-interface
interface InputStoryInput {}
interface InputStoryOutput {
  [NAME]: string;
  [UI]: VNode;
  controls: VNode;
}

export default pattern<InputStoryInput, InputStoryOutput>(() => {
  const placeholder = Writable.of("Type something...");
  const disabled = Writable.of(false);
  const value = Writable.of("");

  return {
    [NAME]: "ct-input Story",
    [UI]: (
      <div style={{ padding: "1rem" }}>
        <div style={{ padding: "2rem 0" }}>
          <ct-input
            $value={value}
            placeholder={placeholder}
            disabled={disabled}
          />
          <div
            style={{ fontSize: "0.875rem", color: "#6b7280", marginTop: "8px" }}
          >
            Current value: "{value}"
          </div>
        </div>
      </div>
    ),
    controls: (
      <Controls>
        <>
          <TextControl
            label="placeholder"
            description="Placeholder text shown when empty"
            defaultValue="Type something..."
            value={placeholder}
          />
          <SwitchControl
            label="disabled"
            description="Disables interaction"
            defaultValue="false"
            checked={disabled}
          />
        </>
      </Controls>
    ),
  };
});
