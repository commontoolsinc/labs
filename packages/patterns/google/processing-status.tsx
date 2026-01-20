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
import { computed, pattern } from "commontools";

interface PatternInput {
  totalCount: number;
  pendingCount: number;
  completedCount: number;
}

interface PatternOutput {
  ui: unknown;
}

export default pattern<PatternInput, PatternOutput>(
  ({ totalCount, pendingCount, completedCount }) => {
    return {
      ui: (
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
              display: computed(() =>
                (totalCount || 0) === 0 ? "flex" : "none"
              ),
              alignItems: "center",
              gap: "6px",
            }}
          >
            <ct-loader size="sm" />
            <span style={{ fontSize: "11px", color: "#6b7280" }}>
              Loading...
            </span>
          </div>

          {/* Progress state (analyzing) */}
          <div
            style={{
              display: computed(() =>
                (totalCount || 0) > 0 && (pendingCount || 0) > 0
                  ? "flex"
                  : "none"
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
      ),
    };
  },
);
