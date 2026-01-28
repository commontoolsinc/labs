/// <cts-enable />
/**
 * Person - Canonical base pattern for person data.
 *
 * This pattern serves as the schelling point for person-like data.
 * It implements the PersonLike interface ({ firstName, lastName }) and adds
 * optional contact fields (email, phone).
 *
 * Sub-types can extend Person or PersonLike to add domain-specific fields:
 * - FamilyMember adds: relationship, birthday, dietary restrictions
 * - Colleague adds: company, department, title
 * - Contact adds: multiple phones, addresses, social profiles
 */
import {
  computed,
  type Default,
  handler,
  NAME,
  pattern,
  UI,
  type VNode,
  type Writable,
} from "commontools";

// ============================================================================
// PersonLike - Schelling point for person data (structural type)
// ============================================================================

/**
 * Minimal interface for person-like items.
 * Defined locally in patterns, not in core API - works via duck typing.
 * Any object with { firstName, lastName } satisfies PersonLike.
 */
export interface PersonLike {
  firstName: string;
  lastName: string;
  /** Optional link to same entity in another context (e.g., work vs personal) */
  sameAs?: PersonLike;
}

// ============================================================================
// Person Type - Extends PersonLike with optional contact fields
// ============================================================================

export interface Person extends PersonLike {
  firstName: string;
  lastName: string;
  email: Default<string, "">;
  phone: Default<string, "">;
}

// ============================================================================
// Handlers
// ============================================================================

const setSameAs = handler<
  unknown,
  { person: Writable<Person>; linkedPerson: PersonLike }
>((_event, { person, linkedPerson }) => {
  const current = person.get();
  person.set({ ...current, sameAs: linkedPerson });
});

const clearSameAs = handler<unknown, { person: Writable<Person> }>(
  (_event, { person }) => {
    const current = person.get();
    person.set({ ...current, sameAs: undefined });
  },
);

// ============================================================================
// Input/Output Schemas
// ============================================================================

interface Input {
  person: Writable<
    Default<Person, { firstName: ""; lastName: ""; email: ""; phone: "" }>
  >;
  // Optional: pre-extracted PersonLike data from container for sameAs linking
  sameAs?: PersonLike[];
}

interface Output {
  [NAME]: string;
  [UI]: VNode;
  person: Person;
}

// ============================================================================
// Pattern
// ============================================================================

export default pattern<Input, Output>(({ person, sameAs }) => {
  // Computed display name from first + last name
  const displayName = computed(() => {
    const first = person.key("firstName").get();
    const last = person.key("lastName").get();
    if (first && last) return `${first} ${last}`;
    if (first) return first;
    if (last) return last;
    return "Person";
  });

  // Computed: current sameAs link display
  const sameAsDisplay = computed(() => {
    const linked = person.key("sameAs").get();
    if (!linked) return null;
    const first = linked.firstName || "";
    const last = linked.lastName || "";
    if (first && last) return `${first} ${last}`;
    if (first) return first;
    if (last) return last;
    return "Unknown";
  });

  // Computed: filter out self from siblings for sameAs picker
  const linkableSiblings = computed(() => {
    if (!sameAs || sameAs.length === 0) return [];

    const selfFirst = person.key("firstName").get();
    const selfLast = person.key("lastName").get();

    return sameAs
      .filter((s) => !(s.firstName === selfFirst && s.lastName === selfLast))
      .map((s) => {
        const name = s.firstName && s.lastName
          ? `${s.firstName} ${s.lastName}`
          : s.firstName || s.lastName || "Person";
        return { name, linkedPerson: s as PersonLike };
      });
  });

  // Computed: whether we have siblings to link to
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
                $value={person.key("firstName")}
                placeholder="First name"
              />
            </ct-vstack>
            <ct-vstack style={{ gap: "4px", flex: 1 }}>
              <label style={{ fontSize: "12px", color: "#6b7280" }}>
                Last Name
              </label>
              <ct-input
                $value={person.key("lastName")}
                placeholder="Last name"
              />
            </ct-vstack>
          </ct-hstack>
          <ct-vstack style={{ gap: "4px" }}>
            <label style={{ fontSize: "12px", color: "#6b7280" }}>Email</label>
            <ct-input
              $value={person.key("email")}
              placeholder="Email"
              type="email"
            />
          </ct-vstack>
          <ct-vstack style={{ gap: "4px" }}>
            <label style={{ fontSize: "12px", color: "#6b7280" }}>Phone</label>
            <ct-input
              $value={person.key("phone")}
              placeholder="Phone"
              type="tel"
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
                          onClick={clearSameAs({ person })}
                        >
                          ×
                        </ct-button>
                      </ct-hstack>
                    );
                  }

                  // Show sibling picker - linkableSiblings is computed plain data
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
                            person,
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
    person,
  };
});
