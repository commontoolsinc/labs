/// <cts-enable />
import { NAME, pattern, UI, type VNode, Writable } from "commontools";

import { Controls, SwitchControl } from "../ui/controls/index.ts";

// deno-lint-ignore no-empty-interface
interface CheckboxStoryInput {}
interface CheckboxStoryOutput {
  [NAME]: string;
  [UI]: VNode;
  controls: VNode;
}

export default pattern<CheckboxStoryInput, CheckboxStoryOutput>(() => {
  const checked = Writable.of(false);
  const disabled = Writable.of(false);

  return {
    [NAME]: "ct-checkbox Story",
    [UI]: (
      <div style={{ padding: "1rem" }}>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "16px",
            padding: "2rem 0",
          }}
        >
          <ct-checkbox $checked={checked} disabled={disabled}>
            Check me
          </ct-checkbox>
          <div
            style={{ fontSize: "0.875rem", color: "#6b7280", marginTop: "4px" }}
          >
            Checked: {checked}
          </div>
        </div>
      </div>
    ),
    controls: (
      <Controls>
        <>
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
