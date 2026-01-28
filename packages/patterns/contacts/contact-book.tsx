/// <cts-enable />
import {
  action,
  computed,
  Default,
  equals,
  ifElse,
  NAME,
  navigateTo,
  pattern,
  Stream,
  UI,
  Writable,
} from "commontools";

import ContactDetail, { type Contact } from "./contact-detail.tsx";

export const matchesSearch = (contact: Contact, query: string): boolean => {
  if (!query) return true;
  const q = query.toLowerCase();
  const name = (contact.name || "").toLowerCase();
  const email = (contact.email || "").toLowerCase();
  const company = (contact.company || "").toLowerCase();
  return name.includes(q) || email.includes(q) || company.includes(q);
};

interface Relationship {
  fromName: string;
  toName: string;
  label: Default<string, "">;
}

interface ContactBookInput {
  contacts: Writable<Default<Contact[], []>>;
  relationships: Writable<Default<Relationship[], []>>;
}

interface ContactBookOutput {
  contacts: Contact[];
  relationships: Relationship[];
  onAddContact: Stream<void>;
}

export default pattern<ContactBookInput, ContactBookOutput>(({ contacts, relationships }) => {
  const searchQuery = Writable.of("");

  const contactCount = computed(() => contacts.get().length);

  const contactSelectItems = computed(
    () =>
      contacts.map((c) => ({ label: c.name || "(unnamed)", value: c.name })),
  );

  const onAddContact = action(() => {
    contacts.push({
      name: "",
      email: "",
      phone: "",
      company: "",
      tags: [],
      notes: "",
      createdAt: Date.now(),
    });
  });

  const newRelationFrom = Writable.of("");
  const newRelationTo = Writable.of("");
  const newRelationLabel = Writable.of("");
  const onNewRelation = action(() => {
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
  });

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
              const isVisible = computed(() =>
                matchesSearch(contact, searchQuery.get())
              );

              const contactRelations = computed(() => {
                const name = contact.name;
                return relationships
                  .get()
                  .filter(
                    (r: Relationship) =>
                      r.fromName === name || r.toName === name,
                  );
              });

              const onClick = action(() => {
                const detail = ContactDetail({ contact });
                return navigateTo(detail);
              });

              const onDelete = action(() => {
                const current = contacts.get();
                const idx = current.findIndex((c) => equals(contact, c));
                if (idx >= 0) {
                  contacts.set(current.toSpliced(idx, 1));
                }
              });

              return ifElse(
                isVisible,
                <ct-card
                  style="cursor: pointer;"
                  onClick={onClick}
                >
                  <ct-hstack gap="2" align="start">
                    <ct-vstack gap="1" style="flex: 1;">
                      <span style="font-weight: 600; font-size: 1rem;">
                        {contact.name || "(unnamed)"}
                      </span>
                      {contact.email && (
                        <span style="font-size: 0.875rem; color: var(--ct-color-gray-600);">
                          {contact.email}
                        </span>
                      )}
                      {contact.company && (
                        <span style="font-size: 0.875rem; color: var(--ct-color-gray-500);">
                          {contact.company}
                        </span>
                      )}
                      {/* Show relationships */}
                      {contactRelations.map((rel: Relationship) => (
                        <span style="font-size: 0.75rem; color: var(--ct-color-primary-500);">
                          ↔ {rel.fromName === contact.name
                            ? rel.toName
                            : rel.fromName}
                          {rel.label && <span>({rel.label})</span>}
                        </span>
                      ))}
                    </ct-vstack>
                    <ct-button
                      variant="ghost"
                      onClick={onDelete}
                    >
                      ×
                    </ct-button>
                  </ct-hstack>
                </ct-card>,
                null,
              );
            })}

            {ifElse(
              computed(() => contacts.get().length === 0),
              <div style="text-align: center; color: var(--ct-color-gray-500); padding: 2rem;">
                No contacts yet. Add one below!
              </div>,
              null,
            )}
          </ct-vstack>
        </ct-vscroll>

        <ct-vstack slot="footer" gap="2" style="padding: 1rem;">
          <ct-hstack gap="2">
            <ct-button
              variant="primary"
              onClick={onAddContact}
            >
              Add Contact
            </ct-button>
          </ct-hstack>

          <ct-hstack gap="2">
            <ct-select
              $value={newRelationFrom}
              items={contactSelectItems}
              placeholder="From..."
              style="flex: 1;"
            />
            <ct-select
              $value={newRelationTo}
              items={contactSelectItems}
              placeholder="To..."
              style="flex: 1;"
            />
            <ct-input
              $value={newRelationLabel}
              placeholder="Label..."
              style="width: 100px;"
            />
            <ct-button
              onClick={onNewRelation}
            >
              Link
            </ct-button>
          </ct-hstack>
        </ct-vstack>
      </ct-screen>
    ),
    contacts,
    relationships,
    onAddContact,
  };
});
