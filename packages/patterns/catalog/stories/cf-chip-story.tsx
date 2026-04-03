/// <cts-enable />
import { NAME, pattern, UI, type VNode } from "commonfabric";

// deno-lint-ignore no-empty-interface
interface ChipStoryInput {}
interface ChipStoryOutput {
  [NAME]: string;
  [UI]: VNode;
  controls: VNode;
}

export default pattern<ChipStoryInput, ChipStoryOutput>(() => {
  return {
    [NAME]: "cf-chip Story",
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
        <cf-chip label="Default" />
        <cf-chip label="Primary" variant="primary" />
        <cf-chip label="Accent" variant="accent" />
        <cf-chip label="Removable" removable />
        <cf-chip label="Interactive" interactive />
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
