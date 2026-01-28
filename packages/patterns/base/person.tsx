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
  Writable,
} from "commontools";

import type { ContactCharm, Person, PersonLike } from "./contact-types.tsx";

// Re-export for backwards compatibility
export type { ContactCharm, Person, PersonLike } from "./contact-types.tsx";

// ============================================================================
// Handlers
// ============================================================================

const selectSameAs = handler<
  { detail: { data?: PersonLike } },
  { person: Writable<Person>; showPicker: Writable<boolean> }
>(({ detail }, { person, showPicker }) => {
  const linked = detail?.data;
  if (!linked) return;
  const current = person.get();
  person.set({ ...current, sameAs: linked });
  showPicker.set(false);
});

const clearSameAs = handler<unknown, { person: Writable<Person> }>(
  (_event, { person }) => {
    const current = person.get();
    person.set({ ...current, sameAs: undefined });
  },
);

const togglePicker = handler<unknown, { showPicker: Writable<boolean> }>(
  (_event, { showPicker }) => {
    showPicker.set(!showPicker.get());
  },
);

// ============================================================================
// Input/Output Schemas
// ============================================================================

interface Input {
  person: Writable<
    Default<Person, { firstName: ""; lastName: ""; email: ""; phone: "" }>
  >;
  // Optional: reactive source of sibling contacts for sameAs linking.
  sameAs?: Writable<ContactCharm[]>;
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

  // State: whether the sameAs picker is expanded
  const showPicker = Writable.of(false);

  // Computed: autocomplete items from reactive sibling source, filtering self
  const sameAsItems = computed(() => {
    if (!sameAs) return [];
    const all = sameAs.get();
    if (!all || all.length === 0) return [];

    const selfFirst = person.key("firstName").get();
    const selfLast = person.key("lastName").get();

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

          {/* sameAs Section - collapsed by default, only if candidates exist */}
          {computed(() => {
            if (!hasSameAsCandidates) return null;

            const linkedName = sameAsDisplay;

            // If linked, show compact display
            if (linkedName) {
              return (
                <ct-hstack
                  style={{
                    gap: "8px",
                    alignItems: "center",
                    paddingTop: "8px",
                    borderTop: "1px solid #e5e7eb",
                  }}
                >
                  <span style={{ fontSize: "12px", color: "#6b7280" }}>
                    Same as: {linkedName}
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
                    onct-select={selectSameAs({ person, showPicker })}
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
        </ct-vstack>
      </ct-screen>
    ),
    person,
  };
});
