/// <cts-enable />
/**
 * FamilyMember - Sub-type pattern extending PersonLike.
 *
 * Demonstrates the "fork-on-demand" concept for canonical base patterns.
 * A user who needs family tracking creates this pattern, which adds
 * domain-specific fields while remaining compatible with PersonLike.
 *
 * Any container accepting PersonLike[] can include FamilyMember items.
 */
import {
  computed,
  type Default,
  handler,
  NAME,
  pattern,
  UI,
  type VNode,
  Writable,
} from "commontools";

import type {
  ContactCharm,
  FamilyMember,
  PersonLike,
} from "./contact-types.tsx";

// Re-export for backwards compatibility
export type { FamilyMember } from "./contact-types.tsx";

// ============================================================================
// Constants
// ============================================================================

const RELATIONSHIP_OPTIONS = [
  { value: "", label: "Select..." },
  { value: "spouse", label: "Spouse" },
  { value: "partner", label: "Partner" },
  { value: "child", label: "Child" },
  { value: "parent", label: "Parent" },
  { value: "sibling", label: "Sibling" },
  { value: "grandparent", label: "Grandparent" },
  { value: "grandchild", label: "Grandchild" },
  { value: "aunt", label: "Aunt" },
  { value: "uncle", label: "Uncle" },
  { value: "cousin", label: "Cousin" },
  { value: "niece", label: "Niece" },
  { value: "nephew", label: "Nephew" },
  { value: "in-law", label: "In-law" },
  { value: "other", label: "Other" },
];

// ============================================================================
// Input/Output Schemas
// ============================================================================

interface Input {
  member: Writable<
    Default<
      FamilyMember,
      {
        firstName: "";
        lastName: "";
        relationship: "";
        birthday: "";
        dietaryRestrictions: [];
        notes: "";
        tags: [];
        allergies: [];
        giftIdeas: [];
      }
    >
  >;
  // Optional: reactive source of sibling contacts for sameAs linking.
  sameAs?: Writable<ContactCharm[]>;
}

interface Output {
  [NAME]: string;
  [UI]: VNode;
  member: FamilyMember;
}

// ============================================================================
// Handlers
// ============================================================================

// Handler for ct-tags change event
const updateDietaryRestrictions = handler<
  { detail: { tags: string[] } },
  { member: Writable<FamilyMember> }
>(({ detail }, { member }) => {
  const current = member.get();
  member.set({
    ...current,
    dietaryRestrictions: detail?.tags ?? [],
  });
});

const updateTags = handler<
  { detail: { tags: string[] } },
  { member: Writable<FamilyMember> }
>(({ detail }, { member }) => {
  const current = member.get();
  member.set({ ...current, tags: detail?.tags ?? [] });
});

const updateAllergies = handler<
  { detail: { tags: string[] } },
  { member: Writable<FamilyMember> }
>(({ detail }, { member }) => {
  const current = member.get();
  member.set({ ...current, allergies: detail?.tags ?? [] });
});

const updateGiftIdeas = handler<
  { detail: { tags: string[] } },
  { member: Writable<FamilyMember> }
>(({ detail }, { member }) => {
  const current = member.get();
  member.set({ ...current, giftIdeas: detail?.tags ?? [] });
});

// sameAs handlers
const selectSameAs = handler<
  { detail: { data?: PersonLike } },
  { member: Writable<FamilyMember>; showPicker: Writable<boolean> }
>(({ detail }, { member, showPicker }) => {
  const linked = detail?.data;
  if (!linked) return;
  const current = member.get();
  member.set({ ...current, sameAs: linked });
  showPicker.set(false);
});

const clearSameAs = handler<unknown, { member: Writable<FamilyMember> }>(
  (_event, { member }) => {
    const current = member.get();
    member.set({ ...current, sameAs: undefined });
  },
);

const togglePicker = handler<unknown, { showPicker: Writable<boolean> }>(
  (_event, { showPicker }) => {
    showPicker.set(!showPicker.get());
  },
);

const toggleSection = handler<unknown, { section: Writable<boolean> }>(
  (_event, { section }) => {
    section.set(!section.get());
  },
);

// ============================================================================
// UI Helpers
// ============================================================================

