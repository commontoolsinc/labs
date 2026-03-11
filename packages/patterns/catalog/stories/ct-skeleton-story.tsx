/// <cts-enable />
import { NAME, pattern, UI, type VNode } from "commontools";

// deno-lint-ignore no-empty-interface
interface SkeletonStoryInput {}
interface SkeletonStoryOutput {
  [NAME]: string;
  [UI]: VNode;
  controls: VNode;
}

export default pattern<SkeletonStoryInput, SkeletonStoryOutput>(() => {
  return {
    [NAME]: "ct-skeleton Story",
    [UI]: (
      <div
        style={{
          padding: "1rem",
          display: "flex",
          flexDirection: "column",
          gap: "24px",
          maxWidth: "400px",
        }}
      >
        <div>
          <div
            style={{
              fontSize: "14px",
              fontWeight: "600",
              marginBottom: "12px",
              color: "#2e3438",
            }}
          >
            Text Variants
          </div>
          <ct-vstack gap="3">
            <ct-skeleton width="100%" height="20px" />
            <ct-skeleton variant="text" width="80%" />
            <ct-skeleton variant="text" width="60%" />
          </ct-vstack>
        </div>

        <div>
          <div
            style={{
              fontSize: "14px",
              fontWeight: "600",
              marginBottom: "12px",
              color: "#2e3438",
            }}
          >
            Card Skeleton
          </div>
          <ct-hstack gap="3" align="center">
            <ct-skeleton variant="circular" width="40px" height="40px" />
            <ct-vstack gap="2" style="flex: 1;">
              <ct-skeleton variant="text" width="70%" />
              <ct-skeleton variant="text" width="40%" />
            </ct-vstack>
          </ct-hstack>
        </div>
      </div>
    ),
    controls: (
      <div style={{ color: "#6b7280", fontSize: "13px", padding: "8px 12px" }}>
        No interactive controls. Variants: default (rectangular), text,
        circular.
      </div>
    ),
  };
});
