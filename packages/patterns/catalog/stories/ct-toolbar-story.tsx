/// <cts-enable />
import { NAME, pattern, UI, type VNode } from "commontools";

// deno-lint-ignore no-empty-interface
interface ToolbarStoryInput {}
interface ToolbarStoryOutput {
  [NAME]: string;
  [UI]: VNode;
  controls: VNode;
}

export default pattern<ToolbarStoryInput, ToolbarStoryOutput>(() => {
  return {
    [NAME]: "ct-toolbar Story",
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
            Standard Toolbar
          </div>
          <div style="border: 1px solid #e2e8f0; border-radius: 4px; overflow: hidden;">
            <ct-toolbar>
              <ct-button slot="start" variant="ghost" size="sm">Menu</ct-button>
              <span slot="center" style="font-size: 13px; font-weight: 600;">
                Page Title
              </span>
              <ct-hstack slot="end" gap="2">
                <ct-button variant="ghost" size="sm">Help</ct-button>
                <ct-button variant="primary" size="sm">Save</ct-button>
              </ct-hstack>
            </ct-toolbar>
          </div>
        </div>

        <div>
          <div
            style={{
              fontSize: "14px",
              fontWeight: "600",
              marginBottom: "8px",
              color: "#2e3438",
            }}
          >
            Dense Toolbar
          </div>
          <div style="border: 1px solid #e2e8f0; border-radius: 4px; overflow: hidden;">
            <ct-toolbar dense>
              <ct-button slot="start" variant="ghost" size="sm">Back</ct-button>
              <span slot="center" style="font-size: 13px; font-weight: 600;">
                Compact
              </span>
              <ct-button slot="end" variant="ghost" size="sm">Done</ct-button>
            </ct-toolbar>
          </div>
        </div>
      </div>
    ),
    controls: (
      <div style={{ color: "#6b7280", fontSize: "13px", padding: "8px 12px" }}>
        No interactive controls. Slots: start, center, end. Attributes: dense,
        elevated, sticky.
      </div>
    ),
  };
});
