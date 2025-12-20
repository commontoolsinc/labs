/// <cts-enable />
/**
 * Contact Module - Sub-charm for contact information (email, phone, website)
 */
import { computed, type Default, NAME, recipe, UI } from "commontools";

export interface ContactModuleInput {
  email: Default<string, "">;
  phone: Default<string, "">;
  website: Default<string, "">;
}

export const ContactModule = recipe<ContactModuleInput, ContactModuleInput>(
  "ContactModule",
  ({ email, phone, website }) => {
    // Count non-empty fields for display
    const displayText = computed(() => {
      const count = [email, phone, website].filter((v) => v?.trim()).length;
      return count > 0 ? `${count} field${count !== 1 ? "s" : ""}` : "Not set";
    });

    return {
      [NAME]: computed(() => `📧 Contact: ${displayText}`),
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
            <label style={{ fontSize: "12px", color: "#6b7280" }}>Website</label>
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
  }
);

export default ContactModule;
