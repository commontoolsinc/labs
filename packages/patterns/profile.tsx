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
} from "commontools";

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
  background: "var(--ct-color-bg-secondary, #f9fafb)",
  border: "1px solid var(--ct-color-border, #e5e5e7)",
  borderRadius: "8px",
  cursor: "pointer",
  fontSize: "15px",
  fontWeight: "600",
};

const sectionContentStyle = {
  padding: "12px",
  background: "var(--ct-color-bg, white)",
  border: "1px solid var(--ct-color-border, #e5e5e7)",
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
  background: "var(--ct-color-bg-secondary, #f3f4f6)",
  border: "1px dashed var(--ct-color-border, #e5e5e7)",
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

    return {
      [NAME]: computed(() => `👤 ${displayName}`),
      [UI]: (
        <ct-screen>
          <ct-vstack
            slot="header"
            gap="2"
            padding="4"
            style={{
              borderBottom: "1px solid var(--ct-color-border, #e5e5e7)",
            }}
          >
            <h2 style={{ margin: 0, fontSize: "18px", fontWeight: "600" }}>
              {displayName}
            </h2>
            <span
              style={{
                fontSize: "13px",
                color: "var(--ct-color-text-secondary, #6b7280)",
              }}
            >
              Personal data blackboard - tag with #profile for discovery
            </span>
          </ct-vstack>

          <ct-vscroll style={{ flex: 1, padding: "16px" }}>
            <ct-vstack
              style={{ gap: "16px", maxWidth: "800px", margin: "0 auto" }}
            >
              {/* === SELF === */}
              <ct-vstack style={{ gap: "8px" }}>
                <button
                  type="button"
                  style={sectionHeaderStyle}
                  onClick={() => selfExpanded.set(!selfExpanded.get())}
                >
                  <span style={{ fontSize: "18px" }}>👤</span>
                  <span style={{ flex: 1, textAlign: "left" }}>About Me</span>
                  <span style={{ color: "var(--ct-color-text-secondary)" }}>
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
                  <ct-vstack style={{ gap: "12px" }}>
                    <ct-hstack style={{ gap: "8px" }}>
                      <ct-vstack style={{ gap: "4px", flex: 1 }}>
                        <label style={labelStyle}>Your Name</label>
                        <ct-input
                          $value={self.key("name")}
                          placeholder="Your full name"
                        />
                      </ct-vstack>
                      <ct-vstack style={{ gap: "4px", width: "150px" }}>
                        <label style={labelStyle}>Nickname</label>
                        <ct-input
                          $value={self.key("nickname")}
                          placeholder="Nickname"
                        />
                      </ct-vstack>
                    </ct-hstack>
                    <ct-vstack style={{ gap: "4px" }}>
                      <label style={labelStyle}>Birthday</label>
                      <ct-hstack style={{ gap: "8px" }}>
                        <ct-input
                          $value={self.key("birthday", "month")}
                          placeholder="Month"
                          style={{ width: "80px" }}
                        />
                        <ct-input
                          $value={self.key("birthday", "day")}
                          placeholder="Day"
                          style={{ width: "60px" }}
                        />
                        <ct-input
                          $value={self.key("birthday", "year")}
                          placeholder="Year"
                          style={{ width: "80px" }}
                        />
                      </ct-hstack>
                    </ct-vstack>
                    <ct-vstack style={{ gap: "4px" }}>
                      <label style={labelStyle}>Notes</label>
                      <ct-textarea
                        $value={self.key("notes")}
                        placeholder="Notes..."
                        rows={2}
                      />
                    </ct-vstack>
                  </ct-vstack>
                </div>
              </ct-vstack>

              {/* === PARTNER === */}
              <ct-vstack style={{ gap: "8px" }}>
                <button
                  type="button"
                  style={sectionHeaderStyle}
                  onClick={() => partnerExpanded.set(!partnerExpanded.get())}
                >
                  <span style={{ fontSize: "18px" }}>💑</span>
                  <span style={{ flex: 1, textAlign: "left" }}>Partner</span>
                  <span style={{ color: "var(--ct-color-text-secondary)" }}>
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
                  <ct-vstack style={{ gap: "12px" }}>
                    <ct-hstack style={{ gap: "8px" }}>
                      <ct-vstack style={{ gap: "4px", flex: 1 }}>
                        <label style={labelStyle}>Name</label>
                        <ct-input
                          $value={partner.key("name")}
                          placeholder="Partner's name"
                        />
                      </ct-vstack>
                      <ct-vstack style={{ gap: "4px", width: "120px" }}>
                        <label style={labelStyle}>Relationship</label>
                        <ct-select
                          $value={partner.key("relationship")}
                          items={RELATIONSHIP_OPTIONS}
                        />
                      </ct-vstack>
                    </ct-hstack>
                    <ct-vstack style={{ gap: "4px" }}>
                      <label style={labelStyle}>Notes</label>
                      <ct-textarea
                        $value={partner.key("notes")}
                        placeholder="Notes..."
                        rows={2}
                      />
                    </ct-vstack>
                  </ct-vstack>
                </div>
              </ct-vstack>

              {/* === CHILDREN === */}
              <ct-vstack style={{ gap: "8px" }}>
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
                      color: "var(--ct-color-text-secondary)",
                      background: "var(--ct-color-bg)",
                      padding: "2px 8px",
                      borderRadius: "12px",
                    }}
                  >
                    {computed(() => children.get().length)}
                  </span>
                  <span style={{ color: "var(--ct-color-text-secondary)" }}>
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
                  <ct-vstack style={{ gap: "12px" }}>
                    {children.map((child) => (
                      <ct-card>
                        <ct-vstack style={{ gap: "12px" }}>
                          <ct-hstack
                            style={{ gap: "8px", alignItems: "flex-end" }}
                          >
                            <ct-vstack style={{ gap: "4px", flex: 1 }}>
                              <label style={labelStyle}>Name</label>
                              <ct-input
                                $value={child.name}
                                placeholder="Child's name"
                              />
                            </ct-vstack>
                            <ct-vstack style={{ gap: "4px", width: "120px" }}>
                              <label style={labelStyle}>Nickname</label>
                              <ct-input
                                $value={child.nickname}
                                placeholder="Nickname"
                              />
                            </ct-vstack>
                            <button
                              type="button"
                              style={removeButtonStyle}
                              onClick={() => children.remove(child)}
                            >
                              ✕
                            </button>
                          </ct-hstack>
                          <ct-hstack style={{ gap: "8px" }}>
                            <ct-vstack style={{ gap: "4px", flex: 2 }}>
                              <label style={labelStyle}>School</label>
                              <ct-input
                                $value={child.school.name}
                                placeholder="School name"
                              />
                            </ct-vstack>
                            <ct-vstack style={{ gap: "4px", flex: 1 }}>
                              <label style={labelStyle}>Grade</label>
                              <ct-input
                                $value={child.school.gradeLevel}
                                placeholder="Grade"
                              />
                            </ct-vstack>
                          </ct-hstack>
                          <ct-vstack style={{ gap: "4px" }}>
                            <label style={labelStyle}>Notes</label>
                            <ct-textarea
                              $value={child.notes}
                              placeholder="Notes..."
                              rows={2}
                            />
                          </ct-vstack>
                        </ct-vstack>
                      </ct-card>
                    ))}
                    <button
                      type="button"
                      style={bigAddButtonStyle}
                      onClick={addChild}
                    >
                      + Add Child
                    </button>
                  </ct-vstack>
                </div>
              </ct-vstack>

              {/* === PARENTS === */}
              <ct-vstack style={{ gap: "8px" }}>
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
                      color: "var(--ct-color-text-secondary)",
                      background: "var(--ct-color-bg)",
                      padding: "2px 8px",
                      borderRadius: "12px",
                    }}
                  >
                    {computed(() => parents.get().length)}
                  </span>
                  <span style={{ color: "var(--ct-color-text-secondary)" }}>
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
                  <ct-vstack style={{ gap: "12px" }}>
                    {parents.map((person) => (
                      <ct-card>
                        <ct-vstack style={{ gap: "12px" }}>
                          <ct-hstack
                            style={{ gap: "8px", alignItems: "flex-end" }}
                          >
                            <ct-vstack style={{ gap: "4px", flex: 1 }}>
                              <label style={labelStyle}>Name</label>
                              <ct-input
                                $value={person.name}
                                placeholder="Name"
                              />
                            </ct-vstack>
                            <ct-vstack style={{ gap: "4px", width: "120px" }}>
                              <label style={labelStyle}>Relationship</label>
                              <ct-select
                                $value={person.relationship}
                                items={RELATIONSHIP_OPTIONS}
                              />
                            </ct-vstack>
                            <button
                              type="button"
                              style={removeButtonStyle}
                              onClick={() => parents.remove(person)}
                            >
                              ✕
                            </button>
                          </ct-hstack>
                          <ct-vstack style={{ gap: "4px" }}>
                            <label style={labelStyle}>Notes</label>
                            <ct-textarea
                              $value={person.notes}
                              placeholder="Notes..."
                              rows={2}
                            />
                          </ct-vstack>
                        </ct-vstack>
                      </ct-card>
                    ))}
                    <button
                      type="button"
                      style={bigAddButtonStyle}
                      onClick={addParent}
                    >
                      + Add Parent
                    </button>
                  </ct-vstack>
                </div>
              </ct-vstack>

              {/* === IN-LAWS === */}
              <ct-vstack style={{ gap: "8px" }}>
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
                      color: "var(--ct-color-text-secondary)",
                      background: "var(--ct-color-bg)",
                      padding: "2px 8px",
                      borderRadius: "12px",
                    }}
                  >
                    {computed(() => inlaws.get().length)}
                  </span>
                  <span style={{ color: "var(--ct-color-text-secondary)" }}>
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
                  <ct-vstack style={{ gap: "12px" }}>
                    {inlaws.map((person) => (
                      <ct-card>
                        <ct-vstack style={{ gap: "12px" }}>
                          <ct-hstack
                            style={{ gap: "8px", alignItems: "flex-end" }}
                          >
                            <ct-vstack style={{ gap: "4px", flex: 1 }}>
                              <label style={labelStyle}>Name</label>
                              <ct-input
                                $value={person.name}
                                placeholder="Name"
                              />
                            </ct-vstack>
                            <ct-vstack style={{ gap: "4px", width: "120px" }}>
                              <label style={labelStyle}>Relationship</label>
                              <ct-select
                                $value={person.relationship}
                                items={RELATIONSHIP_OPTIONS}
                              />
                            </ct-vstack>
                            <button
                              type="button"
                              style={removeButtonStyle}
                              onClick={() => inlaws.remove(person)}
                            >
                              ✕
                            </button>
                          </ct-hstack>
                          <ct-vstack style={{ gap: "4px" }}>
                            <label style={labelStyle}>Notes</label>
                            <ct-textarea
                              $value={person.notes}
                              placeholder="Notes..."
                              rows={2}
                            />
                          </ct-vstack>
                        </ct-vstack>
                      </ct-card>
                    ))}
                    <button
                      type="button"
                      style={bigAddButtonStyle}
                      onClick={addInlaw}
                    >
                      + Add In-Law
                    </button>
                  </ct-vstack>
                </div>
              </ct-vstack>

              {/* === ADDRESSES === */}
              <ct-vstack style={{ gap: "8px" }}>
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
                      color: "var(--ct-color-text-secondary)",
                      background: "var(--ct-color-bg)",
                      padding: "2px 8px",
                      borderRadius: "12px",
                    }}
                  >
                    {computed(() => addresses.get().length)}
                  </span>
                  <span style={{ color: "var(--ct-color-text-secondary)" }}>
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
                  <ct-vstack style={{ gap: "12px" }}>
                    {addresses.map((addr) => (
                      <ct-card>
                        <ct-vstack style={{ gap: "8px" }}>
                          <ct-hstack
                            style={{ gap: "8px", alignItems: "flex-end" }}
                          >
                            <ct-vstack style={{ gap: "4px", width: "100px" }}>
                              <label style={labelStyle}>Label</label>
                              <ct-select
                                $value={addr.label}
                                items={ADDRESS_LABELS}
                              />
                            </ct-vstack>
                            <ct-vstack style={{ gap: "4px", flex: 1 }}>
                              <label style={labelStyle}>Street</label>
                              <ct-input
                                $value={addr.street}
                                placeholder="123 Main St"
                              />
                            </ct-vstack>
                            <button
                              type="button"
                              style={removeButtonStyle}
                              onClick={() => addresses.remove(addr)}
                            >
                              ✕
                            </button>
                          </ct-hstack>
                          <ct-hstack style={{ gap: "8px" }}>
                            <ct-vstack style={{ gap: "4px", flex: 2 }}>
                              <label style={labelStyle}>City</label>
                              <ct-input $value={addr.city} placeholder="City" />
                            </ct-vstack>
                            <ct-vstack style={{ gap: "4px", flex: 1 }}>
                              <label style={labelStyle}>State</label>
                              <ct-input $value={addr.state} placeholder="CA" />
                            </ct-vstack>
                            <ct-vstack style={{ gap: "4px", flex: 1 }}>
                              <label style={labelStyle}>ZIP</label>
                              <ct-input $value={addr.zip} placeholder="12345" />
                            </ct-vstack>
                          </ct-hstack>
                        </ct-vstack>
                      </ct-card>
                    ))}
                    <button
                      type="button"
                      style={bigAddButtonStyle}
                      onClick={addAddress}
                    >
                      + Add Address
                    </button>
                  </ct-vstack>
                </div>
              </ct-vstack>

              {/* === VEHICLES === */}
              <ct-vstack style={{ gap: "8px" }}>
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
                      color: "var(--ct-color-text-secondary)",
                      background: "var(--ct-color-bg)",
                      padding: "2px 8px",
                      borderRadius: "12px",
                    }}
                  >
                    {computed(() => vehicles.get().length)}
                  </span>
                  <span style={{ color: "var(--ct-color-text-secondary)" }}>
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
                  <ct-vstack style={{ gap: "12px" }}>
                    {vehicles.map((v) => (
                      <ct-card>
                        <ct-vstack style={{ gap: "8px" }}>
                          <ct-hstack
                            style={{ gap: "8px", alignItems: "flex-end" }}
                          >
                            <ct-vstack style={{ gap: "4px", width: "80px" }}>
                              <label style={labelStyle}>Year</label>
                              <ct-input $value={v.year} placeholder="2024" />
                            </ct-vstack>
                            <ct-vstack style={{ gap: "4px", flex: 1 }}>
                              <label style={labelStyle}>Make</label>
                              <ct-input $value={v.make} placeholder="Toyota" />
                            </ct-vstack>
                            <ct-vstack style={{ gap: "4px", flex: 1 }}>
                              <label style={labelStyle}>Model</label>
                              <ct-input $value={v.model} placeholder="Camry" />
                            </ct-vstack>
                            <button
                              type="button"
                              style={removeButtonStyle}
                              onClick={() => vehicles.remove(v)}
                            >
                              ✕
                            </button>
                          </ct-hstack>
                          <ct-hstack style={{ gap: "8px" }}>
                            <ct-vstack style={{ gap: "4px", flex: 1 }}>
                              <label style={labelStyle}>License Plate</label>
                              <ct-input
                                $value={v.licensePlate}
                                placeholder="ABC 1234"
                              />
                            </ct-vstack>
                            <ct-vstack style={{ gap: "4px", flex: 1 }}>
                              <label style={labelStyle}>VIN</label>
                              <ct-input $value={v.vin} placeholder="VIN" />
                            </ct-vstack>
                          </ct-hstack>
                          <ct-vstack style={{ gap: "4px" }}>
                            <label style={labelStyle}>Notes</label>
                            <ct-textarea
                              $value={v.notes}
                              placeholder="Notes..."
                              rows={2}
                            />
                          </ct-vstack>
                        </ct-vstack>
                      </ct-card>
                    ))}
                    <button
                      type="button"
                      style={bigAddButtonStyle}
                      onClick={addVehicle}
                    >
                      + Add Vehicle
                    </button>
                  </ct-vstack>
                </div>
              </ct-vstack>

              {/* === MEMBERSHIPS === */}
              <ct-vstack style={{ gap: "8px" }}>
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
                      color: "var(--ct-color-text-secondary)",
                      background: "var(--ct-color-bg)",
                      padding: "2px 8px",
                      borderRadius: "12px",
                    }}
                  >
                    {computed(() => memberships.get().length)}
                  </span>
                  <span style={{ color: "var(--ct-color-text-secondary)" }}>
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
                  <ct-vstack style={{ gap: "12px" }}>
                    {memberships.map((m) => (
                      <ct-card>
                        <ct-vstack style={{ gap: "8px" }}>
                          <ct-hstack
                            style={{ gap: "8px", alignItems: "flex-end" }}
                          >
                            <ct-vstack style={{ gap: "4px", flex: 2 }}>
                              <label style={labelStyle}>Program</label>
                              <ct-input
                                $value={m.program}
                                placeholder="United MileagePlus"
                              />
                            </ct-vstack>
                            <ct-vstack style={{ gap: "4px", flex: 1 }}>
                              <label style={labelStyle}>Member #</label>
                              <ct-input
                                $value={m.memberNumber}
                                placeholder="12345678"
                              />
                            </ct-vstack>
                            <button
                              type="button"
                              style={removeButtonStyle}
                              onClick={() => memberships.remove(m)}
                            >
                              ✕
                            </button>
                          </ct-hstack>
                          <ct-vstack style={{ gap: "4px" }}>
                            <label style={labelStyle}>Notes</label>
                            <ct-textarea
                              $value={m.notes}
                              placeholder="Notes..."
                              rows={2}
                            />
                          </ct-vstack>
                        </ct-vstack>
                      </ct-card>
                    ))}
                    <button
                      type="button"
                      style={bigAddButtonStyle}
                      onClick={addMembership}
                    >
                      + Add Membership
                    </button>
                  </ct-vstack>
                </div>
              </ct-vstack>

              {/* === BANKS === */}
              <ct-vstack style={{ gap: "8px" }}>
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
                      color: "var(--ct-color-text-secondary)",
                      background: "var(--ct-color-bg)",
                      padding: "2px 8px",
                      borderRadius: "12px",
                    }}
                  >
                    {computed(() => banks.get().length)}
                  </span>
                  <span style={{ color: "var(--ct-color-text-secondary)" }}>
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
                  <ct-vstack style={{ gap: "12px" }}>
                    {banks.map((b) => (
                      <ct-card>
                        <ct-vstack style={{ gap: "8px" }}>
                          <ct-hstack
                            style={{ gap: "8px", alignItems: "flex-end" }}
                          >
                            <ct-vstack style={{ gap: "4px", flex: 1 }}>
                              <label style={labelStyle}>Bank Name</label>
                              <ct-input
                                $value={b.name}
                                placeholder="Chase, Wells Fargo..."
                              />
                            </ct-vstack>
                            <button
                              type="button"
                              style={removeButtonStyle}
                              onClick={() => banks.remove(b)}
                            >
                              ✕
                            </button>
                          </ct-hstack>
                          <ct-hstack style={{ gap: "16px" }}>
                            <ct-checkbox $checked={b.hasCheckingAccount}>
                              Checking Account
                            </ct-checkbox>
                            <ct-checkbox $checked={b.hasCreditCard}>
                              Credit Card
                            </ct-checkbox>
                          </ct-hstack>
                          <ct-vstack style={{ gap: "4px" }}>
                            <label style={labelStyle}>Notes</label>
                            <ct-textarea
                              $value={b.notes}
                              placeholder="Notes..."
                              rows={2}
                            />
                          </ct-vstack>
                        </ct-vstack>
                      </ct-card>
                    ))}
                    <button
                      type="button"
                      style={bigAddButtonStyle}
                      onClick={addBank}
                    >
                      + Add Bank
                    </button>
                  </ct-vstack>
                </div>
              </ct-vstack>

              {/* === EMPLOYMENT === */}
              <ct-vstack style={{ gap: "8px" }}>
                <button
                  type="button"
                  style={sectionHeaderStyle}
                  onClick={() =>
                    employmentExpanded.set(!employmentExpanded.get())}
                >
                  <span style={{ fontSize: "18px" }}>💼</span>
                  <span style={{ flex: 1, textAlign: "left" }}>Employment</span>
                  <span style={{ color: "var(--ct-color-text-secondary)" }}>
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
                  <ct-vstack style={{ gap: "12px" }}>
                    <ct-hstack style={{ gap: "8px" }}>
                      <ct-vstack style={{ gap: "4px", flex: 1 }}>
                        <label style={labelStyle}>Employer</label>
                        <ct-input
                          $value={employment.key("employer")}
                          placeholder="Company name"
                        />
                      </ct-vstack>
                      <ct-vstack style={{ gap: "4px", flex: 1 }}>
                        <label style={labelStyle}>Title</label>
                        <ct-input
                          $value={employment.key("title")}
                          placeholder="Job title"
                        />
                      </ct-vstack>
                    </ct-hstack>
                    <ct-vstack style={{ gap: "4px" }}>
                      <label style={labelStyle}>Work Address</label>
                      <ct-hstack style={{ gap: "8px" }}>
                        <ct-input
                          $value={employment.key("street")}
                          placeholder="Street"
                          style={{ flex: 2 }}
                        />
                        <ct-input
                          $value={employment.key("city")}
                          placeholder="City"
                          style={{ flex: 1 }}
                        />
                        <ct-input
                          $value={employment.key("state")}
                          placeholder="State"
                          style={{ width: "60px" }}
                        />
                      </ct-hstack>
                    </ct-vstack>
                    <ct-vstack style={{ gap: "4px" }}>
                      <label style={labelStyle}>Notes</label>
                      <ct-textarea
                        $value={employment.key("notes")}
                        placeholder="Notes..."
                        rows={2}
                      />
                    </ct-vstack>
                  </ct-vstack>
                </div>
              </ct-vstack>

              {/* === NOTES === */}
              <ct-vstack style={{ gap: "8px" }}>
                <label
                  style={{
                    fontSize: "14px",
                    fontWeight: "600",
                    color: "var(--ct-color-text, #111827)",
                  }}
                >
                  📝 General Notes
                </label>
                <ct-textarea
                  $value={notes}
                  placeholder="Any other notes or information..."
                  rows={4}
                  style={{
                    border: "1px solid var(--ct-color-border, #e5e5e7)",
                    borderRadius: "8px",
                  }}
                />
              </ct-vstack>
            </ct-vstack>
          </ct-vscroll>
        </ct-screen>
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
    };
  },
);

export default Profile;
