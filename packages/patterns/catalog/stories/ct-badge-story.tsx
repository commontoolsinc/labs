/// <cts-enable />
import { NAME, pattern, UI, type VNode, Writable } from "commontools";

import {
  Controls,
  SelectControl,
  SwitchControl,
  TextControl,
} from "../ui/controls/controls.tsx";

// deno-lint-ignore no-empty-interface
interface BadgeStoryInput {}
interface BadgeStoryOutput {
  [NAME]: string;
  [UI]: VNode;
  controls: VNode;
}

export default pattern<BadgeStoryInput, BadgeStoryOutput>(() => {
  const variant = Writable.of<
    "default" | "secondary" | "destructive" | "outline"
  >(
    "default",
  );
  const removable = Writable.of(false);
  const label = Writable.of("Badge");

  return {
    [NAME]: "ct-badge Story",
    [UI]: (
      <div style={{ padding: "1rem" }}>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: "8px",
            padding: "2rem 0",
          }}
        >
          <ct-badge
            variant={variant}
            removable={removable}
          >
            {label}
          </ct-badge>
          <span style={{ fontSize: "0.875rem", color: "#6b7280" }}>
            Click the close button when removable is enabled.
          </span>
        </div>
      </div>
    ),
    controls: (
      <Controls>
        <>
          <SelectControl
            label="variant"
            description="Visual style variant"
            defaultValue="default"
            value={variant}
            items={[
              { label: "Default", value: "default" },
              { label: "Secondary", value: "secondary" },
              { label: "Destructive", value: "destructive" },
              { label: "Outline", value: "outline" },
            ]}
          />
          <SwitchControl
            label="removable"
            description="Shows close button and emits ct-remove"
            defaultValue="false"
            checked={removable}
          />
          <TextControl
            label="children"
            description="Badge content text"
            defaultValue="Badge"
            value={label}
          />
        </>
      </Controls>
    ),
  };
});
