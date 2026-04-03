/// <cts-enable />
import { NAME, pattern, UI, type VNode } from "commontools";

// deno-lint-ignore no-empty-interface
interface ChipStoryInput {}
interface ChipStoryOutput {
  [NAME]: string;
  [UI]: VNode;
  controls: VNode;
}

export default pattern<ChipStoryInput, ChipStoryOutput>(() => {
  return {
    [NAME]: "ct-chip Story",
    [UI]: (
      <div
        style={{
          padding: "1rem",
          display: "flex",
          gap: "12px",
          alignItems: "center",
          flexWrap: "wrap",
        }}
      >
        <ct-chip label="Default" />
        <ct-chip label="Primary" variant="primary" />
        <ct-chip label="Accent" variant="accent" />
        <ct-chip label="Removable" removable />
        <ct-chip label="Interactive" interactive />
      </div>
    ),
    controls: (
      <div style={{ color: "#6b7280", fontSize: "13px", padding: "8px 12px" }}>
        No interactive controls. Variants: default, primary, accent. Attributes:
        removable, interactive.
      </div>
    ),
  };
});
