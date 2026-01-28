/// <cts-enable />
/**
 * Contacts - Master-detail container for PersonLike items.
 *
 * Architecture: Stores charm results (pattern outputs with [UI]), not raw data.
 * Pattern instantiation happens at insertion time in handlers.
 *
 * Features:
 * - Manual groups: Create named groups and assign contacts to them
 * - sameAs visual grouping: Contacts linked via sameAs appear indented under primary
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
  ContactCharm,
  ContactGroup,
  FamilyMember,
  Person,
} from "./contact-types.tsx";

// Import patterns (they return charms with [UI])
import PersonPattern from "./person.tsx";
import FamilyMemberPattern from "./family-member.tsx";

// ============================================================================
// Input/Output Schemas
// ============================================================================

interface Input {
  // Store charm results, not raw data
  contacts: Writable<Default<ContactCharm[], []>>;
  groups: Writable<Default<ContactGroup[], []>>;
}

interface Output {
  [NAME]: string;
  [UI]: VNode;
  contacts: ContactCharm[];
  groups: ContactGroup[];
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
  const personData = Writable.of<Person>({
    firstName: "",
    lastName: "",
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
  contacts.push(charm as ContactCharm);
  selectedIndex.set(contacts.get().length - 1);
});

const removeContact = handler<
  unknown,
  {
    contacts: Writable<ContactCharm[]>;
    groups: Writable<ContactGroup[]>;
    index: number;
    selectedIndex: Writable<number>;
  }
>((_event, { contacts, groups, index, selectedIndex }) => {
  const current = contacts.get();
  contacts.set(current.toSpliced(index, 1));

  // Update group indices: remove references to deleted index, shift higher indices
  const currentGroups = groups.get();
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
  const current = groups.get();
  groups.set([...current, { name: "New Group", contactIndices: [] }]);
});

const removeGroup = handler<
  unknown,
  { groups: Writable<ContactGroup[]>; groupIndex: number }
>((_event, { groups, groupIndex }) => {
  const current = groups.get();
  groups.set(current.toSpliced(groupIndex, 1));
});

const removeContactFromGroup = handler<
  unknown,
  {
    groups: Writable<ContactGroup[]>;
    groupIndex: number;
    contactIndex: number;
  }
>((_event, { groups, groupIndex, contactIndex }) => {
  const current = groups.get();
  const group = current[groupIndex];
  const updated = [...current];
  updated[groupIndex] = {
    ...group,
    contactIndices: (group.contactIndices || []).filter(
      (i: number) => i !== contactIndex,
    ),
  };
  groups.set(updated);
});

const toggleGroupExpanded = handler<
  unknown,
  { groupExpanded: Writable<Record<number, boolean>>; gi: number }
>((_e, { groupExpanded: ge, gi: idx }) => {
  const cur = ge.get();
  ge.set({ ...cur, [idx]: cur[idx] === false ? true : false });
});

const toggleAddToGroup = handler<
  unknown,
  { addToGroupContact: Writable<number>; contactIndex: number }
>((_e, { addToGroupContact: atg, contactIndex: idx }) => {
  atg.set(atg.get() === idx ? -1 : idx);
});

const assignContactToGroup = handler<
  unknown,
  {
    groups: Writable<ContactGroup[]>;
    groupIndex: number;
    contactIndex: number;
    addToGroupContact: Writable<number>;
  }
>((
  _e,
  { groups: gs, groupIndex: gidx, contactIndex: cidx, addToGroupContact: atg },
) => {
  const cur = gs.get();
  const grp = cur[gidx];
  const idxs = grp.contactIndices || [];
  if (idxs.includes(cidx)) return;
  const upd = [...cur];
  upd[gidx] = { ...grp, contactIndices: [...idxs, cidx] };
  gs.set(upd);
  atg.set(-1);
});

// ============================================================================
// Helpers
// ============================================================================

function computeClusters(
  all: readonly ContactCharm[],
): Map<number, number> {
  const secondaryToParent = new Map<number, number>();
  for (let i = 0; i < all.length; i++) {
    const c = all[i];
    const data = c.person ?? c.member;
    if (!data?.sameAs) continue;
    const linked = data.sameAs;
    for (let j = 0; j < all.length; j++) {
      if (j === i) continue;
      const other = all[j];
      const otherData = other.person ?? other.member;
      if (!otherData) continue;
      if (
        otherData.firstName === linked.firstName &&
        otherData.lastName === linked.lastName
      ) {
        secondaryToParent.set(i, j);
        break;
      }
    }
  }
  return secondaryToParent;
}

// ============================================================================
// UI Helpers
// ============================================================================

function contactCard(
  charm: ContactCharm,
  index: number,
  selectedIndex: Writable<number>,
  contacts: Writable<ContactCharm[]>,
  groups: Writable<ContactGroup[]>,
  indented?: boolean,
) {
  return (
    <ct-card
      style={computed(() => {
        const base = selectedIndex.get() === index
          ? "background: var(--ct-color-blue-50, #eff6ff); border: 1px solid var(--ct-color-blue-300, #93c5fd); cursor: pointer;"
          : "cursor: pointer;";
        return indented ? `${base} margin-left: 16px;` : base;
      })}
      onClick={selectContact({ selectedIndex, index })}
    >
      <ct-hstack style="gap: 8px; align-items: center;">
        {indented
          ? (
            <span
              style={{
                fontSize: "12px",
                color: "#9ca3af",
                marginRight: "-4px",
              }}
            >
              ↳
            </span>
          )
          : null}
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
              return (parts[0].charAt(0) + parts[1].charAt(0)).toUpperCase();
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
  );
}

// ============================================================================
// Pattern
// ============================================================================

export default pattern<Input, Output>(({ contacts, groups }) => {
  const count = computed(() => contacts.get().length);
  const selectedIndex = Writable.of<number>(-1);

  // Track which group sections are expanded
  const groupExpanded = Writable.of<Record<number, boolean>>({});

  const openInNewView = action(() => {
    const idx = selectedIndex.get();
    if (idx < 0) return;
    const charm = contacts.key(idx).get();
    return navigateTo(charm);
  });

  // State for showing the "add to group" dropdown
  const addToGroupContact = Writable.of<number>(-1);

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

                {/* Render grouped contacts */}
                {computed(() => {
                  const all = contacts.get();
                  const grps = groups.get();
                  const clusters = computeClusters(all);
                  const expanded = groupExpanded.get();

                  // Compute ungrouped indices
                  const assigned = new Set<number>();
                  for (const g of grps) {
                    for (const idx of g.contactIndices || []) {
                      assigned.add(idx);
                    }
                  }
                  const ungrouped: number[] = [];
                  for (let i = 0; i < all.length; i++) {
                    if (!assigned.has(i)) ungrouped.push(i);
                  }

                  const sections: any[] = [];

                  // Render each group
                  for (let gi = 0; gi < grps.length; gi++) {
                    const group = grps[gi];
                    const isExpanded = expanded[gi] !== false; // default expanded

                    sections.push(
                      <ct-vstack style="gap: 2px;">
                        <ct-hstack
                          style="justify-content: space-between; align-items: center; padding: 4px 0; cursor: pointer;"
                          onClick={toggleGroupExpanded({ groupExpanded, gi })}
                        >
                          <ct-hstack style="gap: 4px; align-items: center;">
                            <span
                              style={{
                                fontSize: "10px",
                                color: "#6b7280",
                              }}
                            >
                              {isExpanded ? "▾" : "▸"}
                            </span>
                            <ct-input
                              $value={groups.key(gi).key("name")}
                              style={{
                                fontSize: "12px",
                                fontWeight: "600",
                                border: "none",
                                background: "transparent",
                                padding: "0",
                                color: "#374151",
                              }}
                            />
                            <span
                              style={{
                                fontSize: "11px",
                                color: "#9ca3af",
                              }}
                            >
                              ({(group.contactIndices || []).length})
                            </span>
                          </ct-hstack>
                          <ct-button
                            variant="ghost"
                            size="sm"
                            onClick={removeGroup({ groups, groupIndex: gi })}
                          >
                            ×
                          </ct-button>
                        </ct-hstack>

                        {isExpanded
                          ? (
                            <ct-vstack style="gap: 2px;">
                              {(group.contactIndices || []).map(
                                (ci: number) => {
                                  if (ci >= all.length) return null;
                                  const charm = all[ci];
                                  const isSecondary = clusters.has(ci);
                                  return (
                                    <ct-hstack style="gap: 2px; align-items: stretch;">
                                      <div style={{ flex: "1" }}>
                                        {contactCard(
                                          charm,
                                          ci,
                                          selectedIndex,
                                          contacts,
                                          groups,
                                          isSecondary,
                                        )}
                                      </div>
                                      <ct-button
                                        variant="ghost"
                                        size="sm"
                                        onClick={removeContactFromGroup({
                                          groups,
                                          groupIndex: gi,
                                          contactIndex: ci,
                                        })}
                                        style={{
                                          fontSize: "10px",
                                          color: "#9ca3af",
                                          alignSelf: "center",
                                        }}
                                      >
                                        ⊖
                                      </ct-button>
                                    </ct-hstack>
                                  );
                                },
                              )}
                            </ct-vstack>
                          )
                          : null}
                      </ct-vstack>,
                    );
                  }

                  // Render ungrouped section (with sameAs clustering)
                  if (ungrouped.length > 0) {
                    // Build sameAs tree: primary contacts first, then secondaries indented
                    const primaries: number[] = [];
                    const childrenOf = new Map<number, number[]>();

                    for (const idx of ungrouped) {
                      const parentIdx = clusters.get(idx);
                      if (
                        parentIdx !== undefined &&
                        ungrouped.includes(parentIdx)
                      ) {
                        // This contact is secondary to another ungrouped contact
                        const children = childrenOf.get(parentIdx) || [];
                        children.push(idx);
                        childrenOf.set(parentIdx, children);
                      } else {
                        primaries.push(idx);
                      }
                    }

                    const ungroupedLabel = grps.length > 0
                      ? (
                        <span
                          style={{
                            fontSize: "12px",
                            fontWeight: "600",
                            color: "#6b7280",
                            padding: "4px 0",
                          }}
                        >
                          Ungrouped
                        </span>
                      )
                      : null;

                    const ungroupedCards: any[] = [];
                    for (const idx of primaries) {
                      const charm = all[idx];
                      ungroupedCards.push(
                        <ct-hstack style="gap: 2px; align-items: stretch;">
                          <div style={{ flex: "1" }}>
                            {contactCard(
                              charm,
                              idx,
                              selectedIndex,
                              contacts,
                              groups,
                            )}
                          </div>
                          {grps.length > 0
                            ? (
                              <ct-button
                                variant="ghost"
                                size="sm"
                                onClick={toggleAddToGroup({
                                  addToGroupContact,
                                  contactIndex: idx,
                                })}
                                style={{
                                  fontSize: "10px",
                                  color: "#9ca3af",
                                  alignSelf: "center",
                                }}
                              >
                                ⊕
                              </ct-button>
                            )
                            : null}
                        </ct-hstack>,
                      );

                      // Show "add to group" picker if active for this contact
                      if (addToGroupContact.get() === idx && grps.length > 0) {
                        ungroupedCards.push(
                          <ct-vstack
                            style={{
                              marginLeft: "16px",
                              gap: "2px",
                              padding: "4px",
                              background: "#f9fafb",
                              borderRadius: "4px",
                            }}
                          >
                            {grps.map((_g: ContactGroup, gIdx: number) => (
                              <ct-button
                                variant="ghost"
                                size="sm"
                                onClick={assignContactToGroup({
                                  groups,
                                  groupIndex: gIdx,
                                  contactIndex: idx,
                                  addToGroupContact,
                                })}
                                style={{ fontSize: "11px", textAlign: "left" }}
                              >
                                {groups.key(gIdx).key("name")}
                              </ct-button>
                            ))}
                          </ct-vstack>,
                        );
                      }

                      // Render sameAs children indented
                      const children = childrenOf.get(idx) || [];
                      for (const childIdx of children) {
                        const childCharm = all[childIdx];
                        ungroupedCards.push(
                          <ct-hstack style="gap: 2px; align-items: stretch;">
                            <div style={{ flex: "1" }}>
                              {contactCard(
                                childCharm,
                                childIdx,
                                selectedIndex,
                                contacts,
                                groups,
                                true,
                              )}
                            </div>
                            {grps.length > 0
                              ? (
                                <ct-button
                                  variant="ghost"
                                  size="sm"
                                  onClick={toggleAddToGroup({
                                    addToGroupContact,
                                    contactIndex: childIdx,
                                  })}
                                  style={{
                                    fontSize: "10px",
                                    color: "#9ca3af",
                                    alignSelf: "center",
                                  }}
                                >
                                  ⊕
                                </ct-button>
                              )
                              : null}
                          </ct-hstack>,
                        );
                      }
                    }

                    sections.push(
                      <ct-vstack style="gap: 2px;">
                        {ungroupedLabel}
                        {ungroupedCards}
                      </ct-vstack>,
                    );
                  }

                  return sections;
                })}
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
    groups,
    count,
  };
});
