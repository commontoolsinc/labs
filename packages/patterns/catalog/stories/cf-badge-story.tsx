import { NAME, pattern, UI, type VNode, Writable } from "commonfabric";

import {
  Controls,
  SelectControl,
  SwitchControl,
  TextControl,
} from "../ui/controls/index.ts";

// deno-lint-ignore no-empty-interface
interface BadgeStoryInput {}
interface BadgeStoryOutput {
  [NAME]: string;
  [UI]: VNode;
  controls: VNode;
}

export default pattern<BadgeStoryInput, BadgeStoryOutput>(() => {
  const variant = Writable.of<"solid" | "outline">("solid");
  const color = Writable.of<"neutral" | "primary" | "accent" | "danger">(
    "primary",
  );
  const removable = Writable.of(false);
  const label = Writable.of("Badge");

  return {
    [NAME]: "cf-badge Story",
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
          <cf-badge
            variant={variant}
            color={color}
            removable={removable}
          >
            {label}
          </cf-badge>
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
            label="color"
            description="Color intent"
            defaultValue="primary"
            value={color}
            items={[
              { label: "Neutral", value: "neutral" },
              { label: "Primary", value: "primary" },
              { label: "Accent", value: "accent" },
              { label: "Danger", value: "danger" },
            ]}
          />
          <SelectControl
            label="variant"
            description="Visual style variant"
            defaultValue="solid"
            value={variant}
            items={[
              { label: "Solid", value: "solid" },
              { label: "Outline", value: "outline" },
            ]}
          />
          <SwitchControl
            label="removable"
            description="Shows close button and emits cf-remove"
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
