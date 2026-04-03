/// <cts-enable />
import { NAME, pattern, UI, type VNode } from "commontools";

// deno-lint-ignore no-empty-interface
interface HeadingStoryInput {}
interface HeadingStoryOutput {
  [NAME]: string;
  [UI]: VNode;
  controls: VNode;
}

export default pattern<HeadingStoryInput, HeadingStoryOutput>(() => {
  return {
    [NAME]: "ct-heading Story",
    [UI]: (
      <div
        style={{
          padding: "1rem",
          display: "flex",
          flexDirection: "column",
          gap: "12px",
        }}
      >
        <ct-heading level={1}>Heading Level 1</ct-heading>
        <ct-heading level={2}>Heading Level 2</ct-heading>
        <ct-heading level={3}>Heading Level 3</ct-heading>
        <ct-heading level={4}>Heading Level 4</ct-heading>
        <ct-heading level={5}>Heading Level 5</ct-heading>
        <ct-heading level={6}>Heading Level 6</ct-heading>
      </div>
    ),
    controls: (
      <div style={{ color: "#6b7280", fontSize: "13px", padding: "8px 12px" }}>
        No interactive controls. Levels 1-6.
      </div>
    ),
  };
});
