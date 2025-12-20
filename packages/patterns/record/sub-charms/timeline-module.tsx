/// <cts-enable />
/**
 * Timeline Module - Sub-charm for project dates (start, target, completed)
 */
import { computed, type Default, NAME, recipe, UI } from "commontools";

export interface TimelineModuleInput {
  startDate: Default<string, "">;
  targetDate: Default<string, "">;
  completedDate: Default<string, "">;
}

export const TimelineModule = recipe<TimelineModuleInput, TimelineModuleInput>(
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
      [NAME]: computed(() => `📅 Timeline: ${displayText}`),
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
  }
);

export default TimelineModule;
