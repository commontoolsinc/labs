/// <cts-enable />
/**
 * Profile - A blackboard for personal data coordination.
 *
 * This pattern serves as a Schelling point where multiple patterns
 * can read and write personal information (à la Minsky's blackboard).
 * Entities stored here can later be "popped out" to dedicated patterns
 * (person.tsx, vehicle.tsx, etc.) without changing the data structure.
 *
 * Usage from other patterns:
 *   const profile = wish<ProfileOutput>({ query: "#profile" });
 *   profile?.memberships.push({ program: "Hilton Honors", memberNumber: "12345" });
 */
import {
  action,
  computed,
  type Default,
  NAME,
  pattern,
  UI,
  type VNode,
  Writable,
} from "commonfabric";

// ============================================================================
// ATOMIC TYPES - Keep simple, use string for editable fields
// ============================================================================

interface Birthday {
  month: string; // "1"-"12" or ""
  day: string; // "1"-"31" or ""
  year: string; // "YYYY" or ""
}

interface Phone {
  label: string; // "Mobile", "Home", "Work"
  number: string;
}

interface Email {
  label: string;
  address: string;
}

interface Address {
  label: string; // "Home", "Work", "Mailing"
  street: string;
  city: string;
  state: string;
  zip: string;
  country: string;
}

interface School {
  name: string;
  gradeLevel: string;
  teacher: string;
}

// ============================================================================
// ENTITY TYPES
// ============================================================================

export interface Person {
  name: string;
  nickname: string;
  birthday: Birthday;
  relationship: string;
  phones: Phone[];
  emails: Email[];
  addresses: Address[];
  school: School;
  notes: string;
}

export interface Vehicle {
  make: string;
  model: string;
  year: string;
  licensePlate: string;
  vin: string;
  notes: string;
}

export interface Membership {
  program: string;
  memberNumber: string;
  notes: string;
}

export interface Bank {
  name: string;
  hasCheckingAccount: Default<boolean, false>;
  hasCreditCard: Default<boolean, false>;
  notes: string;
}

export interface Employment {
  employer: string;
  title: string;
  street: string;
  city: string;
  state: string;
  notes: string;
}

// ============================================================================
// LEARNED TYPES - Inferred from user behavior (populated by home.tsx)
// ============================================================================

/** A fact learned about the user from their behavior */
export interface Fact {
  content: string; // "User likes cooking", "User has kids"
  confidence: number; // 0-1, higher = more certain
  source: string; // e.g., "journal:1234567890" or "user:direct"
  timestamp: number;
}

/** A preference inferred from user behavior */
export interface Preference {
  key: string; // e.g., "cooking_style", "communication_tone"
  value: string;
  confidence: number;
  source: string;
}

/** A question to ask the user for clarification */
export interface Question {
  id: string;
  question: string;
  category: string; // "preferences", "personal", "context"
  priority: number; // Higher = ask sooner
  options?: string[]; // For multiple choice
  status: "pending" | "asked" | "answered" | "skipped";
  answer?: string;
  askedAt?: number;
  answeredAt?: number;
}

/** Section containing all learned/inferred data */
export interface LearnedSection {
  facts: Fact[];
  preferences: Preference[];
  openQuestions: Question[];
  personas: string[]; // "busy parent", "home cook", "techie"
  lastJournalProcessed: number; // Timestamp of last processed journal entry
  summary: string; // User-editable text summary
  summaryVersion: number; // Tracks when summary was last auto-generated
}

/** Default empty learned section for initialization */
export const EMPTY_LEARNED: LearnedSection = {
  facts: [],
  preferences: [],
  openQuestions: [],
  personas: [],
  lastJournalProcessed: 0,
  summary: "",
  summaryVersion: 0,
};

// ============================================================================
// DEFAULT VALUES (for Default<> type parameters)
// ============================================================================

const EMPTY_PERSON: Person = {
  name: "",
  nickname: "",
  birthday: { month: "", day: "", year: "" },
  relationship: "",
  phones: [],
  emails: [],
  addresses: [],
  school: { name: "", gradeLevel: "", teacher: "" },
  notes: "",
};

const EMPTY_EMPLOYMENT: Employment = {
  employer: "",
  title: "",
  street: "",
  city: "",
  state: "",
  notes: "",
};

// ============================================================================
// PROFILE INPUT/OUTPUT SCHEMAS
// ============================================================================

interface ProfileInput {
  self?: Writable<Default<Person, typeof EMPTY_PERSON>>;
  partner?: Writable<Default<Person, typeof EMPTY_PERSON>>;
  children?: Writable<Default<Person[], []>>;
  parents?: Writable<Default<Person[], []>>;
  inlaws?: Writable<Default<Person[], []>>;
  addresses?: Writable<Default<Address[], []>>;
  vehicles?: Writable<Default<Vehicle[], []>>;
  memberships?: Writable<Default<Membership[], []>>;
  banks?: Writable<Default<Bank[], []>>;
  employment?: Writable<Default<Employment, typeof EMPTY_EMPLOYMENT>>;
  notes?: Writable<Default<string, "">>;
  learned?: Writable<Default<LearnedSection, typeof EMPTY_LEARNED>>;
}

/** Profile blackboard for personal data coordination. #profile */
export interface Output {
  [NAME]: string;
  [UI]: VNode;
  self: Person;
  partner: Person;
  children: Person[];
  parents: Person[];
  inlaws: Person[];
  addresses: Address[];
  vehicles: Vehicle[];
  memberships: Membership[];
  banks: Bank[];
  employment: Employment;
  notes: string;
  learned: LearnedSection;
}

/** @deprecated Use Output instead - this alias exists for backwards compatibility */
export type ProfileOutput = Output;

// ============================================================================
// CONSTANTS
// ============================================================================

const ADDRESS_LABELS = [
  { value: "Home", label: "Home" },
  { value: "Work", label: "Work" },
  { value: "Mailing", label: "Mailing" },
  { value: "Other", label: "Other" },
];

