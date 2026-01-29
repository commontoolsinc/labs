/// <cts-enable />
/**
 * Person - Canonical base pattern for person data.
 *
 * This pattern serves as the schelling point for person-like data.
 * It implements the PersonLike interface ({ firstName, lastName }) and adds
 * optional contact fields (email, phone) plus rich detail fields
 * (notes, tags, addresses, socialProfiles).
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
// Constants
// ============================================================================

const SOCIAL_PLATFORM_OPTIONS = [
  { value: "", label: "Select..." },
  { value: "LinkedIn", label: "LinkedIn" },
  { value: "Twitter", label: "Twitter" },
  { value: "GitHub", label: "GitHub" },
  { value: "Instagram", label: "Instagram" },
  { value: "Facebook", label: "Facebook" },
  { value: "Website", label: "Website" },
  { value: "Other", label: "Other" },
];

const MONTH_OPTIONS = [
  { value: "0", label: "Month..." },
  { value: "1", label: "January" },
  { value: "2", label: "February" },
  { value: "3", label: "March" },
  { value: "4", label: "April" },
  { value: "5", label: "May" },
  { value: "6", label: "June" },
  { value: "7", label: "July" },
  { value: "8", label: "August" },
  { value: "9", label: "September" },
  { value: "10", label: "October" },
  { value: "11", label: "November" },
  { value: "12", label: "December" },
];

const DAY_OPTIONS = [
  { value: "0", label: "Day..." },
  ...Array.from({ length: 31 }, (_, i) => ({
    value: String(i + 1),
    label: String(i + 1),
  })),
];

const MONTH_NAMES = [
  "",
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

const ADDRESS_LABEL_OPTIONS = [
  { value: "", label: "Select..." },
  { value: "Home", label: "Home" },
  { value: "Work", label: "Work" },
  { value: "Other", label: "Other" },
];

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

const toggleSection = handler<unknown, { section: Writable<boolean> }>(
  (_event, { section }) => {
    section.set(!section.get());
  },
);

const updateTags = handler<
  { detail: { tags: string[] } },
  { person: Writable<Person> }
>(({ detail }, { person }) => {
  const current = person.get();
  person.set({ ...current, tags: detail?.tags ?? [] });
});

const addAddress = handler<unknown, { person: Writable<Person> }>(
  (_event, { person }) => {
    const current = person.get();
    const addresses = [...(current.addresses || [])];
    addresses.push({
      label: "",
      street: "",
      city: "",
      state: "",
      zip: "",
      country: "",
    });
    person.set({ ...current, addresses });
  },
);

const removeAddress = handler<
  unknown,
  { person: Writable<Person>; index: number }
>((_event, { person, index }) => {
  const current = person.get();
  const addresses = [...(current.addresses || [])];
  addresses.splice(index, 1);
  person.set({ ...current, addresses });
});

const addSocialProfile = handler<unknown, { person: Writable<Person> }>(
  (_event, { person }) => {
    const current = person.get();
    const socialProfiles = [...(current.socialProfiles || [])];
    socialProfiles.push({ platform: "", url: "" });
    person.set({ ...current, socialProfiles });
  },
);

const removeSocialProfile = handler<
  unknown,
  { person: Writable<Person>; index: number }
>((_event, { person, index }) => {
  const current = person.get();
  const socialProfiles = [...(current.socialProfiles || [])];
  socialProfiles.splice(index, 1);
  person.set({ ...current, socialProfiles });
});

// ============================================================================
// Input/Output Schemas
// ============================================================================

interface Input {
  person: Writable<
    Default<
      Person,
      {
        firstName: "";
        lastName: "";
        middleName: "";
        nickname: "";
        prefix: "";
        suffix: "";
        pronouns: "";
        birthday: { month: 0; day: 0; year: 0 };
        photo: "";
        email: "";
        phone: "";
        notes: "";
        tags: [];
        addresses: [];
        socialProfiles: [];
      }
    >
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

  // Section expansion state
  const showNameDetails = Writable.of(false);
  const showContactInfo = Writable.of(true);
  const showAddresses = Writable.of(false);
  const showSocial = Writable.of(false);
  const showNotes = Writable.of(false);

  // Computed: autocomplete items from reactive sibling source, filtering self
  const sameAsItems = computed(() => {
    if (!sameAs) return [];
    const all = sameAs.get();
    if (!all || all.length === 0) return [];

    const selfFirst = person.key("firstName").get();
    const selfLast = person.key("lastName").get();
    const hasSelfName = Boolean(selfFirst || selfLast);

    const result: Array<{ value: string; label: string; data: PersonLike }> =
      [];
    for (const c of all) {
      const p = c.person ?? c.member;
      if (!p) continue;
      // Only filter by name if this contact actually has a name set
      if (
        hasSelfName &&
        p.firstName === selfFirst &&
        p.lastName === selfLast
      ) {
        continue;
      }
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

          {/* Pronouns */}
          <ct-vstack style={{ gap: "4px" }}>
            <label style={{ fontSize: "12px", color: "#6b7280" }}>
              Pronouns
            </label>
            <ct-input
              $value={person.key("pronouns")}
              placeholder="e.g. he/him, she/her, they/them"
            />
          </ct-vstack>

          {/* Tags */}
          <ct-vstack style={{ gap: "4px" }}>
            <label style={{ fontSize: "12px", color: "#6b7280" }}>Tags</label>
            <ct-tags
              tags={person.key("tags")}
              onct-change={updateTags({ person })}
            />
          </ct-vstack>

          {/* Name Details Section */}
          <div>
            {sectionHeader("Name Details", showNameDetails)}
            {computed(() => {
              if (!showNameDetails.get()) return null;
              return (
                <ct-vstack style={{ gap: "8px" }}>
                  <ct-hstack style={{ gap: "8px" }}>
                    <ct-vstack style={{ gap: "4px", flex: 1 }}>
                      <label style={{ fontSize: "12px", color: "#6b7280" }}>
                        Prefix
                      </label>
                      <ct-input
                        $value={person.key("prefix")}
                        placeholder="Dr., Mr., Prof."
                      />
                    </ct-vstack>
                    <ct-vstack style={{ gap: "4px", flex: 1 }}>
                      <label style={{ fontSize: "12px", color: "#6b7280" }}>
                        Suffix
                      </label>
                      <ct-input
                        $value={person.key("suffix")}
                        placeholder="Jr., III, Ph.D."
                      />
                    </ct-vstack>
                  </ct-hstack>
                  <ct-vstack style={{ gap: "4px" }}>
                    <label style={{ fontSize: "12px", color: "#6b7280" }}>
                      Middle Name
                    </label>
                    <ct-input
                      $value={person.key("middleName")}
                      placeholder="Middle name"
                    />
                  </ct-vstack>
                  <ct-vstack style={{ gap: "4px" }}>
                    <label style={{ fontSize: "12px", color: "#6b7280" }}>
                      Nickname
                    </label>
                    <ct-input
                      $value={person.key("nickname")}
                      placeholder="Preferred name / what they go by"
                    />
                  </ct-vstack>
                </ct-vstack>
              );
            })}
          </div>

          {/* Birthday Section */}
          <ct-vstack style={{ gap: "4px" }}>
            <label style={{ fontSize: "12px", color: "#6b7280" }}>
              Birthday
            </label>
            <ct-hstack style={{ gap: "8px", alignItems: "center" }}>
              <ct-select
                $value={person.key("birthday").key("month")}
                items={MONTH_OPTIONS}
              />
              <ct-select
                $value={person.key("birthday").key("day")}
                items={DAY_OPTIONS}
              />
              <ct-input
                $value={person.key("birthday").key("year")}
                placeholder="Year"
                style={{ width: "80px" }}
              />
            </ct-hstack>
            {computed(() => {
              const month = person.key("birthday").key("month").get() || 0;
              const day = person.key("birthday").key("day").get() || 0;
              const year = person.key("birthday").key("year").get() || 0;
              if (month === 0 || day === 0) return null;
              const monthName = MONTH_NAMES[month] || "";
              const display = year > 0
                ? `${monthName} ${day}, ${year}`
                : `${monthName} ${day}`;
              return (
                <span style={{ fontSize: "12px", color: "#6b7280" }}>
                  {display}
                </span>
              );
            })}
          </ct-vstack>

          {/* Photo URL */}
          <ct-vstack style={{ gap: "4px" }}>
            <label style={{ fontSize: "12px", color: "#6b7280" }}>
              Photo URL
            </label>
            <ct-input
              $value={person.key("photo")}
              placeholder="https://..."
              type="url"
            />
          </ct-vstack>

          {
            /* Contact Info Section
           * WORKAROUND: Each computed() must be the sole reactive child of its
           * parent element. Multiple computed() siblings break rendering.
           * Wrap each sectionHeader+computed pair in a <div>.
           */
          }
          <div>
            {sectionHeader("Contact Info", showContactInfo)}
            {computed(() => {
              if (!showContactInfo.get()) return null;
              return (
                <ct-vstack style={{ gap: "8px" }}>
                  <ct-vstack style={{ gap: "4px" }}>
                    <label style={{ fontSize: "12px", color: "#6b7280" }}>
                      Email
                    </label>
                    <ct-input
                      $value={person.key("email")}
                      placeholder="Email"
                      type="email"
                    />
                  </ct-vstack>
                  <ct-vstack style={{ gap: "4px" }}>
                    <label style={{ fontSize: "12px", color: "#6b7280" }}>
                      Phone
                    </label>
                    <ct-input
                      $value={person.key("phone")}
                      placeholder="Phone"
                      type="tel"
                    />
                  </ct-vstack>
                </ct-vstack>
              );
            })}
          </div>

          {/* Addresses Section */}
          <div>
            {sectionHeader(
              "Addresses",
              showAddresses,
              () => (person.key("addresses").get() || []).length,
            )}
            {computed(() => {
              if (!showAddresses.get()) return null;
              const addresses = person.key("addresses").get() || [];
              return (
                <ct-vstack style={{ gap: "8px" }}>
                  {addresses.map((_addr, i) => (
                    <ct-card>
                      <ct-vstack style={{ gap: "4px" }}>
                        <ct-hstack
                          style={{
                            justifyContent: "space-between",
                            alignItems: "center",
                          }}
                        >
                          <ct-select
                            $value={person
                              .key("addresses")
                              .key(i)
                              .key("label")}
                            items={ADDRESS_LABEL_OPTIONS}
                          />
                          <ct-button
                            variant="ghost"
                            size="sm"
                            onClick={removeAddress({ person, index: i })}
                          >
                            ×
                          </ct-button>
                        </ct-hstack>
                        <ct-input
                          $value={person
                            .key("addresses")
                            .key(i)
                            .key("street")}
                          placeholder="Street"
                        />
                        <ct-hstack style={{ gap: "4px" }}>
                          <ct-input
                            $value={person
                              .key("addresses")
                              .key(i)
                              .key("city")}
                            placeholder="City"
                            style={{ flex: "1" }}
                          />
                          <ct-input
                            $value={person
                              .key("addresses")
                              .key(i)
                              .key("state")}
                            placeholder="State"
                            style={{ width: "60px" }}
                          />
                          <ct-input
                            $value={person.key("addresses").key(i).key("zip")}
                            placeholder="Zip"
                            style={{ width: "80px" }}
                          />
                        </ct-hstack>
                        <ct-input
                          $value={person
                            .key("addresses")
                            .key(i)
                            .key("country")}
                          placeholder="Country"
                        />
                      </ct-vstack>
                    </ct-card>
                  ))}
                  <ct-button
                    variant="ghost"
                    size="sm"
                    onClick={addAddress({ person })}
                  >
                    + Add Address
                  </ct-button>
                </ct-vstack>
              );
            })}
          </div>

          {/* Social Profiles Section */}
          <div>
            {sectionHeader(
              "Social Profiles",
              showSocial,
              () => (person.key("socialProfiles").get() || []).length,
            )}
            {computed(() => {
              if (!showSocial.get()) return null;
              const profiles = person.key("socialProfiles").get() || [];
              return (
                <ct-vstack style={{ gap: "8px" }}>
                  {profiles.map((_profile, i) => (
                    <ct-hstack style={{ gap: "4px", alignItems: "center" }}>
                      <ct-select
                        $value={person
                          .key("socialProfiles")
                          .key(i)
                          .key("platform")}
                        items={SOCIAL_PLATFORM_OPTIONS}
                      />
                      <ct-input
                        $value={person
                          .key("socialProfiles")
                          .key(i)
                          .key("url")}
                        placeholder="URL"
                        style={{ flex: "1" }}
                      />
                      <ct-button
                        variant="ghost"
                        size="sm"
                        onClick={removeSocialProfile({ person, index: i })}
                      >
                        ×
                      </ct-button>
                    </ct-hstack>
                  ))}
                  <ct-button
                    variant="ghost"
                    size="sm"
                    onClick={addSocialProfile({ person })}
                  >
                    + Add Profile
                  </ct-button>
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
                    $value={person.key("notes")}
                    placeholder="Notes about this person..."
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
                      onClick={clearSameAs({ person })}
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
          </div>
        </ct-vstack>
      </ct-screen>
    ),
    person,
  };
});
