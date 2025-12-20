/// <cts-enable />
/**
 * Contact Module - Pattern for contact information (email, phone, website)
 *
 * A composable pattern that can be used standalone or embedded in containers
 * like Record. Stores common contact fields.
 */
import { computed, type Default, NAME, recipe, UI } from "commontools";
import type { ModuleMetadata } from "./container-protocol.ts";

// ===== Self-Describing Metadata =====
export const MODULE_METADATA: ModuleMetadata = {
  type: "contact",
  label: "Contact",
  icon: "\u{1F4E7}", // envelope emoji
  schema: {
    email: { type: "string", description: "Email address" },
    phone: { type: "string", description: "Phone number" },
    website: { type: "string", description: "Website URL" },
  },
  fieldMapping: ["email", "phone", "website"],
};

// ===== Types =====
export interface ContactModuleInput {
  email: Default<string, "">;
  phone: Default<string, "">;
  website: Default<string, "">;
}

// ===== The Pattern =====
export const ContactModule = recipe<ContactModuleInput, ContactModuleInput>(
  "ContactModule",
  ({ email, phone, website }) => {
    // Count non-empty fields for display
    const displayText = computed(() => {
      const count = [email, phone, website].filter((v) => v?.trim()).length;
      return count > 0 ? `${count} field${count !== 1 ? "s" : ""}` : "Not set";
    });

    return {
      [NAME]: computed(() => `${MODULE_METADATA.icon} Contact: ${displayText}`),
      [UI]: (
        <ct-vstack style={{ gap: "12px" }}>
          <ct-vstack style={{ gap: "4px" }}>
            <label style={{ fontSize: "12px", color: "#6b7280" }}>Email</label>
            <ct-input
              type="email"
              $value={email}
              placeholder="email@example.com"
            />
          </ct-vstack>
          <ct-vstack style={{ gap: "4px" }}>
            <label style={{ fontSize: "12px", color: "#6b7280" }}>Phone</label>
            <ct-input
              type="tel"
              $value={phone}
              placeholder="+1 (555) 123-4567"
            />
          </ct-vstack>
          <ct-vstack style={{ gap: "4px" }}>
            <label style={{ fontSize: "12px", color: "#6b7280" }}>
              Website
            </label>
            <ct-input
              type="url"
              $value={website}
              placeholder="https://example.com"
            />
          </ct-vstack>
        </ct-vstack>
      ),
      email,
      phone,
      website,
    };
  },
);

export default ContactModule;
