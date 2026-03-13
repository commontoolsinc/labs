/// <cts-enable />
import { NAME, pattern, UI, type VNode } from "commontools";

// deno-lint-ignore no-empty-interface
interface ToggleGroupStoryInput {}
interface ToggleGroupStoryOutput {
  [NAME]: string;
  [UI]: VNode;
  controls: VNode;
}

export default pattern<ToggleGroupStoryInput, ToggleGroupStoryOutput>(() => {
  return {
    [NAME]: "ct-toggle-group Story",
    [UI]: (
      <div
        style={{
          padding: "1rem",
          maxWidth: "560px",
        }}
      >
        {
          /* Temporarily disabled while CT-1350 is open.
        <ct-toggle-group type="single" value="bold">
          <ct-toggle>bold</ct-toggle>
          <ct-toggle>italic</ct-toggle>
          <ct-toggle>underline</ct-toggle>
        </ct-toggle-group>
        <ct-toggle-group type="multiple" value="bold,italic">
          <ct-toggle>bold</ct-toggle>
          <ct-toggle>italic</ct-toggle>
          <ct-toggle>underline</ct-toggle>
        </ct-toggle-group>
        */
        }
        <div
          style={{
            fontSize: "14px",
            lineHeight: "1.5",
            color: "#334155",
            backgroundColor: "#fff7ed",
            border: "1px solid #fdba74",
            borderRadius: "8px",
            padding: "12px",
          }}
        >
          ct-toggle-group currently crashes the catalog when interacted with.
          Track progress in{" "}
          <a
            href="https://linear.app/common-tools/issue/CT-1350/ct-toggle-group-crashes-the-catalog"
            target="_blank"
            rel="noopener noreferrer"
          >
            CT-1350
          </a>
          .
        </div>
      </div>
    ),
    controls: (
      <div style={{ color: "#6b7280", fontSize: "13px", padding: "8px 12px" }}>
        Story examples are disabled until CT-1350 is fixed.
      </div>
    ),
  };
});
