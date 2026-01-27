/// <cts-enable />
/**
 * Contacts - Container pattern for PersonLike items.
 *
 * Demonstrates structural typing: this container accepts PersonLike[]
 * and can hold any type satisfying { firstName, lastName } - including
 * Person, FamilyMember, or any future sub-type.
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
// Input/Output Schemas
// ============================================================================

interface Input {
  contacts: Writable<Default<PersonLike[], []>>;
}

interface Output {
  [NAME]: string;
  [UI]: VNode;
  contacts: PersonLike[];
  count: number;
}

// ============================================================================
// Handlers
// ============================================================================

// Add a new Person (just the data, satisfies PersonLike)
const addPerson = handler<unknown, { contacts: Writable<PersonLike[]> }>(
  (_event, { contacts }) => {
    contacts.push({ firstName: "", lastName: "" });
  },
);

// Add a new FamilyMember (just the data, satisfies PersonLike)
const addFamilyMember = handler<unknown, { contacts: Writable<PersonLike[]> }>(
  (_event, { contacts }) => {
    contacts.push({ firstName: "", lastName: "" });
  },
);

// Remove a contact
const removeContact = handler<
  unknown,
  { contacts: Writable<PersonLike[]>; index: number }
>((_event, { contacts, index }) => {
  const current = contacts.get();
  contacts.set(current.toSpliced(index, 1));
});

// ============================================================================
// Pattern
// ============================================================================

export default pattern<Input, Output>(({ contacts }) => {
  const count = computed(() => contacts.get().length);

  return {
    [NAME]: computed(() => `Contacts (${count})`),
    [UI]: (
      <ct-screen>
        <ct-vstack slot="header" style={{ gap: "8px" }}>
          <ct-hstack
            style={{ justifyContent: "space-between", alignItems: "center" }}
          >
            <ct-heading level={4}>Contacts</ct-heading>
            <ct-hstack style={{ gap: "8px" }}>
              <ct-button variant="primary" onClick={addPerson({ contacts })}>
                + Person
              </ct-button>
              <ct-button
                variant="secondary"
                onClick={addFamilyMember({ contacts })}
              >
                + Family Member
              </ct-button>
            </ct-hstack>
          </ct-hstack>
          <span style={{ fontSize: "13px", color: "#6b7280" }}>
            {computed(() => {
              const n = contacts.get().length;
              return `${n} contact${n === 1 ? "" : "s"}`;
            })}
          </span>
        </ct-vstack>

        <ct-vscroll flex>
          <ct-vstack style={{ gap: "8px", padding: "16px" }}>
            {computed(() =>
              contacts.get().length === 0
                ? (
                  <ct-card>
                    <ct-vstack
                      style={{
                        alignItems: "center",
                        padding: "32px",
                        color: "#6b7280",
                      }}
                    >
                      <span style={{ fontSize: "48px" }}>👥</span>
                      <span>No contacts yet</span>
                      <span style={{ fontSize: "13px" }}>
                        Add a Person or Family Member to get started
                      </span>
                    </ct-vstack>
                  </ct-card>
                )
                : null
            )}

            {contacts.map((contact, index) => {
              return (
                <ct-card>
                  <ct-hstack
                    style={{
                      justifyContent: "space-between",
                      alignItems: "center",
                      gap: "12px",
                    }}
                  >
                    <span
                      style={{
                        width: "40px",
                        height: "40px",
                        borderRadius: "50%",
                        background: "#e5e7eb",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        fontSize: "18px",
                        flexShrink: 0,
                      }}
                    >
                      {computed(() => {
                        const first = contact.firstName || "";
                        const last = contact.lastName || "";
                        const initials =
                          (first.charAt(0) + last.charAt(0)).toUpperCase() ||
                          "?";
                        return initials;
                      })}
                    </span>
                    <ct-input
                      $value={contact.key("firstName")}
                      placeholder="First"
                      style={{ flex: 1 }}
                    />
                    <ct-input
                      $value={contact.key("lastName")}
                      placeholder="Last"
                      style={{ flex: 1 }}
                    />
                    <ct-button
                      variant="ghost"
                      onClick={removeContact({ contacts, index })}
                    >
                      ×
                    </ct-button>
                  </ct-hstack>
                </ct-card>
              );
            })}
          </ct-vstack>
        </ct-vscroll>
      </ct-screen>
    ),
    contacts,
    count,
  };
});
