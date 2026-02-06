/// <cts-enable />
import { computed, Default, NAME, pattern, UI, Writable } from "commontools";

/** Raw data shape - use in collection patterns */
export interface Contact {
  name: string;
  email: Default<string, "">;
  phone: Default<string, "">;
  company: Default<string, "">;
  tags: Default<string[], []>;
  notes: Default<string, "">;
  createdAt: number;
}

interface ContactDetailInput {
  contact: Writable<Contact>;
}

/** #contact #person */
interface ContactDetailOutput {
  contact: Contact;
}

export default pattern<ContactDetailInput, ContactDetailOutput>(
  ({ contact }) => {
    return {
      [NAME]: computed(() => `Contact: ${contact.key("name").get()}`),
      [UI]: (
        <ct-card>
          <ct-vstack gap="2">
            <ct-vstack gap="1">
              <label style="font-size: 0.75rem; font-weight: 500; color: var(--ct-color-gray-500);">
                Name
              </label>
              <ct-input
                $value={contact.key("name")}
                placeholder="Full name"
              />
            </ct-vstack>

            <ct-vstack gap="1">
              <label style="font-size: 0.75rem; font-weight: 500; color: var(--ct-color-gray-500);">
                Email
              </label>
              <ct-input
                $value={contact.key("email")}
                placeholder="email@example.com"
                type="email"
              />
            </ct-vstack>

            <ct-vstack gap="1">
              <label style="font-size: 0.75rem; font-weight: 500; color: var(--ct-color-gray-500);">
                Phone
              </label>
              <ct-input
                $value={contact.key("phone")}
                placeholder="+1 (555) 123-4567"
                type="tel"
              />
            </ct-vstack>

            <ct-vstack gap="1">
              <label style="font-size: 0.75rem; font-weight: 500; color: var(--ct-color-gray-500);">
                Company
              </label>
              <ct-input
                $value={contact.key("company")}
                placeholder="Company name"
              />
            </ct-vstack>
          </ct-vstack>
        </ct-card>
      ),
      contact,
    };
  },
);
