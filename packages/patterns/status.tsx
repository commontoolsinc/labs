/// <cts-enable />
/**
 * Status Module - Pattern for project/task status tracking
 *
 * A composable pattern that can be used standalone or embedded in containers
 * like Record. Provides status selection with predefined options.
 */
import { computed, type Default, NAME, pattern, UI } from "commontools";
import type { ModuleMetadata } from "./container-protocol.ts";

// ===== Self-Describing Metadata =====
export const MODULE_METADATA: ModuleMetadata = {
  type: "status",
  label: "Status",
  icon: "\u{1F4CA}", // bar chart emoji
  schema: {
    status: {
      type: "string",
      enum: ["", "planned", "active", "blocked", "done", "archived"],
      description: "Project status",
    },
  },
  fieldMapping: ["status"],
};

// ===== Types =====

/** Project/task status values */
type StatusValue = "planned" | "active" | "blocked" | "done" | "archived";

export interface StatusModuleInput {
  /** Project status */
  status: Default<StatusValue | "", "">;
}

// ===== Constants =====
const STATUS_OPTIONS = [
  { value: "", label: "Not set" },
  { value: "planned", label: "📋 Planned" },
  { value: "active", label: "🚀 Active" },
  { value: "blocked", label: "🚧 Blocked" },
  { value: "done", label: "✅ Done" },
  { value: "archived", label: "📦 Archived" },
];

// ===== The Pattern =====
export const StatusModule = pattern<StatusModuleInput, StatusModuleInput>(
  ({ status }) => {
    const displayText = computed(() => {
      const opt = STATUS_OPTIONS.find((o) => o.value === status);
      return opt?.label || "Not set";
    });

    return {
      [NAME]: computed(() => `${MODULE_METADATA.icon} Status: ${displayText}`),
      [UI]: (
        <ct-vstack style={{ gap: "8px" }}>
          <label style={{ fontSize: "12px", color: "#6b7280" }}>Status</label>
          <ct-select $value={status} items={STATUS_OPTIONS} />
        </ct-vstack>
      ),
      status,
    };
  },
);

export default StatusModule;
