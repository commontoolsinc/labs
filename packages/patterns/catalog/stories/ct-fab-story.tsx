/// <cts-enable />
import { NAME, pattern, UI, type VNode } from "commontools";

// deno-lint-ignore no-empty-interface
interface FabStoryInput {}
interface FabStoryOutput {
  [NAME]: string;
  [UI]: VNode;
  controls: VNode;
}

export default pattern<FabStoryInput, FabStoryOutput>(() => {
  return {
    [NAME]: "ct-fab Story",
    [UI]: (
      <div
        style={{
          padding: "1rem",
          display: "flex",
          gap: "16px",
          alignItems: "center",
        }}
      >
        <ct-fab style="position: relative;">
          <span slot="icon">+</span>
        </ct-fab>
        <ct-fab variant="primary" style="position: relative;">
          <span slot="icon">+</span>
        </ct-fab>
      </div>
    ),
    controls: (
      <div style={{ color: "#6b7280", fontSize: "13px", padding: "8px 12px" }}>
        No interactive controls. Variants: default, primary. Attributes:
        expanded, position, pending.
      </div>
    ),
  };
});
