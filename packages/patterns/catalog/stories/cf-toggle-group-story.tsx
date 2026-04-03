/// <cts-enable />
import { NAME, pattern, UI, type VNode } from "commonfabric";

// deno-lint-ignore no-empty-interface
interface ToggleGroupStoryInput {}
interface ToggleGroupStoryOutput {
  [NAME]: string;
  [UI]: VNode;
  controls: VNode;
}

export default pattern<ToggleGroupStoryInput, ToggleGroupStoryOutput>(() => {
  return {
    [NAME]: "cf-toggle-group Story",
    [UI]: (
      <div
        style={{
          padding: "1rem",
          maxWidth: "560px",
        }}
      >
        {
          /* Temporarily disabled while CT-1350 is open.
        <cf-toggle-group type="single" value="bold">
          <cf-toggle>bold</cf-toggle>
          <cf-toggle>italic</cf-toggle>
          <cf-toggle>underline</cf-toggle>
        </cf-toggle-group>
        <cf-toggle-group type="multiple" value="bold,italic">
          <cf-toggle>bold</cf-toggle>
          <cf-toggle>italic</cf-toggle>
          <cf-toggle>underline</cf-toggle>
        </cf-toggle-group>
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
          cf-toggle-group currently crashes the catalog when interacted with.
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
