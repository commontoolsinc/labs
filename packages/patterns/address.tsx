/// <cts-enable />
/**
 * Address Module - Pattern for physical address with customizable label
 *
 * A composable pattern that can be used standalone or embedded in containers
 * like Record. Stores street, city, state, and ZIP with a label (Home, Work, etc.)
 */
import { computed, type Default, NAME, pattern, UI } from "commontools";
import type { ModuleMetadata } from "./container-protocol.ts";

// ===== Standard Labels =====
export const STANDARD_LABELS = ["Home", "Work", "Billing", "Shipping", "Other"];

// ===== Self-Describing Metadata =====
export const MODULE_METADATA: ModuleMetadata = {
  type: "address",
  label: "Address",
  icon: "\u{1F4CD}", // pin emoji
  allowMultiple: true, // Show "add another" button for multiple addresses
  schema: {
    street: { type: "string", description: "Street address" },
    city: { type: "string", description: "City" },
    state: { type: "string", description: "State/Province" },
    zip: { type: "string", description: "ZIP/Postal code" },
    label: {
      type: "string",
      enum: STANDARD_LABELS,
      description: "Address label (Home, Work, etc.)",
    },
  },
  // NOTE: "label" is intentionally omitted from fieldMapping.
  // Labels (Home/Work/etc) are module-specific UI defaults, not extractable data.
  // Including "label" causes field collisions with other modules like Phone that also have labels.
  fieldMapping: ["street", "city", "state", "zip"],
};

// ===== Types =====
export interface AddressModuleInput {
  /** Label for this address (Home, Work, Billing, etc.) */
  label: Default<string, "Home">;
  /** Street address */
  street: Default<string, "">;
  /** City */
  city: Default<string, "">;
  /** State/Province */
  state: Default<string, "">;
  /** ZIP/Postal code */
  zip: Default<string, "">;
}

// ===== The Pattern =====
export const AddressModule = pattern<AddressModuleInput, AddressModuleInput>(
  ({ label, street, city, state, zip }) => {
    // Build display text from non-empty fields
    const displayText = computed(() => {
      const parts = [city, state].filter((v) => v?.trim());
      return parts.length > 0 ? parts.join(", ") : "Not set";
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
            <label style={{ fontSize: "12px", color: "#6b7280" }}>Street</label>
            <ct-input $value={street} placeholder="123 Main St" />
          </ct-vstack>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "2fr 1fr 1fr",
              gap: "8px",
            }}
          >
            <ct-vstack style={{ gap: "4px" }}>
              <label style={{ fontSize: "12px", color: "#6b7280" }}>City</label>
              <ct-input $value={city} placeholder="City" />
            </ct-vstack>
            <ct-vstack style={{ gap: "4px" }}>
              <label style={{ fontSize: "12px", color: "#6b7280" }}>
                State
              </label>
              <ct-input $value={state} placeholder="CA" />
            </ct-vstack>
            <ct-vstack style={{ gap: "4px" }}>
              <label style={{ fontSize: "12px", color: "#6b7280" }}>ZIP</label>
              <ct-input $value={zip} placeholder="12345" />
            </ct-vstack>
          </div>
        </ct-vstack>
      ),
      label,
      street,
      city,
      state,
      zip,
    };
  },
);

export default AddressModule;
