/// <cts-enable />
import { NAME, pattern, UI, type VNode } from "commontools";

// deno-lint-ignore no-empty-interface
interface CardStoryInput {}
interface CardStoryOutput {
  [NAME]: string;
  [UI]: VNode;
  controls: VNode;
}

export default pattern<CardStoryInput, CardStoryOutput>(() => {
  return {
    [NAME]: "ct-card Story",
    [UI]: (
      <div
        style={{
          padding: "1rem",
          display: "flex",
          flexDirection: "column",
          gap: "16px",
        }}
      >
        <ct-card>
          <ct-vstack gap="1">
            <ct-heading level={5}>Basic Card</ct-heading>
            <span style="color: var(--ct-color-gray-600);">
              A simple card with text content. Cards provide built-in padding.
            </span>
          </ct-vstack>
        </ct-card>

        <ct-card>
          <ct-hstack gap="3" align="center">
            <span style="font-size: 2rem;">🎨</span>
            <ct-vstack gap="0" style="flex: 1;">
              <span style="font-weight: 600;">Card with Icon</span>
              <span style="font-size: 0.875rem; color: var(--ct-color-gray-500);">
                Horizontal layout with icon and text
              </span>
            </ct-vstack>
            <ct-button variant="secondary">Action</ct-button>
          </ct-hstack>
        </ct-card>

        <ct-card>
          <ct-vstack gap="2">
            <ct-heading level={5}>Card with Nested Elements</ct-heading>
            <ct-hstack gap="2">
              <ct-button variant="primary">Save</ct-button>
              <ct-button variant="secondary">Cancel</ct-button>
            </ct-hstack>
            <ct-input placeholder="Input inside a card" />
          </ct-vstack>
        </ct-card>
      </div>
    ),
    controls: (
      <div style={{ color: "#6b7280", fontSize: "13px", padding: "8px 12px" }}>
        No interactive controls. This story shows ct-card layout variations.
      </div>
    ),
  };
});
