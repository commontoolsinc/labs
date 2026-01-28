/// <cts-enable />
/**
 * Contacts - Master-detail container for PersonLike items.
 *
 * Architecture: Stores charm results (pattern outputs with [UI]), not raw data.
 * Pattern instantiation happens at insertion time in handlers.
 */
import {
  action,
  computed,
  type Default,
  handler,
  NAME,
  navigateTo,
  pattern,
  UI,
  type VNode,
  Writable,
} from "commontools";

// Import shared types
import type { ContactCharm, FamilyMember, Person } from "./contact-types.tsx";

// Import patterns (they return charms with [UI])
import PersonPattern from "./person.tsx";
import FamilyMemberPattern from "./family-member.tsx";

// ============================================================================
// Input/Output Schemas
// ============================================================================

interface Input {
  // Store charm results, not raw data
  contacts: Writable<Default<ContactCharm[], []>>;
}

interface Output {
  [NAME]: string;
  [UI]: VNode;
  contacts: ContactCharm[];
  count: number;
}

// ============================================================================
// Handlers - Instantiate patterns here, push charm results
// ============================================================================

const addPerson = handler<
  unknown,
  {
    contacts: Writable<ContactCharm[]>;
    selectedIndex: Writable<number>;
  }
>((_event, { contacts, selectedIndex }) => {
  // Create writable data for the person
  const personData = Writable.of<Person>({
    firstName: "",
    lastName: "",
    email: "",
    phone: "",
  });
  const charm = PersonPattern({
    person: personData,
    sameAs: contacts,
  });
  contacts.push(charm as ContactCharm);
  selectedIndex.set(contacts.get().length - 1);
});

const addFamilyMember = handler<
  unknown,
  {
    contacts: Writable<ContactCharm[]>;
    selectedIndex: Writable<number>;
  }
>((_event, { contacts, selectedIndex }) => {
  // Create writable data for the family member
  const memberData = Writable.of<FamilyMember>({
    firstName: "",
    lastName: "",
    relationship: "",
    birthday: "",
    dietaryRestrictions: [],
  });
  const charm = FamilyMemberPattern({
    member: memberData,
    sameAs: contacts,
  });
  contacts.push(charm as ContactCharm);
  selectedIndex.set(contacts.get().length - 1);
});

const removeContact = handler<
  unknown,
  {
    contacts: Writable<ContactCharm[]>;
    index: number;
    selectedIndex: Writable<number>;
  }
>((_event, { contacts, index, selectedIndex }) => {
  const current = contacts.get();
  contacts.set(current.toSpliced(index, 1));
  const sel = selectedIndex.get();
  if (sel >= current.length - 1) {
    selectedIndex.set(Math.max(-1, current.length - 2));
  } else if (sel > index) {
    selectedIndex.set(sel - 1);
  }
});

const selectContact = handler<
  unknown,
  { selectedIndex: Writable<number>; index: number }
>((_event, { selectedIndex, index }) => {
  selectedIndex.set(index);
});

// ============================================================================
// Pattern
// ============================================================================

export default pattern<Input, Output>(({ contacts }) => {
  const count = computed(() => contacts.get().length);
  const selectedIndex = Writable.of<number>(-1);

  const openInNewView = action(() => {
    const idx = selectedIndex.get();
    if (idx < 0) return;
    const charm = contacts.key(idx).get();
    return navigateTo(charm);
  });

  return {
    [NAME]: computed(() => `Contacts (${count})`),
    [UI]: (
      <ct-screen>
        <ct-vstack slot="header" style="gap: 8px;">
          <ct-hstack style="justify-content: space-between; align-items: center;">
            <ct-heading level={4}>Contacts</ct-heading>
            <ct-hstack style="gap: 8px;">
              <ct-button
                variant="primary"
                onClick={addPerson({ contacts, selectedIndex })}
              >
                + Person
              </ct-button>
              <ct-button
                variant="secondary"
                onClick={addFamilyMember({ contacts, selectedIndex })}
              >
                + Family
              </ct-button>
            </ct-hstack>
          </ct-hstack>
        </ct-vstack>

        <ct-resizable-panel-group direction="horizontal" style="flex: 1;">
          {/* Left: Contact List */}
          <ct-resizable-panel default-size="35" min-size="25" max-size="50">
            <ct-vscroll style="height: 100%;">
              <ct-vstack style="gap: 4px; padding: 8px;">
                {computed(() =>
                  contacts.get().length === 0
                    ? (
                      <ct-vstack style="align-items: center; padding: 32px; color: #6b7280;">
                        <span style={{ fontSize: "48px" }}>👥</span>
                        <span>No contacts yet</span>
                      </ct-vstack>
                    )
                    : null
                )}

                {contacts.map((charm, index) => (
                  <ct-card
                    style={computed(() =>
                      selectedIndex.get() === index
                        ? "background: var(--ct-color-blue-50, #eff6ff); border: 1px solid var(--ct-color-blue-300, #93c5fd); cursor: pointer;"
                        : "cursor: pointer;"
                    )}
                    onClick={selectContact({ selectedIndex, index })}
                  >
                    <ct-hstack style="gap: 8px; align-items: center;">
                      <span
                        style={{
                          width: "32px",
                          height: "32px",
                          borderRadius: "50%",
                          background: "#e5e7eb",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          fontSize: "14px",
                          flexShrink: "0",
                        }}
                      >
                        {computed(() => {
                          const name = charm[NAME] || "";
                          const parts = name.split(" ");
                          if (parts.length >= 2) {
                            return (parts[0].charAt(0) + parts[1].charAt(0))
                              .toUpperCase();
                          }
                          return name.charAt(0).toUpperCase() || "?";
                        })}
                      </span>

                      <span style={{ flex: "1" }}>{charm[NAME]}</span>

                      <ct-button
                        variant="ghost"
                        size="sm"
                        onClick={removeContact({
                          contacts,
                          index,
                          selectedIndex,
                        })}
                      >
                        ×
                      </ct-button>
                    </ct-hstack>
                  </ct-card>
                ))}
              </ct-vstack>
            </ct-vscroll>
          </ct-resizable-panel>

          <ct-resizable-handle />

          {/* Right: Detail View - just render the charm's [UI] */}
          <ct-resizable-panel default-size="65" min-size="30">
            {computed(() => {
              const idx = selectedIndex.get();
              if (idx < 0 || idx >= contacts.get().length) {
                return (
                  <ct-vstack style="height: 100%; align-items: center; justify-content: center; color: #6b7280;">
                    <span style={{ fontSize: "48px" }}>←</span>
                    <span>Select a contact to view details</span>
                  </ct-vstack>
                );
              }

              const charm = contacts.key(idx);

              // Charm already has [UI] - just render it with wrapper
              return (
                <ct-vstack style="height: 100%;">
                  <ct-hstack style="padding: 8px 16px; border-bottom: 1px solid #e5e7eb; justify-content: flex-end;">
                    <ct-button
                      variant="outline"
                      size="sm"
                      onClick={openInNewView}
                    >
                      Open ↗
                    </ct-button>
                  </ct-hstack>

                  {/* The charm already has [UI], renderer extracts it */}
                  {charm}
                </ct-vstack>
              );
            })}
          </ct-resizable-panel>
        </ct-resizable-panel-group>
      </ct-screen>
    ),
    contacts,
    count,
  };
});
