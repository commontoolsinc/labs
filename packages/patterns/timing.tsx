/// <cts-enable />
/**
 * Timing Module - Pattern for cooking/prep times
 *
 * A composable pattern that can be used standalone or embedded in containers
 * like Record. Tracks prep, cook, and rest times with auto-calculated total.
 */
import { computed, type Default, NAME, pattern, UI } from "commontools";
import type { ModuleMetadata } from "./container-protocol.ts";

// ===== Self-Describing Metadata =====
export const MODULE_METADATA: ModuleMetadata = {
  type: "timing",
  label: "Timing",
  icon: "\u{23F1}", // stopwatch emoji
  schema: {
    prepTime: { type: "number", description: "Prep time in minutes" },
    cookTime: { type: "number", description: "Cook time in minutes" },
    restTime: { type: "number", description: "Rest time in minutes" },
  },
  fieldMapping: ["prepTime", "cookTime", "restTime"],
};

// ===== Types =====
export interface TimingModuleInput {
  /** Prep time in minutes */
  prepTime: Default<number | null, null>;
  /** Cook time in minutes */
  cookTime: Default<number | null, null>;
  /** Rest time in minutes */
  restTime: Default<number | null, null>;
}

// ===== Helpers =====

// Format minutes as "Xh Ym"
function formatTime(minutes: number | null): string {
  if (!minutes) return "-";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
}

// ===== The Pattern =====
export const TimingModule = pattern<TimingModuleInput, TimingModuleInput>(
  "TimingModule",
  ({ prepTime, cookTime, restTime }) => {
    // Compute total time
    const totalTime = computed(() => {
      const prep = prepTime ?? 0;
      const cook = cookTime ?? 0;
      const rest = restTime ?? 0;
      return prep + cook + rest || null;
    });

    const displayText = computed(() => formatTime(totalTime));

    return {
      [NAME]: computed(() => `${MODULE_METADATA.icon} Timing: ${displayText}`),
      [UI]: (
        <ct-vstack style={{ gap: "16px" }}>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(3, 1fr)",
              gap: "12px",
            }}
          >
            <ct-vstack style={{ gap: "4px" }}>
              <label style={{ fontSize: "12px", color: "#6b7280" }}>
                Prep Time
              </label>
              <ct-hstack style={{ alignItems: "center", gap: "4px" }}>
                <ct-input
                  type="number"
                  $value={prepTime}
                  placeholder="0"
                  min="0"
                  style={{ width: "70px" }}
                />
                <span style={{ fontSize: "12px", color: "#6b7280" }}>min</span>
              </ct-hstack>
            </ct-vstack>

            <ct-vstack style={{ gap: "4px" }}>
              <label style={{ fontSize: "12px", color: "#6b7280" }}>
                Cook Time
              </label>
              <ct-hstack style={{ alignItems: "center", gap: "4px" }}>
                <ct-input
                  type="number"
                  $value={cookTime}
                  placeholder="0"
                  min="0"
                  style={{ width: "70px" }}
                />
                <span style={{ fontSize: "12px", color: "#6b7280" }}>min</span>
              </ct-hstack>
            </ct-vstack>

            <ct-vstack style={{ gap: "4px" }}>
              <label style={{ fontSize: "12px", color: "#6b7280" }}>
                Rest Time
              </label>
              <ct-hstack style={{ alignItems: "center", gap: "4px" }}>
                <ct-input
                  type="number"
                  $value={restTime}
                  placeholder="0"
                  min="0"
                  style={{ width: "70px" }}
                />
                <span style={{ fontSize: "12px", color: "#6b7280" }}>min</span>
              </ct-hstack>
            </ct-vstack>
          </div>

          {/* Total time display */}
          <div
            style={{
              padding: "12px",
              background: "#f3f4f6",
              borderRadius: "8px",
              textAlign: "center",
            }}
          >
            <span style={{ fontSize: "14px", color: "#6b7280" }}>Total:</span>
            <span
              style={{ fontSize: "18px", fontWeight: "600", marginLeft: "4px" }}
            >
              {displayText}
            </span>
          </div>
        </ct-vstack>
      ),
      prepTime,
      cookTime,
      restTime,
      totalTime,
    };
  },
);

export default TimingModule;
