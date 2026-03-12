/// <cts-enable />
import { NAME, pattern, UI, type VNode, Writable } from "commontools";

import { Controls, SelectControl, SwitchControl } from "../ui/controls.tsx";

// deno-lint-ignore no-empty-interface
interface SliderStoryInput {}
interface SliderStoryOutput {
  [NAME]: string;
  [UI]: VNode;
  controls: VNode;
}

export default pattern<SliderStoryInput, SliderStoryOutput>(() => {
  const value = Writable.of(40);
  const orientation = Writable.of<"horizontal" | "vertical">("horizontal");
  const disabled = Writable.of(false);

  return {
    [NAME]: "ct-slider Story",
    [UI]: (
      <div style={{ padding: "1rem", maxWidth: "560px" }}>
        <div
          style={{ marginBottom: "16px", fontSize: "13px", color: "#64748b" }}
        >
          Value: {value}
        </div>
        <ct-slider
          $value={value}
          min={0}
          max={100}
          step={5}
          orientation={orientation}
          disabled={disabled}
          style={orientation.get() === "vertical"
            ? "height: 220px; width: 24px;"
            : "width: 100%;"}
        />
      </div>
    ),
    controls: (
      <Controls>
        <>
          <SelectControl
            label="orientation"
            description="Horizontal or vertical slider"
            defaultValue="horizontal"
            value={orientation as any}
            items={[
              { label: "horizontal", value: "horizontal" },
              { label: "vertical", value: "vertical" },
            ]}
          />
          <SwitchControl
            label="disabled"
            description="Disables pointer and keyboard input"
            defaultValue="false"
            checked={disabled}
          />
        </>
      </Controls>
    ),
  };
});
