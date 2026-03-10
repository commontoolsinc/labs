/// <cts-enable />
import { NAME, pattern, UI, type VNode } from "commontools";

// deno-lint-ignore no-empty-interface
interface TabsStoryInput {}
interface TabsStoryOutput {
  [NAME]: string;
  [UI]: VNode;
  controls: VNode;
}

export default pattern<TabsStoryInput, TabsStoryOutput>(() => {
  return {
    [NAME]: "ct-tabs Story",
    [UI]: (
      <div
        style={{
          padding: "1rem",
          maxWidth: "400px",
        }}
      >
        <ct-tabs value="one">
          <ct-tab-list>
            <ct-tab value="one">Tab One</ct-tab>
            <ct-tab value="two">Tab Two</ct-tab>
            <ct-tab value="three" disabled>Disabled</ct-tab>
          </ct-tab-list>
          <ct-tab-panel value="one">
            <div style="padding: 16px; font-size: 13px; color: #666;">
              Content for Tab One. Keyboard navigable with arrow keys.
            </div>
          </ct-tab-panel>
          <ct-tab-panel value="two">
            <div style="padding: 16px; font-size: 13px; color: #666;">
              Content for Tab Two.
            </div>
          </ct-tab-panel>
          <ct-tab-panel value="three">
            <div style="padding: 16px; font-size: 13px; color: #666;">
              Content for disabled tab (not reachable).
            </div>
          </ct-tab-panel>
        </ct-tabs>
      </div>
    ),
    controls: (
      <div style={{ color: "#6b7280", fontSize: "13px", padding: "8px 12px" }}>
        No interactive controls. Composed of ct-tabs, ct-tab-list, ct-tab, and
        ct-tab-panel.
      </div>
    ),
  };
});
