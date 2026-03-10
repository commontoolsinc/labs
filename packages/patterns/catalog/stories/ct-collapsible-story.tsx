/// <cts-enable />
import { NAME, pattern, UI, type VNode } from "commontools";

// deno-lint-ignore no-empty-interface
interface CollapsibleStoryInput {}
interface CollapsibleStoryOutput {
  [NAME]: string;
  [UI]: VNode;
  controls: VNode;
}

export default pattern<CollapsibleStoryInput, CollapsibleStoryOutput>(() => {
  return {
    [NAME]: "ct-collapsible Story",
    [UI]: (
      <div
        style={{
          padding: "1rem",
          maxWidth: "400px",
        }}
      >
        <ct-vstack gap="2">
          <ct-collapsible>
            <ct-button
              slot="trigger"
              variant="ghost"
              style="width: 100%; text-align: left;"
            >
              Click to expand
            </ct-button>
            <div style="padding: 12px; font-size: 13px; color: #666;">
              Hidden content revealed on expand. Animated height transition.
            </div>
          </ct-collapsible>
          <ct-collapsible open>
            <ct-button
              slot="trigger"
              variant="ghost"
              style="width: 100%; text-align: left;"
            >
              Already open
            </ct-button>
            <div style="padding: 12px; font-size: 13px; color: #666;">
              This section starts open.
            </div>
          </ct-collapsible>
        </ct-vstack>
      </div>
    ),
    controls: (
      <div style={{ color: "#6b7280", fontSize: "13px", padding: "8px 12px" }}>
        No interactive controls. Attributes: open (boolean). Animated height
        transition.
      </div>
    ),
  };
});
