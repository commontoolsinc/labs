import { ifElse, NAME, pattern, UI, type VNode, Writable } from "commonfabric";

import {
  Controls,
  SelectControl,
  SwitchControl,
} from "../ui/controls/index.ts";

// deno-lint-ignore no-empty-interface
interface TabBarStoryInput {}
interface TabBarStoryOutput {
  [NAME]: string;
  [UI]: VNode;
  controls: VNode;
}

export default pattern<TabBarStoryInput, TabBarStoryOutput>(() => {
  const activeTab = Writable.of("home");
  const position = Writable.of<"bottom" | "top">("bottom");
  const variant = Writable.of<"default" | "inset">("default");
  const showAction = Writable.of(false);

  return {
    [NAME]: "cf-tab-bar Story",
    [UI]: (
      <div
        style={{
          position: "relative",
          height: "300px",
          background: "#f8fafc",
          border: "1px solid #e2e8f0",
          borderRadius: "8px",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            padding: "1rem",
            fontSize: "14px",
            color: "#374151",
          }}
        >
          Selected tab: <strong>{activeTab}</strong>
        </div>

        <cf-tab-bar
          $value={activeTab}
          position={position}
          variant={variant}
          style="position: absolute;"
        >
          <cf-tab-bar-item value="home" label="Home">
            <span slot="icon">&#127968;</span>
          </cf-tab-bar-item>
          <cf-tab-bar-item value="explore" label="Explore">
            <span slot="icon">&#128269;</span>
          </cf-tab-bar-item>
          <cf-tab-bar-item value="inbox" label="Inbox">
            <span slot="icon">&#128236;</span>
          </cf-tab-bar-item>
          <cf-tab-bar-item value="profile" label="Profile">
            <span slot="icon">&#128100;</span>
          </cf-tab-bar-item>
          {ifElse(
            showAction,
            <cf-button
              slot="action"
              variant="primary"
              style="border-radius: 9999px; width: 3.5rem; height: 3.5rem; padding: 0; flex-shrink: 0;"
            >
              &#65291;
            </cf-button>,
            null,
          )}
        </cf-tab-bar>
      </div>
    ),
    controls: (
      <Controls>
        <>
          <SelectControl
            label="position"
            description="Whether the bar is fixed to the bottom or top of the viewport"
            defaultValue="bottom"
            value={position}
            items={[
              { label: "Bottom", value: "bottom" },
              { label: "Top", value: "top" },
            ]}
          />
          <SelectControl
            label="variant"
            description="Layout style: full-width or inset pill shape"
            defaultValue="default"
            value={variant}
            items={[
              { label: "Default", value: "default" },
              { label: "Inset", value: "inset" },
            ]}
          />
          <SwitchControl
            label="showAction"
            description="Show a primary action button (FAB) in the action slot beside the nav pill"
            defaultValue="false"
            checked={showAction}
          />
        </>
      </Controls>
    ),
  };
});
