/// <cts-enable />
import {
  Cell,
  computed,
  Default,
  derive,
  ifElse,
  NAME,
  pattern,
  UI,
} from "commontools";

interface Contact {
  name: string;
  email: Default<string, "">;
  phone: Default<string, "">;
  company: Default<string, "">;
  tags: Default<string[], []>;
  notes: Default<string, "">;
  createdAt: number;
}

interface Input {
  contacts: Cell<Default<Contact[], []>>;
}

interface Output {
  contacts: Contact[];
}

export default pattern<Input, Output>(({ contacts }) => {
  const searchQuery = Cell.of("");

  const contactCount = computed(() => contacts.get().length);

  // Check if a contact matches the search query
  const matchesSearch = (contact: Contact, query: string): boolean => {
    if (!query) return true;
    const q = query.toLowerCase();
    const name = (contact.name || "").toLowerCase();
    const email = (contact.email || "").toLowerCase();
    const company = (contact.company || "").toLowerCase();
    return name.includes(q) || email.includes(q) || company.includes(q);
  };

  return {
    [NAME]: "Contact Book",
    [UI]: (
      <ct-screen>
        <ct-vstack slot="header" gap="2">
          <ct-hstack justify="between" align="center">
            <ct-heading level={4}>Contacts ({contactCount})</ct-heading>
          </ct-hstack>
          <ct-input
            $value={searchQuery}
            placeholder="Search contacts..."
          />
        </ct-vstack>

        <ct-vscroll flex showScrollbar fadeEdges>
          <ct-vstack gap="2" style="padding: 1rem;">
            {contacts.map((contact) => {
              const isVisible = derive(
                { contact, searchQuery },
                ({ contact: c, searchQuery: q }: { contact: Contact; searchQuery: string }) => matchesSearch(c, q)
              );

              return ifElse(
                isVisible,
                <ct-card>
                  <ct-vstack gap="2">
                    <ct-hstack justify="between" align="start">
                      <ct-vstack gap="1" style="flex: 1;">
                        <ct-input
                          $value={contact.name}
                          placeholder="Name"
                          style="font-weight: 600;"
                        />
                        <ct-hstack gap="2">
                          <ct-input
                            $value={contact.email}
                            placeholder="Email"
                            style="flex: 1;"
                          />
                          <ct-input
                            $value={contact.phone}
                            placeholder="Phone"
                            style="flex: 1;"
                          />
                        </ct-hstack>
                        <ct-input
                          $value={contact.company}
                          placeholder="Company"
                        />
                      </ct-vstack>
                      <ct-button
                        variant="ghost"
                        onClick={() => {
                          const current = contacts.get();
                          const idx = current.findIndex((c) => Cell.equals(contact, c));
                          if (idx >= 0) {
                            contacts.set(current.toSpliced(idx, 1));
                          }
                        }}
                      >
                        Delete
                      </ct-button>
                    </ct-hstack>
                  </ct-vstack>
                </ct-card>,
                null
              );
            })}

            {ifElse(
              computed(() => contacts.get().length === 0),
              <div style="text-align: center; color: var(--ct-color-gray-500); padding: 2rem;">
                No contacts yet. Add one below!
              </div>,
              null
            )}
          </ct-vstack>
        </ct-vscroll>

        <ct-hstack slot="footer" gap="2" style="padding: 1rem;">
          <ct-button
            variant="primary"
            onClick={() => {
              contacts.push({
                name: "",
                email: "",
                phone: "",
                company: "",
                tags: [],
                notes: "",
                createdAt: Date.now(),
              });
            }}
          >
            Add Contact
          </ct-button>
        </ct-hstack>
      </ct-screen>
    ),
    contacts,
  };
});
