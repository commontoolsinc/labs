/// <cts-enable />
/**
 * Phone Module - Pattern for a single phone number with customizable label
 *
 * A composable pattern that can be used standalone or embedded in containers
 * like Record. Stores one phone number with a label (Mobile, Home, Work, etc.)
 */
import { computed, type Default, NAME, pattern, UI } from "commontools";
import type { ModuleMetadata } from "./container-protocol.ts";

// ===== Standard Labels =====
export const STANDARD_LABELS = ["Mobile", "Home", "Work", "Other"];

// ===== Self-Describing Metadata =====
export const MODULE_METADATA: ModuleMetadata = {
  type: "phone",
  label: "Phone",
  icon: "\u{1F4F1}", // 📱 mobile phone emoji
  allowMultiple: true, // Show "add another" button for multiple phones
  // Schema field names MUST match module input property names for extraction to work
  schema: {
    number: { type: "string", description: "Phone number" },
    label: {
      type: "string",
      enum: STANDARD_LABELS,
      description: "Phone label (Mobile, Home, Work, etc.)",
    },
  },
  // fieldMapping maps LLM extraction field names to this module type
  // First entry should be primary (matches schema), rest are aliases
  fieldMapping: ["number", "phone", "phoneNumber"],
};

// ===== Types =====
export interface PhoneModuleInput {
  /** Label for this phone (Mobile, Home, Work, etc.) */
  label: Default<string, "Mobile">;
  /** Phone number (preserve original formatting) */
  number: Default<string, "">;
}

// ===== The Pattern =====
export const PhoneModule = pattern<PhoneModuleInput, PhoneModuleInput>(
  ({ label, number }) => {
    // Build display text
    const displayText = computed(() => {
      const num = number?.trim();
      return num || "Not set";
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
            <label style={{ fontSize: "12px", color: "#6b7280" }}>Phone</label>
            <ct-input
              type="tel"
              $value={number}
              placeholder="+1 (555) 123-4567"
            />
          </ct-vstack>
        </ct-vstack>
      ),
      label,
      number,
    };
  },
);

export default PhoneModule;
