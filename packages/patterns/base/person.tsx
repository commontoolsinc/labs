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
  NAME,
  pattern,
  type PersonLike,
  UI,
  type VNode,
  Writable,
} from "commontools";

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
// Input/Output Schemas
// ============================================================================

interface Input {
  person: Writable<
    Default<Person, { firstName: ""; lastName: ""; email: ""; phone: "" }>
  >;
}

interface Output {
  [NAME]: string;
  [UI]: VNode;
  person: Person;
}

// ============================================================================
// Pattern
// ============================================================================

export default pattern<Input, Output>(({ person }) => {
  // Computed display name from first + last name
  const displayName = computed(() => {
    const first = person.key("firstName").get();
    const last = person.key("lastName").get();
    if (first && last) return `${first} ${last}`;
    if (first) return first;
    if (last) return last;
    return "Person";
  });

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
        </ct-vstack>
      </ct-screen>
    ),
    person,
  };
});
