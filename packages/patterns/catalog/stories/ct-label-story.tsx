/// <cts-enable />
import { NAME, pattern, UI, type VNode } from "commontools";

// deno-lint-ignore no-empty-interface
interface LabelStoryInput {}
interface LabelStoryOutput {
  [NAME]: string;
  [UI]: VNode;
  controls: VNode;
}

export default pattern<LabelStoryInput, LabelStoryOutput>(() => {
  return {
    [NAME]: "ct-label Story",
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
        <ct-label>Default label</ct-label>
        <ct-label required>Required label</ct-label>
        <ct-label disabled>Disabled label</ct-label>
      </div>
    ),
    controls: (
      <div style={{ color: "#6b7280", fontSize: "13px", padding: "8px 12px" }}>
        No interactive controls. Attributes: required, disabled.
      </div>
    ),
  };
});
