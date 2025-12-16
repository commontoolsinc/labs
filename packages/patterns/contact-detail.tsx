/// <cts-enable />
import { Cell, Default, NAME, pattern, str, UI } from "commontools";

/** Wrap all fields of T in Cell<> for write access */
type Cellify<T> = { [K in keyof T]: Cell<T[K]> };

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

interface Input {
  contact: Cellify<Contact>;
}

/** #contact #person */
interface Output {
  contact: Contact;
}

export default pattern<Input, Output>(({ contact }) => {
  return {
    [NAME]: str`Contact: ${contact.name}`,
    [UI]: (
      <ct-screen>
        <ct-vstack slot="header">
          <ct-heading level={4}>{contact.name || "New Contact"}</ct-heading>
        </ct-vstack>

        <ct-vscroll flex showScrollbar fadeEdges>
          <ct-vstack gap="3" style="padding: 1rem;">
            <ct-card>
              <ct-vstack gap="2">
                <ct-vstack gap="1">
                  <label style="font-size: 0.75rem; font-weight: 500; color: var(--ct-color-gray-500);">
                    Name
                  </label>
                  <ct-input $value={contact.name} placeholder="Full name" />
                </ct-vstack>

                <ct-vstack gap="1">
                  <label style="font-size: 0.75rem; font-weight: 500; color: var(--ct-color-gray-500);">
                    Email
                  </label>
                  <ct-input
                    $value={contact.email}
                    placeholder="email@example.com"
                    type="email"
                  />
                </ct-vstack>

                <ct-vstack gap="1">
                  <label style="font-size: 0.75rem; font-weight: 500; color: var(--ct-color-gray-500);">
                    Phone
                  </label>
                  <ct-input
                    $value={contact.phone}
                    placeholder="+1 (555) 123-4567"
                    type="tel"
                  />
                </ct-vstack>

                <ct-vstack gap="1">
                  <label style="font-size: 0.75rem; font-weight: 500; color: var(--ct-color-gray-500);">
                    Company
                  </label>
                  <ct-input
                    $value={contact.company}
                    placeholder="Company name"
                  />
                </ct-vstack>
              </ct-vstack>
            </ct-card>

            <ct-card>
              <ct-vstack gap="1">
                <label style="font-size: 0.75rem; font-weight: 500; color: var(--ct-color-gray-500);">
                  Notes
                </label>
                <ct-textarea
                  $value={contact.notes}
                  placeholder="Add notes about this contact..."
                  rows={6}
                />
              </ct-vstack>
            </ct-card>
          </ct-vstack>
        </ct-vscroll>
      </ct-screen>
    ),
    contact,
  };
});
