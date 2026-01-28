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

// Import PersonLike from the canonical person pattern
import type { PersonLike } from "./person.tsx";

// ============================================================================
// FamilyMember Type - Extends PersonLike with family-specific fields
// ============================================================================

export interface FamilyMember extends PersonLike {
  firstName: string;
  lastName: string;
  relationship: Default<string, "">;
  birthday: Default<string, "">; // ISO date string (YYYY-MM-DD)
  dietaryRestrictions: Default<string[], []>;
}

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
      }
    >
  >;
  // Optional: reactive source of sibling contacts for sameAs linking.
  // Typed as unknown[] because the container's charm type can't be imported here.
  sameAs?: Writable<unknown[]>;
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

// sameAs handlers
const setSameAs = handler<
  unknown,
  { member: Writable<FamilyMember>; linkedPerson: PersonLike }
>((_event, { member, linkedPerson }) => {
  const current = member.get();
  member.set({ ...current, sameAs: linkedPerson });
});

const clearSameAs = handler<unknown, { member: Writable<FamilyMember> }>(
  (_event, { member }) => {
    const current = member.get();
    member.set({ ...current, sameAs: undefined });
  },
);

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

  // Computed: extract PersonLike data from reactive source, filter out self
  const linkableSiblings = computed(() => {
    if (!sameAs) return [];
    const all = sameAs.get();
    if (!all || all.length === 0) return [];

    const selfFirst = member.key("firstName").get();
    const selfLast = member.key("lastName").get();

    // Extract PersonLike from each sibling charm (person or member field)
    const extractPerson = (item: unknown): PersonLike | undefined => {
      const c = item as { person?: PersonLike; member?: PersonLike };
      return c.person ?? c.member;
    };

    return all
      .map(extractPerson)
      .filter((p): p is PersonLike =>
        !!p && !(p.firstName === selfFirst && p.lastName === selfLast)
      )
      .map((p) => ({
        name: p.firstName && p.lastName
          ? `${p.firstName} ${p.lastName}`
          : p.firstName || p.lastName || "Person",
        linkedPerson: p,
      }));
  });

  const hasSiblings = computed(() => linkableSiblings.length > 0);

  return {
    [NAME]: displayName,
    [UI]: (
      <ct-screen>
        <ct-vstack style={{ gap: "16px", padding: "16px" }}>
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

          <ct-vstack style={{ gap: "4px" }}>
            <label style={{ fontSize: "12px", color: "#6b7280" }}>
              Dietary Restrictions
            </label>
            <ct-tags
              tags={member.key("dietaryRestrictions")}
              onct-change={updateDietaryRestrictions({ member })}
            />
          </ct-vstack>

          {/* sameAs Section - only show if siblings available */}
          {computed(() => {
            if (!hasSiblings) return null;

            return (
              <ct-vstack
                style={{
                  gap: "8px",
                  paddingTop: "8px",
                  borderTop: "1px solid #e5e7eb",
                }}
              >
                <label style={{ fontSize: "12px", color: "#6b7280" }}>
                  Same As (link to another contact)
                </label>

                {computed(() => {
                  const linkedName = sameAsDisplay;
                  if (linkedName) {
                    return (
                      <ct-hstack style={{ gap: "8px", alignItems: "center" }}>
                        <span style={{ fontSize: "14px" }}>
                          Linked to: {linkedName}
                        </span>
                        <ct-button
                          variant="ghost"
                          size="sm"
                          onClick={clearSameAs({ member })}
                        >
                          ×
                        </ct-button>
                      </ct-hstack>
                    );
                  }

                  const siblings: Array<
                    { name: string; linkedPerson: PersonLike }
                  > = linkableSiblings;
                  return (
                    <ct-hstack style={{ gap: "4px", flexWrap: "wrap" }}>
                      {siblings.map((sib) => (
                        <ct-button
                          variant="outline"
                          size="sm"
                          onClick={setSameAs({
                            member,
                            linkedPerson: sib.linkedPerson,
                          })}
                        >
                          {sib.name}
                        </ct-button>
                      ))}
                    </ct-hstack>
                  );
                })}
              </ct-vstack>
            );
          })}
        </ct-vstack>
      </ct-screen>
    ),
    member,
  };
});
