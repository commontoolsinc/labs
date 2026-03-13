/// <cts-enable />
import { NAME, pattern, UI, type VNode, Writable } from "commontools";
import { Controls, SelectControl, SwitchControl } from "../ui/controls.tsx";

// deno-lint-ignore no-empty-interface
interface RadioStoryInput {}
interface RadioStoryOutput {
  [NAME]: string;
  [UI]: VNode;
  controls: VNode;
}

export default pattern<RadioStoryInput, RadioStoryOutput>(() => {
  const orientation = Writable.of<"vertical" | "horizontal">("vertical");
  const disabled = Writable.of(false);

  return {
    [NAME]: "ct-radio Story",
    [UI]: (
      <div
        style={{
          padding: "1rem",
          display: "flex",
          flexDirection: "column",
          gap: "24px",
        }}
      >
        <div>
          <div
            style={{
              fontSize: "14px",
              fontWeight: "600",
              marginBottom: "8px",
              color: "#2e3438",
            }}
          >
            Radio Group
          </div>
          <ct-radio-group
            name="fruit"
            orientation={orientation}
            disabled={disabled}
          >
            <ct-radio value="apple">Apple</ct-radio>
            <ct-radio value="banana">Banana</ct-radio>
            <ct-radio value="cherry">Cherry</ct-radio>
          </ct-radio-group>
        </div>
      </div>
    ),
    controls: (
      <Controls>
        <>
          <SelectControl
            label="orientation"
            description="Layout direction"
            defaultValue="vertical"
            value={orientation}
            items={[
              { label: "Vertical", value: "vertical" },
              { label: "Horizontal", value: "horizontal" },
            ]}
          />
          <SwitchControl
            label="disabled"
            description="Disables all radio buttons"
            defaultValue="false"
            checked={disabled}
          />
        </>
      </Controls>
    ),
  };
});
