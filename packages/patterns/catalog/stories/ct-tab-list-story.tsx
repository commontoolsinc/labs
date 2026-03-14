/// <cts-enable />
import { NAME, pattern, UI, type VNode, Writable } from "commontools";

import { Controls, SelectControl } from "../ui/controls/controls.tsx";

// deno-lint-ignore no-empty-interface
interface TabListStoryInput {}
interface TabListStoryOutput {
  [NAME]: string;
  [UI]: VNode;
  controls: VNode;
}

export default pattern<TabListStoryInput, TabListStoryOutput>(() => {
  const orientation = Writable.of<"horizontal" | "vertical">("horizontal");
  const activeTab = Writable.of("overview");

  return {
    [NAME]: "ct-tab-list Story",
    [UI]: (
      <div style={{ padding: "1rem", maxWidth: "520px" }}>
        <ct-tabs $value={activeTab} orientation={orientation}>
          <ct-tab-list orientation={orientation}>
            <ct-tab value="overview">Overview</ct-tab>
            <ct-tab value="settings">Settings</ct-tab>
            <ct-tab value="activity">Activity</ct-tab>
          </ct-tab-list>
          <ct-tab-panel value="overview">
            <div style="padding: 12px; font-size: 13px; color: #475569;">
              Overview content
            </div>
          </ct-tab-panel>
          <ct-tab-panel value="settings">
            <div style="padding: 12px; font-size: 13px; color: #475569;">
              Settings content
            </div>
          </ct-tab-panel>
          <ct-tab-panel value="activity">
            <div style="padding: 12px; font-size: 13px; color: #475569;">
              Activity content
            </div>
          </ct-tab-panel>
        </ct-tabs>
      </div>
    ),
    controls: (
      <Controls>
        <>
          <SelectControl
            label="orientation"
            description="Direction for tab-list layout"
            defaultValue="horizontal"
            value={orientation as any}
            items={[
              { label: "horizontal", value: "horizontal" },
              { label: "vertical", value: "vertical" },
            ]}
          />
        </>
      </Controls>
    ),
  };
});
