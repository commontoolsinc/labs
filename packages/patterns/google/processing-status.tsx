/// <cts-enable />
/**
 * ProcessingStatus - Reusable loading/progress indicator for previewUI
 *
 * Shows:
 * - Nothing when processing is complete (totalCount > 0 && pendingCount === 0)
 * - Indeterminate spinner with "Loading..." when fetching items (totalCount === 0)
 * - Progress bar with "X/Y analyzing..." when processing (totalCount > 0 && pendingCount > 0)
 *
 * Usage in previewUI:
 * ```tsx
 * <ProcessingStatus
 *   totalCount={emailCount}
 *   pendingCount={pendingCount}
 *   completedCount={completedCount}
 * />
 * ```
 */
import { computed } from "commontools";

interface ProcessingStatusProps {
  totalCount: number;
  pendingCount: number;
  completedCount: number;
}

/**
 * A simple JSX component for showing processing status in previewUI.
 * Not a full pattern - just returns JSX that can be embedded directly.
 */
export default function ProcessingStatus({
  totalCount,
  pendingCount,
  completedCount,
}: ProcessingStatusProps) {
  return (
    <div
      style={{
        display: computed(
          () =>
            (totalCount || 0) > 0 && (pendingCount || 0) === 0
              ? "none"
              : "flex",
        ),
        alignItems: "center",
        gap: "6px",
        marginTop: "4px",
        height: "16px",
      }}
    >
      {/* Indeterminate loading state (fetching) */}
      <div
        style={{
          display: computed(() => ((totalCount || 0) === 0 ? "flex" : "none")),
          alignItems: "center",
          gap: "6px",
        }}
      >
        <ct-loader size="sm" />
        <span style={{ fontSize: "11px", color: "#6b7280" }}>Loading...</span>
      </div>

      {/* Progress state (analyzing) */}
      <div
        style={{
          display: computed(() =>
            (totalCount || 0) > 0 && (pendingCount || 0) > 0 ? "flex" : "none"
          ),
          alignItems: "center",
          gap: "6px",
          flex: 1,
        }}
      >
        <ct-progress
          value={completedCount}
          max={totalCount}
          style={{
            width: "60px",
            height: "6px",
          }}
        />
        <span style={{ fontSize: "11px", color: "#6b7280" }}>
          {completedCount}/{totalCount} analyzing...
        </span>
      </div>
    </div>
  );
}
