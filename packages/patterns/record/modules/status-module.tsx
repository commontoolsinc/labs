/// <cts-enable />
/**
 * Status Module - Sub-charm for project/task status tracking
 */
import { computed, type Default, NAME, recipe, UI } from "commontools";

export interface StatusModuleInput {
  status: Default<string, "">;
}

const STATUS_OPTIONS = [
  { value: "", label: "Not set" },
  { value: "planned", label: "📋 Planned" },
  { value: "active", label: "🚀 Active" },
  { value: "blocked", label: "🚧 Blocked" },
  { value: "done", label: "✅ Done" },
  { value: "archived", label: "📦 Archived" },
];

export const StatusModule = recipe<StatusModuleInput, StatusModuleInput>(
  "StatusModule",
  ({ status }) => {
    const displayText = computed(() => {
      const opt = STATUS_OPTIONS.find((o) => o.value === status);
      return opt?.label || "Not set";
    });

    return {
      [NAME]: computed(() => `📊 Status: ${displayText}`),
      [UI]: (
        <ct-vstack style={{ gap: "8px" }}>
          <label style={{ fontSize: "12px", color: "#6b7280" }}>Status</label>
          <ct-select $value={status} items={STATUS_OPTIONS} />
        </ct-vstack>
      ),
      status,
    };
  }
);

export default StatusModule;
