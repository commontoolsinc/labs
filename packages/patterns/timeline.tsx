/// <cts-enable />
/**
 * Timeline Module - Pattern for project dates (start, target, completed)
 *
 * A composable pattern that can be used standalone or embedded in containers
 * like Record. Tracks project timeline with multiple date fields.
 */
import { computed, type Default, NAME, pattern, UI } from "commontools";
import type { ModuleMetadata } from "./container-protocol.ts";

// ===== Self-Describing Metadata =====
export const MODULE_METADATA: ModuleMetadata = {
  type: "timeline",
  label: "Timeline",
  icon: "\u{1F4C5}", // calendar emoji
  schema: {
    startDate: { type: "string", format: "date", description: "Start date" },
    targetDate: {
      type: "string",
      format: "date",
      description: "Target completion date",
    },
    completedDate: {
      type: "string",
      format: "date",
      description: "Actual completion date",
    },
  },
  fieldMapping: ["startDate", "targetDate", "completedDate"],
};

// ===== Types =====
export interface TimelineModuleInput {
  /** Start date (ISO format YYYY-MM-DD) */
  startDate: Default<string, "">;
  /** Target completion date (ISO format YYYY-MM-DD) */
  targetDate: Default<string, "">;
  /** Actual completion date (ISO format YYYY-MM-DD) */
  completedDate: Default<string, "">;
}

// ===== The Pattern =====
export const TimelineModule = pattern<TimelineModuleInput, TimelineModuleInput>(
  "TimelineModule",
  ({ startDate, targetDate, completedDate }) => {
    // Build display text based on what's set
    const displayText = computed(() => {
      if (completedDate) return `Completed ${completedDate}`;
      if (targetDate) return `Target: ${targetDate}`;
      if (startDate) return `Started ${startDate}`;
      return "Not set";
    });

    return {
      [NAME]: computed(() =>
        `${MODULE_METADATA.icon} Timeline: ${displayText}`
      ),
      [UI]: (
        <ct-vstack style={{ gap: "12px" }}>
          <ct-vstack style={{ gap: "4px" }}>
            <label style={{ fontSize: "12px", color: "#6b7280" }}>
              Start Date
            </label>
            <ct-input type="date" $value={startDate} />
          </ct-vstack>
          <ct-vstack style={{ gap: "4px" }}>
            <label style={{ fontSize: "12px", color: "#6b7280" }}>
              Target Date
            </label>
            <ct-input type="date" $value={targetDate} />
          </ct-vstack>
          <ct-vstack style={{ gap: "4px" }}>
            <label style={{ fontSize: "12px", color: "#6b7280" }}>
              Completed Date
            </label>
            <ct-input type="date" $value={completedDate} />
          </ct-vstack>
        </ct-vstack>
      ),
      startDate,
      targetDate,
      completedDate,
    };
  },
);

export default TimelineModule;
