/// <cts-enable />
import { NAME, pattern, UI, type VNode } from "commonfabric";

// deno-lint-ignore no-empty-interface
interface LabelStoryInput {}
interface LabelStoryOutput {
  [NAME]: string;
  [UI]: VNode;
  controls: VNode;
}

export default pattern<LabelStoryInput, LabelStoryOutput>(() => {
  return {
    [NAME]: "cf-label Story",
    [UI]: (
      <div
        style={{
          padding: "1rem",
          display: "flex",
          flexDirection: "column",
          gap: "12px",
          maxWidth: "320px",
        }}
      >
        <cf-label>Default label</cf-label>
        <cf-label required>Required label</cf-label>
        <cf-label disabled>Disabled label</cf-label>
      </div>
    ),
    controls: (
      <div style={{ color: "#6b7280", fontSize: "13px", padding: "8px 12px" }}>
        No interactive controls. Attributes: required, disabled.
      </div>
    ),
  };
});