const RELATIONSHIP_OPTIONS = [
  { value: "", label: "Select..." },
  { value: "spouse", label: "Spouse" },
  { value: "partner", label: "Partner" },
  { value: "child", label: "Child" },
  { value: "parent", label: "Parent" },
  { value: "sibling", label: "Sibling" },
  { value: "in-law", label: "In-law" },
  { value: "friend", label: "Friend" },
  { value: "other", label: "Other" },
];

// ============================================================================
// HELPER: Create empty entities for push operations
// ============================================================================

const newPerson = (): Person => ({
  name: "",
  nickname: "",
  birthday: { month: "", day: "", year: "" },
  relationship: "",
  phones: [],
  emails: [],
  addresses: [],
  school: { name: "", gradeLevel: "", teacher: "" },
  notes: "",
});

const newAddress = (): Address => ({
  label: "Home",
  street: "",
  city: "",
  state: "",
  zip: "",
  country: "",
});

const newVehicle = (): Vehicle => ({
  make: "",
  model: "",
  year: "",
  licensePlate: "",
  vin: "",
  notes: "",
});

const newMembership = (): Membership => ({
  program: "",
  memberNumber: "",
  notes: "",
});

const newBank = (): Bank => ({
  name: "",
  hasCheckingAccount: false,
  hasCreditCard: false,
  notes: "",
});

// ============================================================================
// STYLES
// ============================================================================

const sectionHeaderStyle = {
  display: "flex",
  alignItems: "center",
  gap: "8px",
  width: "100%",
  padding: "12px 16px",
  background: "var(--cf-color-bg-secondary, #f9fafb)",
  border: "1px solid var(--cf-color-border, #e5e5e7)",
  borderRadius: "8px",
  cursor: "pointer",
  fontSize: "15px",
  fontWeight: "600",
};

const sectionContentStyle = {
  padding: "12px",
  background: "var(--cf-color-bg, white)",
  border: "1px solid var(--cf-color-border, #e5e5e7)",
  borderRadius: "8px",
};

const labelStyle = { fontSize: "11px", color: "#6b7280" };

const removeButtonStyle = {
  padding: "8px",
  background: "none",
  border: "none",
  cursor: "pointer",
  color: "#ef4444",
};

const bigAddButtonStyle = {
  padding: "12px 24px",
  background: "var(--cf-color-bg-secondary, #f3f4f6)",
  border: "1px dashed var(--cf-color-border, #e5e5e7)",
  borderRadius: "8px",
  cursor: "pointer",
  fontSize: "14px",
};

// ============================================================================
// MAIN PATTERN
// ============================================================================

