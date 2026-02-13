/// <cts-enable />
/**
 * Email Module - Pattern for a single email address with customizable label
 *
 * A composable pattern that can be used standalone or embedded in containers
 * like Record. Stores one email with a label (Personal, Work, School, etc.)
 */
import { computed, type Default, NAME, pattern, UI } from "commontools";
import type { ModuleMetadata } from "./container-protocol.ts";

// ===== Standard Labels =====
export const STANDARD_LABELS = ["Personal", "Work", "School", "Other"];

// ===== Self-Describing Metadata =====
export const MODULE_METADATA: ModuleMetadata = {
  type: "email",
  label: "Email",
  icon: "\u{1F4E7}", // 📧 envelope emoji
  allowMultiple: true, // Show "add another" button for multiple emails
  // Schema field names MUST match module input property names for extraction to work
  schema: {
    address: { type: "string", format: "email", description: "Email address" },
    label: {
      type: "string",
      enum: STANDARD_LABELS,
      description: "Email label (Personal, Work, etc.)",
    },
  },
  // fieldMapping maps LLM extraction field names to this module type
  // First entry should be primary (matches schema), rest are aliases
  fieldMapping: ["address", "email", "emailAddress"],
};

// ===== Types =====
export interface EmailModuleInput {
  /** Label for this email (Personal, Work, School, etc.) */
  label: Default<string, "Personal">;
  /** Email address */
  address: Default<string, "">;
}

// ===== The Pattern =====
export const EmailModule = pattern<EmailModuleInput, EmailModuleInput>(
  "EmailModule",
  ({ label, address }) => {
    // Build display text
    const displayText = computed(() => {
      const addr = address?.trim();
      return addr || "Not set";
    });

    // Build autocomplete items from standard labels
    const labelItems = STANDARD_LABELS.map((l) => ({ value: l, label: l }));

    return {
      [NAME]: computed(
        () => `${MODULE_METADATA.icon} ${label}: ${displayText}`,
      ),
      [UI]: (
        <ct-vstack style={{ gap: "12px" }}>
          <ct-vstack style={{ gap: "4px" }}>
            <label style={{ fontSize: "12px", color: "#6b7280" }}>Label</label>
            <ct-autocomplete
              $value={label}
              items={labelItems}
              placeholder="Select or type label..."
              allowCustom
              style={{ width: "100%" }}
            />
          </ct-vstack>
          <ct-vstack style={{ gap: "4px" }}>
            <label style={{ fontSize: "12px", color: "#6b7280" }}>Email</label>
            <ct-input
              type="email"
              $value={address}
              placeholder="email@example.com"
            />
          </ct-vstack>
        </ct-vstack>
      ),
      label,
      address,
    };
  },
);

export default EmailModule;
