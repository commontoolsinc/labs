import { action, NAME, pattern, UI, type VNode, Writable } from "commonfabric";

import {
  Controls,
  SelectControl,
  SwitchControl,
  TextControl,
} from "../ui/controls/index.ts";

// deno-lint-ignore no-empty-interface
interface ButtonStoryInput {}
interface ButtonStoryOutput {
  [NAME]: string;
  [UI]: VNode;
  controls: VNode;
}

export default pattern<ButtonStoryInput, ButtonStoryOutput>(() => {
  const variant = Writable.of<
    "primary" | "secondary" | "destructive" | "ghost"
  >("primary");
  const disabled = Writable.of(false);
  const label = Writable.of("Click me");
  const size = Writable.of<"default" | "sm" | "lg" | "icon">("default");
  const clickCount = Writable.of(0);

  const handleClick = action(() => {
    clickCount.set(clickCount.get() + 1);
  });

  return {
    [NAME]: "cf-button Story",
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
          <cf-button
            variant={variant}
            disabled={disabled}
            size={size}
            onClick={handleClick}
          >
            {label}
          </cf-button>
          <span style={{ fontSize: "0.875rem", color: "#6b7280" }}>
            Clicked {clickCount} times
          </span>
        </div>
      </div>
    ),
    controls: (
      <Controls>
        <>
          <SelectControl
            label="variant"
            description="Visual style of the button"
            defaultValue="primary"
            value={variant}
            items={[
              { label: "Primary", value: "primary" },
              { label: "Secondary", value: "secondary" },
              { label: "Destructive", value: "destructive" },
              { label: "Ghost", value: "ghost" },
            ]}
          />
          <SelectControl
            label="size"
            description="Size of the button"
            defaultValue="default"
            value={size}
            items={[
              { label: "Default", value: "default" },
              { label: "Small", value: "sm" },
              { label: "Large", value: "lg" },
              { label: "Icon", value: "icon" },
            ]}
          />
          <TextControl
            label="children"
            description="Button label text"
            defaultValue="Click me"
            value={label}
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
