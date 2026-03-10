/// <cts-enable />
import { NAME, pattern, UI, type VNode } from "commontools";

// deno-lint-ignore no-empty-interface
interface BadgeStoryInput {}
interface BadgeStoryOutput {
  [NAME]: string;
  [UI]: VNode;
  controls: VNode;
}

export default pattern<BadgeStoryInput, BadgeStoryOutput>(() => {
  return {
    [NAME]: "ct-badge Story",
    [UI]: (
      <div
        style={{
          padding: "1rem",
          display: "flex",
          gap: "12px",
          alignItems: "center",
        }}
      >
        <ct-badge>Default</ct-badge>
        <ct-badge variant="secondary">Secondary</ct-badge>
        <ct-badge variant="destructive">Destructive</ct-badge>
        <ct-badge variant="outline">Outline</ct-badge>
      </div>
    ),
    controls: (
      <div style={{ color: "#6b7280", fontSize: "13px", padding: "8px 12px" }}>
        No interactive controls. Variants: default, secondary, destructive,
        outline.
      </div>
    ),
  };
});
