/// <cts-enable />
import { NAME, pattern, UI, type VNode, Writable } from "commonfabric";

import { Controls, SelectControl } from "../ui/controls/index.ts";

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
    [NAME]: "cf-tab-list Story",
    [UI]: (
      <div style={{ padding: "1rem", maxWidth: "520px" }}>
        <cf-tabs $value={activeTab} orientation={orientation}>
          <cf-tab-list orientation={orientation}>
            <cf-tab value="overview">Overview</cf-tab>
            <cf-tab value="settings">Settings</cf-tab>
            <cf-tab value="activity">Activity</cf-tab>
          </cf-tab-list>
          <cf-tab-panel value="overview">
            <div style="padding: 12px; font-size: 13px; color: #475569;">
              Overview content
            </div>
          </cf-tab-panel>
          <cf-tab-panel value="settings">
            <div style="padding: 12px; font-size: 13px; color: #475569;">
              Settings content
            </div>
          </cf-tab-panel>
          <cf-tab-panel value="activity">
            <div style="padding: 12px; font-size: 13px; color: #475569;">
              Activity content
            </div>
          </cf-tab-panel>
        </cf-tabs>
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
