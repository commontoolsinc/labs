/// <cts-enable />
/**
 * Contacts - Master-detail container for PersonLike items.
 *
 * Architecture: Stores charm results (pattern outputs with [UI]), not raw data.
 * Pattern instantiation happens at insertion time in handlers.
 *
 * Features:
 * - Add/remove Person and FamilyMember contacts
 * - Master-detail layout with resizable panels
 * - Groups data model (UI deferred due to framework limitation:
 *   computed() siblings of .map() break reactive rendering)
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
import type {
  ContactGroup,
  ContactPiece,
  FamilyMember,
  Person,
} from "./contact-types.tsx";

// Import patterns (they return pieces with [UI])
import PersonPattern from "./person.tsx";
import FamilyMemberPattern from "./family-member.tsx";

// ============================================================================
// Input/Output Schemas
// ============================================================================

interface Input {
  // Store piece results, not raw data
  contacts: Writable<Default<ContactPiece[], []>>;
  groups: Writable<Default<ContactGroup[], []>>;
}

interface Output {
  [NAME]: string;
  [UI]: VNode;
  contacts: ContactPiece[];
  groups: ContactGroup[];
  count: number;
}

// ============================================================================
// Handlers - Instantiate patterns here, push piece results
// ============================================================================

const addPerson = handler<
  unknown,
  {
    contacts: Writable<ContactPiece[]>;
    selectedIndex: Writable<number>;
  }
>((_event, { contacts, selectedIndex }) => {
  const personData = Writable.of<Person>({
    firstName: "",
    lastName: "",
    middleName: "",
    nickname: "",
    prefix: "",
    suffix: "",
    pronouns: "",
    birthday: { month: 0, day: 0, year: 0 },
    photo: "",
    email: "",
    phone: "",
    notes: "",
    tags: [],
    addresses: [],
    socialProfiles: [],
  });
  const charm = PersonPattern({
    person: personData,
    sameAs: contacts,
  });
  const newIndex = (contacts.get() || []).length;
  contacts.push(charm as ContactPiece);
  selectedIndex.set(newIndex);
});

const addFamilyMember = handler<
  unknown,
  {
    contacts: Writable<ContactPiece[]>;
    selectedIndex: Writable<number>;
  }
>((_event, { contacts, selectedIndex }) => {
  const memberData = Writable.of<FamilyMember>({
    firstName: "",
    lastName: "",
    relationship: "",
    birthday: "",
    dietaryRestrictions: [],
    notes: "",
    tags: [],
    allergies: [],
    giftIdeas: [],
  });
  const charm = FamilyMemberPattern({
    member: memberData,
    sameAs: contacts,
  });
  const newIndex = (contacts.get() || []).length;
  contacts.push(charm as ContactPiece);
  selectedIndex.set(newIndex);
});

const removeContact = handler<
  unknown,
  {
    contacts: Writable<ContactPiece[]>;
    groups: Writable<ContactGroup[]>;
    index: number;
    selectedIndex: Writable<number>;
  }
>((_event, { contacts, groups, index, selectedIndex }) => {
  const current = contacts.get() || [];
  contacts.set(current.toSpliced(index, 1));

  // Update group indices: remove references to deleted index, shift higher indices
  const currentGroups = groups.get() || [];
  const updatedGroups = currentGroups.map((g) => ({
    ...g,
    contactIndices: (g.contactIndices || [])
      .filter((i: number) => i !== index)
      .map((i: number) => (i > index ? i - 1 : i)),
  }));
  groups.set(updatedGroups);

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

// Group handlers
const addGroup = handler<
  unknown,
  { groups: Writable<ContactGroup[]> }
>((_event, { groups }) => {
  const current = groups.get() || [];
  groups.set([...current, { name: "New Group", contactIndices: [] }]);
});

// ============================================================================
// Pattern
// ============================================================================

export default pattern<Input, Output>(({ contacts, groups }) => {
  const count = computed(() => (contacts.get() || []).length);
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
              <ct-button
                variant="ghost"
                size="sm"
                onClick={addGroup({ groups })}
              >
                + Group
              </ct-button>
            </ct-hstack>
          </ct-hstack>
        </ct-vstack>

        <ct-resizable-panel-group direction="horizontal" style="flex: 1;">
          {/* Left: Contact List */}
          <ct-resizable-panel default-size="35" min-size="25" max-size="50">
            <ct-vscroll style="height: 100%;">
              <ct-vstack style="gap: 4px; padding: 8px;">
                {/* Render contact list using reactive .map() */}
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
                          groups,
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

          {/* Right: Detail View - just render the piece's [UI] */}
          <ct-resizable-panel default-size="65" min-size="30">
            {computed(() => {
              const idx = selectedIndex.get();
              if (idx < 0 || idx >= (contacts.get() || []).length) {
                return (
                  <ct-vstack style="height: 100%; align-items: center; justify-content: center; color: #6b7280;">
                    <span style={{ fontSize: "48px" }}>←</span>
                    <span>Select a contact to view details</span>
                  </ct-vstack>
                );
              }

              const piece = contacts.key(idx);

              // Piece already has [UI] - just render it with wrapper
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

                  <ct-render $cell={piece} />
                </ct-vstack>
              );
            })}
          </ct-resizable-panel>
        </ct-resizable-panel-group>
      </ct-screen>
    ),
    contacts,
    groups,
    count,
  };
});