function sectionHeader(
  label: string,
  expanded: Writable<boolean>,
  count?: () => number,
) {
  return (
    <ct-hstack
      style={{
        justifyContent: "space-between",
        alignItems: "center",
        cursor: "pointer",
        paddingTop: "8px",
        borderTop: "1px solid #e5e7eb",
      }}
      onClick={toggleSection({ section: expanded })}
    >
      <label style={{ fontSize: "12px", color: "#6b7280", fontWeight: "600" }}>
        {computed(() => {
          const arrow = expanded.get() ? "▾" : "▸";
          const c = count ? count() : 0;
          const suffix = count && c > 0 ? ` (${c})` : "";
          return `${arrow} ${label}${suffix}`;
        })}
      </label>
    </ct-hstack>
  );
}

// ============================================================================
// Pattern
// ============================================================================

export default pattern<Input, Output>(({ member, sameAs }) => {
  // Computed display name showing name and relationship
  const displayName = computed(() => {
    const first = member.key("firstName").get();
    const last = member.key("lastName").get();
    const rel = member.key("relationship").get();

    let name = "";
    if (first && last) name = `${first} ${last}`;
    else if (first) name = first;
    else if (last) name = last;

    if (name && rel) return `${name} (${rel})`;
    if (name) return name;
    return "Family Member";
  });

  // Computed: current sameAs link display
  const sameAsDisplay = computed(() => {
    const linked = member.key("sameAs").get();
    if (!linked) return null;
    const first = linked.firstName || "";
    const last = linked.lastName || "";
    if (first && last) return `${first} ${last}`;
    if (first) return first;
    if (last) return last;
    return "Unknown";
  });

  // State: whether the sameAs picker is expanded
  const showPicker = Writable.of(false);

  // Section expansion state
  const showFamilyInfo = Writable.of(true);
  const showHealth = Writable.of(false);
  const showGifts = Writable.of(false);
  const showNotes = Writable.of(false);

  // Computed: autocomplete items from reactive sibling source, filtering self
  const sameAsItems = computed(() => {
    if (!sameAs) return [];
    const all = sameAs.get();
    if (!all || all.length === 0) return [];

    const selfFirst = member.key("firstName").get();
    const selfLast = member.key("lastName").get();

    const result: Array<{ value: string; label: string; data: PersonLike }> =
      [];
    for (const c of all) {
      const p = c.person ?? c.member;
      if (!p) continue;
      if (p.firstName === selfFirst && p.lastName === selfLast) continue;
      const label = p.firstName && p.lastName
        ? `${p.firstName} ${p.lastName}`
        : p.firstName || p.lastName || "Person";
      result.push({ value: label, label, data: p });
    }
    return result;
  });

  const hasSameAsCandidates = computed(() => sameAsItems.length > 0);

  return {
    [NAME]: displayName,
    [UI]: (
      <ct-screen>
        <ct-vstack style={{ gap: "16px", padding: "16px" }}>
          {/* Basic Info - always visible */}
          <ct-hstack style={{ gap: "8px" }}>
            <ct-vstack style={{ gap: "4px", flex: 1 }}>
              <label style={{ fontSize: "12px", color: "#6b7280" }}>
                First Name
              </label>
              <ct-input
                $value={member.key("firstName")}
                placeholder="First name"
              />
            </ct-vstack>
            <ct-vstack style={{ gap: "4px", flex: 1 }}>
              <label style={{ fontSize: "12px", color: "#6b7280" }}>
                Last Name
              </label>
              <ct-input
                $value={member.key("lastName")}
                placeholder="Last name"
              />
            </ct-vstack>
          </ct-hstack>

          {/* Tags */}
          <ct-vstack style={{ gap: "4px" }}>
            <label style={{ fontSize: "12px", color: "#6b7280" }}>Tags</label>
            <ct-tags
              tags={member.key("tags")}
              onct-change={updateTags({ member })}
            />
          </ct-vstack>

          {
            /* Family Info Section
           * WORKAROUND: Each computed() must be the sole reactive child of its
           * parent element. Multiple computed() siblings break rendering.
           * Wrap each sectionHeader+computed pair in a <div>.
           */
          }
          <div>
            {sectionHeader("Family Info", showFamilyInfo)}
            {computed(() => {
              if (!showFamilyInfo.get()) return null;
              return (
                <ct-vstack style={{ gap: "8px" }}>
                  <ct-vstack style={{ gap: "4px" }}>
                    <label style={{ fontSize: "12px", color: "#6b7280" }}>
                      Relationship
                    </label>
                    <ct-select
                      $value={member.key("relationship")}
                      items={RELATIONSHIP_OPTIONS}
                    />
                  </ct-vstack>
                  <ct-vstack style={{ gap: "4px" }}>
                    <label style={{ fontSize: "12px", color: "#6b7280" }}>
                      Birthday
                    </label>
                    <ct-input $value={member.key("birthday")} type="date" />
                  </ct-vstack>
                </ct-vstack>
              );
            })}
          </div>

          {/* Health & Diet Section */}
          <div>
            {sectionHeader(
              "Health & Diet",
              showHealth,
              () =>
                (member.key("dietaryRestrictions").get() || []).length +
                (member.key("allergies").get() || []).length,
            )}
            {computed(() => {
              if (!showHealth.get()) return null;
              return (
                <ct-vstack style={{ gap: "8px" }}>
                  <ct-vstack style={{ gap: "4px" }}>
                    <label style={{ fontSize: "12px", color: "#6b7280" }}>
                      Dietary Restrictions
                    </label>
                    <ct-tags
                      tags={member.key("dietaryRestrictions")}
                      onct-change={updateDietaryRestrictions({ member })}
                    />
                  </ct-vstack>
                  <ct-vstack style={{ gap: "4px" }}>
                    <label style={{ fontSize: "12px", color: "#6b7280" }}>
                      Allergies
                    </label>
                    <ct-tags
                      tags={member.key("allergies")}
                      onct-change={updateAllergies({ member })}
                    />
                  </ct-vstack>
                </ct-vstack>
              );
            })}
          </div>

          {/* Gift Ideas Section */}
          <div>
            {sectionHeader(
              "Gift Ideas",
              showGifts,
              () => (member.key("giftIdeas").get() || []).length,
            )}
            {computed(() => {
              if (!showGifts.get()) return null;
              return (
                <ct-vstack style={{ gap: "4px" }}>
                  <ct-tags
                    tags={member.key("giftIdeas")}
                    onct-change={updateGiftIdeas({ member })}
                  />
                </ct-vstack>
              );
            })}
          </div>

          {/* Notes Section */}
          <div>
            {sectionHeader("Notes", showNotes)}
            {computed(() => {
              if (!showNotes.get()) return null;
              return (
                <ct-vstack style={{ gap: "4px" }}>
                  <ct-input
                    $value={member.key("notes")}
                    placeholder="Notes about this family member..."
                    multiple
                  />
                </ct-vstack>
              );
            })}
          </div>

          {/* sameAs Section - collapsed by default, only if candidates exist */}
          <div>
            {computed(() => {
              if (!hasSameAsCandidates) return null;

              const linkedName = sameAsDisplay;

              // If linked, show compact display
              if (linkedName) {
                return (
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "4px",
                      paddingTop: "8px",
                      borderTop: "1px solid #e5e7eb",
                      fontSize: "12px",
                      color: "#6b7280",
                    }}
                  >
                    <span>Same as: {linkedName}</span>
                    <span
                      style={{ cursor: "pointer", fontSize: "14px" }}
                      onClick={clearSameAs({ member })}
                    >
                      ×
                    </span>
                  </div>
                );
              }

              // If picker is open, show autocomplete
              if (showPicker.get()) {
                return (
                  <ct-vstack
                    style={{
                      gap: "4px",
                      paddingTop: "8px",
                      borderTop: "1px solid #e5e7eb",
                    }}
                  >
                    <ct-autocomplete
                      items={sameAsItems}
                      placeholder="Search contacts..."
                      onct-select={selectSameAs({ member, showPicker })}
                    />
                  </ct-vstack>
                );
              }

              // Collapsed: small link to expand
              return (
                <ct-hstack
                  style={{
                    paddingTop: "8px",
                    borderTop: "1px solid #e5e7eb",
                  }}
                >
                  <ct-button
                    variant="ghost"
                    size="sm"
                    onClick={togglePicker({ showPicker })}
                    style={{ fontSize: "12px", color: "#6b7280" }}
                  >
                    Link to another contact...
                  </ct-button>
                </ct-hstack>
              );
            })}
          </div>
        </ct-vstack>
      </ct-screen>
    ),
    member,
  };
});