const Profile = pattern<ProfileInput, Output>(
  ({
    self,
    partner,
    children,
    parents,
    inlaws,
    addresses,
    vehicles,
    memberships,
    banks,
    employment,
    notes,
    learned,
  }) => {
    // Section expanded states
    const selfExpanded = Writable.of(true);
    const partnerExpanded = Writable.of(false);
    const childrenExpanded = Writable.of(false);
    const parentsExpanded = Writable.of(false);
    const inlawsExpanded = Writable.of(false);
    const addressesExpanded = Writable.of(false);
    const vehiclesExpanded = Writable.of(false);
    const membershipsExpanded = Writable.of(false);
    const banksExpanded = Writable.of(false);
    const employmentExpanded = Writable.of(false);
    const learnedExpanded = Writable.of(false);

    // Actions for adding items
    const addChild = action(() => children.push(newPerson()));
    const addParent = action(() => parents.push(newPerson()));
    const addInlaw = action(() => inlaws.push(newPerson()));
    const addAddress = action(() => addresses.push(newAddress()));
    const addVehicle = action(() => vehicles.push(newVehicle()));
    const addMembership = action(() => memberships.push(newMembership()));
    const addBank = action(() => banks.push(newBank()));

    // Computed display name
    const displayName = computed(() => {
      const name = self.key("name").get();
      return name ? `${name}'s Profile` : "My Profile";
    });

    // Note: Journal watching and profile learning is handled by home.tsx
    // This pattern is purely UI - it displays the learned cell passed to it

    return {
      [NAME]: computed(() => `👤 ${displayName}`),
      [UI]: (
        <cf-screen>
          <cf-vstack
            slot="header"
            gap="2"
            padding="4"
            style={{
              borderBottom: "1px solid var(--cf-color-border, #e5e5e7)",
            }}
          >
            <h2 style={{ margin: 0, fontSize: "18px", fontWeight: "600" }}>
              {displayName}
            </h2>
            <span
              style={{
                fontSize: "13px",
                color: "var(--cf-color-text-secondary, #6b7280)",
              }}
            >
              Personal data blackboard - tag with #profile for discovery
            </span>
          </cf-vstack>

          <cf-vscroll style={{ flex: 1, padding: "16px" }}>
            <cf-vstack
              style={{ gap: "16px", maxWidth: "800px", margin: "0 auto" }}
            >
              {/* === SELF === */}
              <cf-vstack style={{ gap: "8px" }}>
                <button
                  type="button"
                  style={sectionHeaderStyle}
                  onClick={() => selfExpanded.set(!selfExpanded.get())}
                >
                  <span style={{ fontSize: "18px" }}>👤</span>
                  <span style={{ flex: 1, textAlign: "left" }}>About Me</span>
                  <span style={{ color: "var(--cf-color-text-secondary)" }}>
                    {computed(() => selfExpanded.get() ? "▼" : "▶")}
                  </span>
                </button>
                <div
                  style={{
                    display: computed(() =>
                      selfExpanded.get() ? "block" : "none"
                    ),
                    ...sectionContentStyle,
                  }}
                >
                  <cf-vstack style={{ gap: "12px" }}>
                    <cf-hstack style={{ gap: "8px" }}>
                      <cf-vstack style={{ gap: "4px", flex: 1 }}>
                        <label style={labelStyle}>Your Name</label>
                        <cf-input
                          $value={self.key("name")}
                          placeholder="Your full name"
                        />
                      </cf-vstack>
                      <cf-vstack style={{ gap: "4px", width: "150px" }}>
                        <label style={labelStyle}>Nickname</label>
                        <cf-input
                          $value={self.key("nickname")}
                          placeholder="Nickname"
                        />
                      </cf-vstack>
                    </cf-hstack>
                    <cf-vstack style={{ gap: "4px" }}>
                      <label style={labelStyle}>Birthday</label>
                      <cf-hstack style={{ gap: "8px" }}>
                        <cf-input
                          $value={self.key("birthday", "month")}
                          placeholder="Month"
                          style={{ width: "80px" }}
                        />
                        <cf-input
                          $value={self.key("birthday", "day")}
                          placeholder="Day"
                          style={{ width: "60px" }}
                        />
                        <cf-input
                          $value={self.key("birthday", "year")}
                          placeholder="Year"
                          style={{ width: "80px" }}
                        />
                      </cf-hstack>
                    </cf-vstack>
                    <cf-vstack style={{ gap: "4px" }}>
                      <label style={labelStyle}>Notes</label>
                      <cf-textarea
                        $value={self.key("notes")}
                        placeholder="Notes..."
                        rows={2}
                      />
                    </cf-vstack>
                  </cf-vstack>
                </div>
              </cf-vstack>

              {/* === PARTNER === */}
              <cf-vstack style={{ gap: "8px" }}>
                <button
                  type="button"
                  style={sectionHeaderStyle}
                  onClick={() => partnerExpanded.set(!partnerExpanded.get())}
                >
                  <span style={{ fontSize: "18px" }}>💑</span>
                  <span style={{ flex: 1, textAlign: "left" }}>Partner</span>
                  <span style={{ color: "var(--cf-color-text-secondary)" }}>
                    {computed(() => partnerExpanded.get() ? "▼" : "▶")}
                  </span>
                </button>
                <div
                  style={{
                    display: computed(() =>
                      partnerExpanded.get() ? "block" : "none"
                    ),
                    ...sectionContentStyle,
                  }}
                >
                  <cf-vstack style={{ gap: "12px" }}>
                    <cf-hstack style={{ gap: "8px" }}>
                      <cf-vstack style={{ gap: "4px", flex: 1 }}>
                        <label style={labelStyle}>Name</label>
                        <cf-input
                          $value={partner.key("name")}
                          placeholder="Partner's name"
                        />
                      </cf-vstack>
                      <cf-vstack style={{ gap: "4px", width: "120px" }}>
                        <label style={labelStyle}>Relationship</label>
                        <cf-select
                          $value={partner.key("relationship")}
                          items={RELATIONSHIP_OPTIONS}
                        />
                      </cf-vstack>
                    </cf-hstack>
                    <cf-vstack style={{ gap: "4px" }}>
                      <label style={labelStyle}>Notes</label>
                      <cf-textarea
                        $value={partner.key("notes")}
                        placeholder="Notes..."
                        rows={2}
                      />
                    </cf-vstack>
                  </cf-vstack>
                </div>
              </cf-vstack>

              {/* === CHILDREN === */}
              <cf-vstack style={{ gap: "8px" }}>
                <button
                  type="button"
                  style={sectionHeaderStyle}
                  onClick={() => childrenExpanded.set(!childrenExpanded.get())}
                >
                  <span style={{ fontSize: "18px" }}>👶</span>
                  <span style={{ flex: 1, textAlign: "left" }}>Children</span>
                  <span
                    style={{
                      fontSize: "12px",
                      color: "var(--cf-color-text-secondary)",
                      background: "var(--cf-color-bg)",
                      padding: "2px 8px",
                      borderRadius: "12px",
                    }}
                  >
                    {computed(() => children.get().length)}
                  </span>
                  <span style={{ color: "var(--cf-color-text-secondary)" }}>
                    {computed(() => childrenExpanded.get() ? "▼" : "▶")}
                  </span>
                </button>
                <div
                  style={{
                    display: computed(() =>
                      childrenExpanded.get() ? "block" : "none"
                    ),
                    ...sectionContentStyle,
                  }}
                >
                  <cf-vstack style={{ gap: "12px" }}>
                    {children.map((child) => (
                      <cf-card>
                        <cf-vstack style={{ gap: "12px" }}>
                          <cf-hstack
                            style={{ gap: "8px", alignItems: "flex-end" }}
                          >
                            <cf-vstack style={{ gap: "4px", flex: 1 }}>
                              <label style={labelStyle}>Name</label>
                              <cf-input
                                $value={child.name}
                                placeholder="Child's name"
                              />
                            </cf-vstack>
                            <cf-vstack style={{ gap: "4px", width: "120px" }}>
                              <label style={labelStyle}>Nickname</label>
                              <cf-input
                                $value={child.nickname}
                                placeholder="Nickname"
                              />
                            </cf-vstack>
                            <button
                              type="button"
                              style={removeButtonStyle}
                              onClick={() => children.remove(child)}
                            >
                              ✕
                            </button>
                          </cf-hstack>
                          <cf-hstack style={{ gap: "8px" }}>
                            <cf-vstack style={{ gap: "4px", flex: 2 }}>
                              <label style={labelStyle}>School</label>
                              <cf-input
                                $value={child.school.name}
                                placeholder="School name"
                              />
                            </cf-vstack>
                            <cf-vstack style={{ gap: "4px", flex: 1 }}>
                              <label style={labelStyle}>Grade</label>
                              <cf-input
                                $value={child.school.gradeLevel}
                                placeholder="Grade"
                              />
                            </cf-vstack>
                          </cf-hstack>
                          <cf-vstack style={{ gap: "4px" }}>
                            <label style={labelStyle}>Notes</label>
                            <cf-textarea
                              $value={child.notes}
                              placeholder="Notes..."
                              rows={2}
                            />
                          </cf-vstack>
                        </cf-vstack>
                      </cf-card>
                    ))}
                    <button
                      type="button"
                      style={bigAddButtonStyle}
                      onClick={addChild}
                    >
                      + Add Child
                    </button>
                  </cf-vstack>
                </div>
              </cf-vstack>

              {/* === PARENTS === */}
              <cf-vstack style={{ gap: "8px" }}>
                <button
                  type="button"
                  style={sectionHeaderStyle}
                  onClick={() => parentsExpanded.set(!parentsExpanded.get())}
                >
                  <span style={{ fontSize: "18px" }}>👨‍👩‍👧</span>
                  <span style={{ flex: 1, textAlign: "left" }}>Parents</span>
                  <span
                    style={{
                      fontSize: "12px",
                      color: "var(--cf-color-text-secondary)",
                      background: "var(--cf-color-bg)",
                      padding: "2px 8px",
                      borderRadius: "12px",
                    }}
                  >
                    {computed(() => parents.get().length)}
                  </span>
                  <span style={{ color: "var(--cf-color-text-secondary)" }}>
                    {computed(() => parentsExpanded.get() ? "▼" : "▶")}
                  </span>
                </button>
                <div
                  style={{
                    display: computed(() =>
                      parentsExpanded.get() ? "block" : "none"
                    ),
                    ...sectionContentStyle,
                  }}
                >
                  <cf-vstack style={{ gap: "12px" }}>
                    {parents.map((person) => (
                      <cf-card>
                        <cf-vstack style={{ gap: "12px" }}>
                          <cf-hstack
                            style={{ gap: "8px", alignItems: "flex-end" }}
                          >
                            <cf-vstack style={{ gap: "4px", flex: 1 }}>
                              <label style={labelStyle}>Name</label>
                              <cf-input
                                $value={person.name}
                                placeholder="Name"
                              />
                            </cf-vstack>
                            <cf-vstack style={{ gap: "4px", width: "120px" }}>
                              <label style={labelStyle}>Relationship</label>
                              <cf-select
                                $value={person.relationship}
                                items={RELATIONSHIP_OPTIONS}
                              />
                            </cf-vstack>
                            <button
                              type="button"
                              style={removeButtonStyle}
                              onClick={() => parents.remove(person)}
                            >
                              ✕
                            </button>
                          </cf-hstack>
                          <cf-vstack style={{ gap: "4px" }}>
                            <label style={labelStyle}>Notes</label>
                            <cf-textarea
                              $value={person.notes}
                              placeholder="Notes..."
                              rows={2}
                            />
                          </cf-vstack>
                        </cf-vstack>
                      </cf-card>
                    ))}
                    <button
                      type="button"
                      style={bigAddButtonStyle}
                      onClick={addParent}
                    >
                      + Add Parent
                    </button>
                  </cf-vstack>
                </div>
              </cf-vstack>

              {/* === IN-LAWS === */}
              <cf-vstack style={{ gap: "8px" }}>
                <button
                  type="button"
                  style={sectionHeaderStyle}
                  onClick={() => inlawsExpanded.set(!inlawsExpanded.get())}
                >
                  <span style={{ fontSize: "18px" }}>👪</span>
                  <span style={{ flex: 1, textAlign: "left" }}>In-Laws</span>
                  <span
                    style={{
                      fontSize: "12px",
                      color: "var(--cf-color-text-secondary)",
                      background: "var(--cf-color-bg)",
                      padding: "2px 8px",
                      borderRadius: "12px",
                    }}
                  >
                    {computed(() => inlaws.get().length)}
                  </span>
                  <span style={{ color: "var(--cf-color-text-secondary)" }}>
                    {computed(() => inlawsExpanded.get() ? "▼" : "▶")}
                  </span>
                </button>
                <div
                  style={{
                    display: computed(() =>
                      inlawsExpanded.get() ? "block" : "none"
                    ),
                    ...sectionContentStyle,
                  }}
                >
                  <cf-vstack style={{ gap: "12px" }}>
                    {inlaws.map((person) => (
                      <cf-card>
                        <cf-vstack style={{ gap: "12px" }}>
                          <cf-hstack
                            style={{ gap: "8px", alignItems: "flex-end" }}
                          >
                            <cf-vstack style={{ gap: "4px", flex: 1 }}>
                              <label style={labelStyle}>Name</label>
                              <cf-input
                                $value={person.name}
                                placeholder="Name"
                              />
                            </cf-vstack>
                            <cf-vstack style={{ gap: "4px", width: "120px" }}>
                              <label style={labelStyle}>Relationship</label>
                              <cf-select
                                $value={person.relationship}
                                items={RELATIONSHIP_OPTIONS}
                              />
                            </cf-vstack>
                            <button
                              type="button"
                              style={removeButtonStyle}
                              onClick={() => inlaws.remove(person)}
                            >
                              ✕
                            </button>
                          </cf-hstack>
                          <cf-vstack style={{ gap: "4px" }}>
                            <label style={labelStyle}>Notes</label>
                            <cf-textarea
                              $value={person.notes}
                              placeholder="Notes..."
                              rows={2}
                            />
                          </cf-vstack>
                        </cf-vstack>
                      </cf-card>
                    ))}
                    <button
                      type="button"
                      style={bigAddButtonStyle}
                      onClick={addInlaw}
                    >
                      + Add In-Law
                    </button>
                  </cf-vstack>
                </div>
              </cf-vstack>

              {/* === ADDRESSES === */}
              <cf-vstack style={{ gap: "8px" }}>
                <button
                  type="button"
                  style={sectionHeaderStyle}
                  onClick={() =>
                    addressesExpanded.set(!addressesExpanded.get())}
                >
                  <span style={{ fontSize: "18px" }}>📍</span>
                  <span style={{ flex: 1, textAlign: "left" }}>Addresses</span>
                  <span
                    style={{
                      fontSize: "12px",
                      color: "var(--cf-color-text-secondary)",
                      background: "var(--cf-color-bg)",
                      padding: "2px 8px",
                      borderRadius: "12px",
                    }}
                  >
                    {computed(() => addresses.get().length)}
                  </span>
                  <span style={{ color: "var(--cf-color-text-secondary)" }}>
                    {computed(() => addressesExpanded.get() ? "▼" : "▶")}
                  </span>
                </button>
                <div
                  style={{
                    display: computed(() =>
                      addressesExpanded.get() ? "block" : "none"
                    ),
                    ...sectionContentStyle,
                  }}
                >
                  <cf-vstack style={{ gap: "12px" }}>
                    {addresses.map((addr) => (
                      <cf-card>
                        <cf-vstack style={{ gap: "8px" }}>
                          <cf-hstack
                            style={{ gap: "8px", alignItems: "flex-end" }}
                          >
                            <cf-vstack style={{ gap: "4px", width: "100px" }}>
                              <label style={labelStyle}>Label</label>
                              <cf-select
                                $value={addr.label}
                                items={ADDRESS_LABELS}
                              />
                            </cf-vstack>
                            <cf-vstack style={{ gap: "4px", flex: 1 }}>
                              <label style={labelStyle}>Street</label>
                              <cf-input
                                $value={addr.street}
                                placeholder="123 Main St"
                              />
                            </cf-vstack>
                            <button
                              type="button"
                              style={removeButtonStyle}
                              onClick={() => addresses.remove(addr)}
                            >
                              ✕
                            </button>
                          </cf-hstack>
                          <cf-hstack style={{ gap: "8px" }}>
                            <cf-vstack style={{ gap: "4px", flex: 2 }}>
                              <label style={labelStyle}>City</label>
                              <cf-input $value={addr.city} placeholder="City" />
                            </cf-vstack>
                            <cf-vstack style={{ gap: "4px", flex: 1 }}>
                              <label style={labelStyle}>State</label>
                              <cf-input $value={addr.state} placeholder="CA" />
                            </cf-vstack>
                            <cf-vstack style={{ gap: "4px", flex: 1 }}>
                              <label style={labelStyle}>ZIP</label>
                              <cf-input $value={addr.zip} placeholder="12345" />
                            </cf-vstack>
                          </cf-hstack>
                        </cf-vstack>
                      </cf-card>
                    ))}
                    <button
                      type="button"
                      style={bigAddButtonStyle}
                      onClick={addAddress}
                    >
                      + Add Address
                    </button>
                  </cf-vstack>
                </div>
              </cf-vstack>

              {/* === VEHICLES === */}
              <cf-vstack style={{ gap: "8px" }}>
                <button
                  type="button"
                  style={sectionHeaderStyle}
                  onClick={() => vehiclesExpanded.set(!vehiclesExpanded.get())}
                >
                  <span style={{ fontSize: "18px" }}>🚗</span>
                  <span style={{ flex: 1, textAlign: "left" }}>Vehicles</span>
                  <span
                    style={{
                      fontSize: "12px",
                      color: "var(--cf-color-text-secondary)",
                      background: "var(--cf-color-bg)",
                      padding: "2px 8px",
                      borderRadius: "12px",
                    }}
                  >
                    {computed(() => vehicles.get().length)}
                  </span>
                  <span style={{ color: "var(--cf-color-text-secondary)" }}>
                    {computed(() => vehiclesExpanded.get() ? "▼" : "▶")}
                  </span>
                </button>
                <div
                  style={{
                    display: computed(() =>
                      vehiclesExpanded.get() ? "block" : "none"
                    ),
                    ...sectionContentStyle,
                  }}
                >
                  <cf-vstack style={{ gap: "12px" }}>
                    {vehicles.map((v) => (
                      <cf-card>
                        <cf-vstack style={{ gap: "8px" }}>
                          <cf-hstack
                            style={{ gap: "8px", alignItems: "flex-end" }}
                          >
                            <cf-vstack style={{ gap: "4px", width: "80px" }}>
                              <label style={labelStyle}>Year</label>
                              <cf-input $value={v.year} placeholder="2024" />
                            </cf-vstack>
                            <cf-vstack style={{ gap: "4px", flex: 1 }}>
                              <label style={labelStyle}>Make</label>
                              <cf-input $value={v.make} placeholder="Toyota" />
                            </cf-vstack>
                            <cf-vstack style={{ gap: "4px", flex: 1 }}>
                              <label style={labelStyle}>Model</label>
                              <cf-input $value={v.model} placeholder="Camry" />
                            </cf-vstack>
                            <button
                              type="button"
                              style={removeButtonStyle}
                              onClick={() => vehicles.remove(v)}
                            >
                              ✕
                            </button>
                          </cf-hstack>
                          <cf-hstack style={{ gap: "8px" }}>
                            <cf-vstack style={{ gap: "4px", flex: 1 }}>
                              <label style={labelStyle}>License Plate</label>
                              <cf-input
                                $value={v.licensePlate}
                                placeholder="ABC 1234"
                              />
                            </cf-vstack>
                            <cf-vstack style={{ gap: "4px", flex: 1 }}>
                              <label style={labelStyle}>VIN</label>
                              <cf-input $value={v.vin} placeholder="VIN" />
                            </cf-vstack>
                          </cf-hstack>
                          <cf-vstack style={{ gap: "4px" }}>
                            <label style={labelStyle}>Notes</label>
                            <cf-textarea
                              $value={v.notes}
                              placeholder="Notes..."
                              rows={2}
                            />
                          </cf-vstack>
                        </cf-vstack>
                      </cf-card>
                    ))}
                    <button
                      type="button"
                      style={bigAddButtonStyle}
                      onClick={addVehicle}
                    >
                      + Add Vehicle
                    </button>
                  </cf-vstack>
                </div>
              </cf-vstack>

              {/* === MEMBERSHIPS === */}
              <cf-vstack style={{ gap: "8px" }}>
                <button
                  type="button"
                  style={sectionHeaderStyle}
                  onClick={() =>
                    membershipsExpanded.set(!membershipsExpanded.get())}
                >
                  <span style={{ fontSize: "18px" }}>🎫</span>
                  <span style={{ flex: 1, textAlign: "left" }}>
                    Memberships & Loyalty Programs
                  </span>
                  <span
                    style={{
                      fontSize: "12px",
                      color: "var(--cf-color-text-secondary)",
                      background: "var(--cf-color-bg)",
                      padding: "2px 8px",
                      borderRadius: "12px",
                    }}
                  >
                    {computed(() => memberships.get().length)}
                  </span>
                  <span style={{ color: "var(--cf-color-text-secondary)" }}>
                    {computed(() => membershipsExpanded.get() ? "▼" : "▶")}
                  </span>
                </button>
                <div
                  style={{
                    display: computed(() =>
                      membershipsExpanded.get() ? "block" : "none"
                    ),
                    ...sectionContentStyle,
                  }}
                >
                  <cf-vstack style={{ gap: "12px" }}>
                    {memberships.map((m) => (
                      <cf-card>
                        <cf-vstack style={{ gap: "8px" }}>
                          <cf-hstack
                            style={{ gap: "8px", alignItems: "flex-end" }}
                          >
                            <cf-vstack style={{ gap: "4px", flex: 2 }}>
                              <label style={labelStyle}>Program</label>
                              <cf-input
                                $value={m.program}
                                placeholder="United MileagePlus"
                              />
                            </cf-vstack>
                            <cf-vstack style={{ gap: "4px", flex: 1 }}>
                              <label style={labelStyle}>Member #</label>
                              <cf-input
                                $value={m.memberNumber}
                                placeholder="12345678"
                              />
                            </cf-vstack>
                            <button
                              type="button"
                              style={removeButtonStyle}
                              onClick={() => memberships.remove(m)}
                            >
                              ✕
                            </button>
                          </cf-hstack>
                          <cf-vstack style={{ gap: "4px" }}>
                            <label style={labelStyle}>Notes</label>
                            <cf-textarea
                              $value={m.notes}
                              placeholder="Notes..."
                              rows={2}
                            />
                          </cf-vstack>
                        </cf-vstack>
                      </cf-card>
                    ))}
                    <button
                      type="button"
                      style={bigAddButtonStyle}
                      onClick={addMembership}
                    >
                      + Add Membership
                    </button>
                  </cf-vstack>
                </div>
              </cf-vstack>

              {/* === BANKS === */}
              <cf-vstack style={{ gap: "8px" }}>
                <button
                  type="button"
                  style={sectionHeaderStyle}
                  onClick={() => banksExpanded.set(!banksExpanded.get())}
                >
                  <span style={{ fontSize: "18px" }}>🏦</span>
                  <span style={{ flex: 1, textAlign: "left" }}>
                    Banks & Financial
                  </span>
                  <span
                    style={{
                      fontSize: "12px",
                      color: "var(--cf-color-text-secondary)",
                      background: "var(--cf-color-bg)",
                      padding: "2px 8px",
                      borderRadius: "12px",
                    }}
                  >
                    {computed(() => banks.get().length)}
                  </span>
                  <span style={{ color: "var(--cf-color-text-secondary)" }}>
                    {computed(() => banksExpanded.get() ? "▼" : "▶")}
                  </span>
                </button>
                <div
                  style={{
                    display: computed(() =>
                      banksExpanded.get() ? "block" : "none"
                    ),
                    ...sectionContentStyle,
                  }}
                >
                  <cf-vstack style={{ gap: "12px" }}>
                    {banks.map((b) => (
                      <cf-card>
                        <cf-vstack style={{ gap: "8px" }}>
                          <cf-hstack
                            style={{ gap: "8px", alignItems: "flex-end" }}
                          >
                            <cf-vstack style={{ gap: "4px", flex: 1 }}>
                              <label style={labelStyle}>Bank Name</label>
                              <cf-input
                                $value={b.name}
                                placeholder="Chase, Wells Fargo..."
                              />
                            </cf-vstack>
                            <button
                              type="button"
                              style={removeButtonStyle}
                              onClick={() => banks.remove(b)}
                            >
                              ✕
                            </button>
                          </cf-hstack>
                          <cf-hstack style={{ gap: "16px" }}>
                            <cf-checkbox $checked={b.hasCheckingAccount}>
                              Checking Account
                            </cf-checkbox>
                            <cf-checkbox $checked={b.hasCreditCard}>
                              Credit Card
                            </cf-checkbox>
                          </cf-hstack>
                          <cf-vstack style={{ gap: "4px" }}>
                            <label style={labelStyle}>Notes</label>
                            <cf-textarea
                              $value={b.notes}
                              placeholder="Notes..."
                              rows={2}
                            />
                          </cf-vstack>
                        </cf-vstack>
                      </cf-card>
                    ))}
                    <button
                      type="button"
                      style={bigAddButtonStyle}
                      onClick={addBank}
                    >
                      + Add Bank
                    </button>
                  </cf-vstack>
                </div>
              </cf-vstack>

              {/* === EMPLOYMENT === */}
              <cf-vstack style={{ gap: "8px" }}>
                <button
                  type="button"
                  style={sectionHeaderStyle}
                  onClick={() =>
                    employmentExpanded.set(!employmentExpanded.get())}
                >
                  <span style={{ fontSize: "18px" }}>💼</span>
                  <span style={{ flex: 1, textAlign: "left" }}>Employment</span>
                  <span style={{ color: "var(--cf-color-text-secondary)" }}>
                    {computed(() => employmentExpanded.get() ? "▼" : "▶")}
                  </span>
                </button>
                <div
                  style={{
                    display: computed(() =>
                      employmentExpanded.get() ? "block" : "none"
                    ),
                    ...sectionContentStyle,
                  }}
                >
                  <cf-vstack style={{ gap: "12px" }}>
                    <cf-hstack style={{ gap: "8px" }}>
                      <cf-vstack style={{ gap: "4px", flex: 1 }}>
                        <label style={labelStyle}>Employer</label>
                        <cf-input
                          $value={employment.key("employer")}
                          placeholder="Company name"
                        />
                      </cf-vstack>
                      <cf-vstack style={{ gap: "4px", flex: 1 }}>
                        <label style={labelStyle}>Title</label>
                        <cf-input
                          $value={employment.key("title")}
                          placeholder="Job title"
                        />
                      </cf-vstack>
                    </cf-hstack>
                    <cf-vstack style={{ gap: "4px" }}>
                      <label style={labelStyle}>Work Address</label>
                      <cf-hstack style={{ gap: "8px" }}>
                        <cf-input
                          $value={employment.key("street")}
                          placeholder="Street"
                          style={{ flex: 2 }}
                        />
                        <cf-input
                          $value={employment.key("city")}
                          placeholder="City"
                          style={{ flex: 1 }}
                        />
                        <cf-input
                          $value={employment.key("state")}
                          placeholder="State"
                          style={{ width: "60px" }}
                        />
                      </cf-hstack>
                    </cf-vstack>
                    <cf-vstack style={{ gap: "4px" }}>
                      <label style={labelStyle}>Notes</label>
                      <cf-textarea
                        $value={employment.key("notes")}
                        placeholder="Notes..."
                        rows={2}
                      />
                    </cf-vstack>
                  </cf-vstack>
                </div>
              </cf-vstack>

              {/* === LEARNED === */}
              <cf-vstack style={{ gap: "8px" }}>
                <button
                  type="button"
                  style={sectionHeaderStyle}
                  onClick={() => learnedExpanded.set(!learnedExpanded.get())}
                >
                  <span style={{ fontSize: "18px" }}>🧠</span>
                  <span style={{ flex: 1, textAlign: "left" }}>
                    What I've Learned
                  </span>
                  <span
                    style={{
                      fontSize: "12px",
                      color: "var(--cf-color-text-secondary)",
                      background: "var(--cf-color-bg)",
                      padding: "2px 8px",
                      borderRadius: "12px",
                    }}
                  >
                    {computed(() => learned.key("facts").get().length)} facts
                  </span>
                  <span style={{ color: "var(--cf-color-text-secondary)" }}>
                    {computed(() => (learnedExpanded.get() ? "▼" : "▶"))}
                  </span>
                </button>
                <div
                  style={{
                    display: computed(() =>
                      learnedExpanded.get() ? "block" : "none"
                    ),
                    ...sectionContentStyle,
                  }}
                >
                  <cf-vstack style={{ gap: "20px" }}>
                    {/* Personas */}
                    {computed(() => learned.key("personas").get().length > 0) &&
                      (
                        <cf-vstack style={{ gap: "8px" }}>
                          <label style={labelStyle}>Personas</label>
                          <cf-hstack style={{ gap: "8px", flexWrap: "wrap" }}>
                            {learned.key("personas").map((persona) => (
                              <span
                                style={{
                                  padding: "4px 12px",
                                  background:
                                    "var(--cf-color-primary-surface, #eff6ff)",
                                  color: "var(--cf-color-primary, #3b82f6)",
                                  borderRadius: "16px",
                                  fontSize: "13px",
                                }}
                              >
                                {persona}
                              </span>
                            ))}
                          </cf-hstack>
                        </cf-vstack>
                      )}

                    {/* Facts Table */}
                    <cf-vstack style={{ gap: "8px" }}>
                      <label style={labelStyle}>Learned Facts</label>
                      {computed(() =>
                        learned.key("facts").get().length === 0
                      ) && (
                        <p
                          style={{
                            fontSize: "13px",
                            color: "var(--cf-color-text-secondary)",
                            fontStyle: "italic",
                          }}
                        >
                          No facts learned yet. Facts will appear here as you
                          use the app.
                        </p>
                      )}
                      {computed(() => learned.key("facts").get().length > 0) &&
                        (
                          <div
                            style={{
                              overflowX: "auto",
                              border:
                                "1px solid var(--cf-color-border, #e5e5e7)",
                              borderRadius: "8px",
                            }}
                          >
                            <table
                              style={{
                                width: "100%",
                                borderCollapse: "collapse",
                                fontSize: "13px",
                              }}
                            >
                              <thead>
                                <tr
                                  style={{
                                    background:
                                      "var(--cf-color-bg-secondary, #f9fafb)",
                                  }}
                                >
                                  <th
                                    style={{
                                      padding: "10px 12px",
                                      textAlign: "left",
                                      fontWeight: "600",
                                      borderBottom:
                                        "1px solid var(--cf-color-border, #e5e5e7)",
                                    }}
                                  >
                                    Fact
                                  </th>
                                  <th
                                    style={{
                                      padding: "10px 12px",
                                      textAlign: "center",
                                      fontWeight: "600",
                                      borderBottom:
                                        "1px solid var(--cf-color-border, #e5e5e7)",
                                      width: "80px",
                                    }}
                                  >
                                    Conf.
                                  </th>
                                  <th
                                    style={{
                                      padding: "10px 12px",
                                      textAlign: "left",
                                      fontWeight: "600",
                                      borderBottom:
                                        "1px solid var(--cf-color-border, #e5e5e7)",
                                      width: "140px",
                                    }}
                                  >
                                    Source
                                  </th>
                                  <th
                                    style={{
                                      padding: "10px 12px",
                                      textAlign: "left",
                                      fontWeight: "600",
                                      borderBottom:
                                        "1px solid var(--cf-color-border, #e5e5e7)",
                                      width: "100px",
                                    }}
                                  >
                                    When
                                  </th>
                                </tr>
                              </thead>
                              <tbody>
                                {learned.key("facts").map((fact) => (
                                  <tr>
                                    <td
                                      style={{
                                        padding: "10px 12px",
                                        borderBottom:
                                          "1px solid var(--cf-color-border, #e5e5e7)",
                                      }}
                                    >
                                      {fact.content}
                                    </td>
                                    <td
                                      style={{
                                        padding: "10px 12px",
                                        borderBottom:
                                          "1px solid var(--cf-color-border, #e5e5e7)",
                                        textAlign: "center",
                                      }}
                                    >
                                      <span
                                        style={{
                                          padding: "2px 8px",
                                          background: computed(() =>
                                            fact.confidence > 0.8
                                              ? "#dcfce7"
                                              : fact.confidence > 0.5
                                              ? "#fef9c3"
                                              : "#fee2e2"
                                          ),
                                          color: computed(() =>
                                            fact.confidence > 0.8
                                              ? "#166534"
                                              : fact.confidence > 0.5
                                              ? "#854d0e"
                                              : "#991b1b"
                                          ),
                                          borderRadius: "4px",
                                          fontSize: "12px",
                                          fontWeight: "500",
                                        }}
                                      >
                                        {computed(
                                          () =>
                                            `${
                                              Math.round(fact.confidence * 100)
                                            }%`,
                                        )}
                                      </span>
                                    </td>
                                    <td
                                      style={{
                                        padding: "10px 12px",
                                        borderBottom:
                                          "1px solid var(--cf-color-border, #e5e5e7)",
                                        color: "var(--cf-color-text-secondary)",
                                        fontSize: "12px",
                                      }}
                                    >
                                      {fact.source}
                                    </td>
                                    <td
                                      style={{
                                        padding: "10px 12px",
                                        borderBottom:
                                          "1px solid var(--cf-color-border, #e5e5e7)",
                                        color: "var(--cf-color-text-secondary)",
                                        fontSize: "12px",
                                      }}
                                    >
                                      {computed(() => {
                                        const ts = fact.timestamp;
                                        if (!ts) return "-";
                                        const d = new Date(ts);
                                        return `${
                                          d.getMonth() + 1
                                        }/${d.getDate()}`;
                                      })}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        )}
                    </cf-vstack>

                    {/* Preferences Table */}
                    {computed(() =>
                      learned.key("preferences").get().length > 0
                    ) && (
                      <cf-vstack style={{ gap: "8px" }}>
                        <label style={labelStyle}>Preferences</label>
                        <div
                          style={{
                            overflowX: "auto",
                            border: "1px solid var(--cf-color-border, #e5e5e7)",
                            borderRadius: "8px",
                          }}
                        >
                          <table
                            style={{
                              width: "100%",
                              borderCollapse: "collapse",
                              fontSize: "13px",
                            }}
                          >
                            <thead>
                              <tr
                                style={{
                                  background:
                                    "var(--cf-color-bg-secondary, #f9fafb)",
                                }}
                              >
                                <th
                                  style={{
                                    padding: "10px 12px",
                                    textAlign: "left",
                                    fontWeight: "600",
                                    borderBottom:
                                      "1px solid var(--cf-color-border, #e5e5e7)",
                                  }}
                                >
                                  Key
                                </th>
                                <th
                                  style={{
                                    padding: "10px 12px",
                                    textAlign: "left",
                                    fontWeight: "600",
                                    borderBottom:
                                      "1px solid var(--cf-color-border, #e5e5e7)",
                                  }}
                                >
                                  Value
                                </th>
                                <th
                                  style={{
                                    padding: "10px 12px",
                                    textAlign: "center",
                                    fontWeight: "600",
                                    borderBottom:
                                      "1px solid var(--cf-color-border, #e5e5e7)",
                                    width: "80px",
                                  }}
                                >
                                  Conf.
                                </th>
                              </tr>
                            </thead>
                            <tbody>
                              {learned.key("preferences").map((pref) => (
                                <tr>
                                  <td
                                    style={{
                                      padding: "10px 12px",
                                      borderBottom:
                                        "1px solid var(--cf-color-border, #e5e5e7)",
                                      fontWeight: "500",
                                    }}
                                  >
                                    {pref.key}
                                  </td>
                                  <td
                                    style={{
                                      padding: "10px 12px",
                                      borderBottom:
                                        "1px solid var(--cf-color-border, #e5e5e7)",
                                    }}
                                  >
                                    {pref.value}
                                  </td>
                                  <td
                                    style={{
                                      padding: "10px 12px",
                                      borderBottom:
                                        "1px solid var(--cf-color-border, #e5e5e7)",
                                      textAlign: "center",
                                    }}
                                  >
                                    <span
                                      style={{
                                        padding: "2px 8px",
                                        background: computed(() =>
                                          pref.confidence > 0.8
                                            ? "#dcfce7"
                                            : pref.confidence > 0.5
                                            ? "#fef9c3"
                                            : "#fee2e2"
                                        ),
                                        color: computed(() =>
                                          pref.confidence > 0.8
                                            ? "#166534"
                                            : pref.confidence > 0.5
                                            ? "#854d0e"
                                            : "#991b1b"
                                        ),
                                        borderRadius: "4px",
                                        fontSize: "12px",
                                        fontWeight: "500",
                                      }}
                                    >
                                      {computed(
                                        () =>
                                          `${
                                            Math.round(pref.confidence * 100)
                                          }%`,
                                      )}
                                    </span>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </cf-vstack>
                    )}

                    {/* Open Questions - Plain Text */}
                    {computed(() => {
                      const questions = learned.key("openQuestions").get();
                      const pending = questions.filter(
                        (q) => q.status === "pending",
                      );
                      return pending.length > 0;
                    }) && (
                      <cf-vstack style={{ gap: "8px" }}>
                        <label style={labelStyle}>
                          Pending Questions ({computed(() =>
                            learned
                              .key("openQuestions")
                              .get()
                              .filter((q) => q.status === "pending").length
                          )})
                        </label>
                        <cf-vstack
                          style={{
                            gap: "4px",
                            padding: "12px",
                            background: "var(--cf-color-bg-secondary, #f9fafb)",
                            borderRadius: "8px",
                            fontFamily: "monospace",
                            fontSize: "13px",
                          }}
                        >
                          {learned.key("openQuestions").map((q) => (
                            <div
                              style={{
                                display: computed(() =>
                                  q.status === "pending" ? "block" : "none"
                                ),
                              }}
                            >
                              <span
                                style={{
                                  color: "var(--cf-color-text-secondary)",
                                }}
                              >
                                [{q.category}]
                              </span>{" "}
                              {q.question}
                              {computed(() =>
                                q.options && q.options.length > 0
                                  ? ` (${q.options.join(" | ")})`
                                  : ""
                              )}
                            </div>
                          ))}
                        </cf-vstack>
                      </cf-vstack>
                    )}
                  </cf-vstack>
                </div>
              </cf-vstack>

              {/* === NOTES === */}
              <cf-vstack style={{ gap: "8px" }}>
                <label
                  style={{
                    fontSize: "14px",
                    fontWeight: "600",
                    color: "var(--cf-color-text, #111827)",
                  }}
                >
                  📝 General Notes
                </label>
                <cf-textarea
                  $value={notes}
                  placeholder="Any other notes or information..."
                  rows={4}
                  style={{
                    border: "1px solid var(--cf-color-border, #e5e5e7)",
                    borderRadius: "8px",
                  }}
                />
              </cf-vstack>
            </cf-vstack>
          </cf-vscroll>
        </cf-screen>
      ),

      // Pass through all data
      self,
      partner,
      children,
      parents,
      inlaws,
      addresses,
      vehicles,
      memberships,
      banks,
      employment,
      notes,
      learned,
    };
  },
);

export default Profile;
