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

interface Relationship {
  fromName: string;
  toName: string;
  label: Default<string, "">;  // "spouse", "colleague", "friend", etc.
}

interface Input {
  contacts: Cell<Default<Contact[], []>>;
  relationships: Cell<Default<Relationship[], []>>;
}

interface Output {
  contacts: Contact[];
  relationships: Relationship[];
}

export default pattern<Input, Output>(({ contacts, relationships }) => {
  const searchQuery = Cell.of("");
  const newRelationFrom = Cell.of("");
  const newRelationTo = Cell.of("");
  const newRelationLabel = Cell.of("");

  const contactCount = computed(() => contacts.get().length);

  // Build contact select items (need derive to resolve names)
  const contactSelectItems = derive(contacts, (contactList: Contact[]) =>
    contactList.map((c) => ({ label: c.name || "(unnamed)", value: c.name }))
  );

  // Get relationships for a specific contact
  const getRelationshipsFor = (contactName: string): string => {
    const rels = relationships.get().filter(
      (r) => r.fromName === contactName || r.toName === contactName
    );
    if (rels.length === 0) return "";
    return rels.map((r) => {
      const other = r.fromName === contactName ? r.toName : r.fromName;
      return `${other}${r.label ? ` (${r.label})` : ""}`;
    }).join(", ");
  };

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

              // Get relationships for this contact
              const contactRelations = derive(
                { name: contact.name, relationships },
                ({ name, relationships: rels }: { name: string; relationships: Relationship[] }) => {
                  return rels.filter((r) => r.fromName === name || r.toName === name);
                }
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
                        <ct-textarea
                          $value={contact.notes}
                          placeholder="Notes..."
                          rows={2}
                        />
                        {/* Show relationships */}
                        {contactRelations.map((rel) => (
                          <ct-hstack gap="1" align="center">
                            <span style="font-size: 0.875rem; color: var(--ct-color-gray-600);">
                              {derive(
                                { rel, name: contact.name },
                                ({ rel: r, name }: { rel: Relationship; name: string }) =>
                                  r.fromName === name ? r.toName : r.fromName
                              )}
                              {rel.label && <span> ({rel.label})</span>}
                            </span>
                            <ct-button
                              variant="ghost"
                              size="sm"
                              onClick={() => {
                                const current = relationships.get();
                                const idx = current.findIndex((r) => Cell.equals(rel, r));
                                if (idx >= 0) {
                                  relationships.set(current.toSpliced(idx, 1));
                                }
                              }}
                            >
                              ×
                            </ct-button>
                          </ct-hstack>
                        ))}
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

        <ct-vstack slot="footer" gap="2" style="padding: 1rem;">
          <ct-hstack gap="2">
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

          {/* Add relationship section */}
          <ct-hstack gap="1" align="end">
            <ct-vstack gap="0" style="flex: 1;">
              <label style="font-size: 0.75rem; color: var(--ct-color-gray-500);">From</label>
              <ct-select
                $value={newRelationFrom}
                items={contactSelectItems}
                placeholder="From..."
              />
            </ct-vstack>
            <ct-vstack gap="0" style="flex: 1;">
              <label style="font-size: 0.75rem; color: var(--ct-color-gray-500);">To</label>
              <ct-select
                $value={newRelationTo}
                items={contactSelectItems}
                placeholder="To..."
              />
            </ct-vstack>
            <ct-vstack gap="0" style="flex: 1;">
              <label style="font-size: 0.75rem; color: var(--ct-color-gray-500);">Label</label>
              <ct-input
                $value={newRelationLabel}
                placeholder="friend, spouse..."
              />
            </ct-vstack>
            <ct-button
              onClick={() => {
                const from = newRelationFrom.get();
                const to = newRelationTo.get();
                if (from && to && from !== to) {
                  relationships.push({
                    fromName: from,
                    toName: to,
                    label: newRelationLabel.get(),
                  });
                  newRelationFrom.set("");
                  newRelationTo.set("");
                  newRelationLabel.set("");
                }
              }}
            >
              Link
            </ct-button>
          </ct-hstack>
        </ct-vstack>
      </ct-screen>
    ),
    contacts,
    relationships,
  };
});
