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
  generateObject,
  NAME,
  pattern,
  toSchema,
  UI,
  type VNode,
  wish,
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
// JOURNAL TYPES - For watching user activity
// ============================================================================

/** Journal entry from home.tsx - used for learning */
interface JournalEntry {
  timestamp?: number;
  eventType?: string;
  snapshot?: {
    name?: string;
    schemaTag?: string;
    valueExcerpt?: string;
  };
  narrative?: string;
  tags?: string[];
  space?: string;
}

/** Result type for LLM profile extraction */
interface ProfileExtraction {
  facts: Array<{ content: string; confidence: number }>;
  preferences: Array<{ key: string; value: string; confidence: number }>;
  personas: string[];
  questions: Array<{
    question: string;
    category: string;
    priority: number;
    options?: string[];
  }>;
}

// ============================================================================
// LEARNED TYPES - Inferred from user behavior
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
}

const EMPTY_LEARNED: LearnedSection = {
  facts: [],
  preferences: [],
  openQuestions: [],
  personas: [],
  lastJournalProcessed: 0,
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

    // === JOURNAL WATCHING FOR PROFILE LEARNING ===
    // Get journal entries from home space via wish
    const journalWish = wish<JournalEntry[]>({ query: "#journal" });

    // Find new entries since last processed
    const newEntries = computed(() => {
      const entries = journalWish.result ?? [];
      const lastTs = learned.key("lastJournalProcessed").get() || 0;
      // Filter to entries with narratives (meaning LLM has processed them)
      return entries.filter(
        (e: JournalEntry) => (e.timestamp || 0) > lastTs && e.narrative,
      );
    });

    // Generate profile insights from new journal entries
    const profileExtraction = generateObject<ProfileExtraction>({
      prompt: computed(() => {
        const entries = newEntries;
        if (!entries || entries.length === 0) return "";

        const currentFacts = learned.key("facts").get();
        const currentPrefs = learned.key("preferences").get();

        return `Analyze these recent user actions and extract profile insights.

Recent actions:
${
          entries.map((e: JournalEntry) =>
            `- ${e.eventType}: ${e.narrative || e.snapshot?.name || "unknown"}`
          ).join("\n")
        }

Current known facts: ${currentFacts.map((f) => f.content).join(", ") || "none"}
Current preferences: ${
          currentPrefs.map((p) => `${p.key}=${p.value}`).join(", ") || "none"
        }

Extract:
1. facts - clear statements about the user (e.g., "interested in cooking", "has children")
2. preferences - key-value pairs about user preferences
3. personas - short descriptive labels (e.g., "busy parent", "tech enthusiast")
4. questions - clarifying questions to ask the user (if needed)

Be conservative - only extract facts you're confident about (confidence 0.5-1.0).
Avoid duplicating existing facts. Return empty arrays if nothing new to learn.`;
      }),
      system: `You extract user profile information from their activity.
Be conservative - only add facts with clear evidence.
Return valid JSON matching the schema.`,
      schema: toSchema<ProfileExtraction>(),
      model: "anthropic:claude-haiku-4-5",
    });

    // Idempotent writeback - apply extracted insights to profile
    const applyExtraction = computed(() => {
      const result = profileExtraction.result;
      const pending = profileExtraction.pending;
      const entries = newEntries;

      // Guard: only proceed when we have results and entries to process
      if (pending || !result || !entries || entries.length === 0) return null;

      // Get current state
      const currentFacts = learned.key("facts").get();
      const lastProcessed = learned.key("lastJournalProcessed").get() || 0;

      // Find the max timestamp from processed entries
      const maxTimestamp = Math.max(
        ...entries.map((e: JournalEntry) => e.timestamp || 0),
      );

      // Idempotent check: already processed these entries?
      if (maxTimestamp <= lastProcessed) return null;

      // Apply new facts (with deduplication)
      if (result.facts && result.facts.length > 0) {
        const existingContents = new Set(currentFacts.map((f) => f.content));
        const newFacts = result.facts
          .filter((f) => !existingContents.has(f.content))
          .map((f) => ({
            content: f.content,
            confidence: f.confidence,
            source: `journal:${maxTimestamp}`,
            timestamp: Date.now(),
          }));
        if (newFacts.length > 0) {
          learned.key("facts").set([...currentFacts, ...newFacts]);
        }
      }

      // Apply new preferences
      if (result.preferences && result.preferences.length > 0) {
        const currentPrefs = learned.key("preferences").get();
        const existingKeys = new Set(currentPrefs.map((p) => p.key));
        const newPrefs = result.preferences
          .filter((p) => !existingKeys.has(p.key))
          .map((p) => ({
            key: p.key,
            value: p.value,
            confidence: p.confidence,
            source: `journal:${maxTimestamp}`,
          }));
        if (newPrefs.length > 0) {
          learned.key("preferences").set([...currentPrefs, ...newPrefs]);
        }
      }

      // Apply new personas
      if (result.personas && result.personas.length > 0) {
        const currentPersonas = learned.key("personas").get();
        const existingPersonas = new Set(currentPersonas);
        const newPersonas = result.personas.filter(
          (p) => !existingPersonas.has(p),
        );
        if (newPersonas.length > 0) {
          learned.key("personas").set([...currentPersonas, ...newPersonas]);
        }
      }

      // Apply new questions
      if (result.questions && result.questions.length > 0) {
        const currentQuestions = learned.key("openQuestions").get();
        const existingQuestionTexts = new Set(
          currentQuestions.map((q) => q.question),
        );
        const newQuestions = result.questions
          .filter((q) => !existingQuestionTexts.has(q.question))
          .map((q) => ({
            id: `q-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            question: q.question,
            category: q.category,
            priority: q.priority,
            options: q.options,
            status: "pending" as const,
          }));
        if (newQuestions.length > 0) {
          learned.key("openQuestions").set([
            ...currentQuestions,
            ...newQuestions,
          ]);
        }
      }

      // Update last processed timestamp
      learned.key("lastJournalProcessed").set(maxTimestamp);

      return result;
    });

    // Reference to ensure applyExtraction is evaluated
    void applyExtraction;

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

              {/* === LEARNED === */}
              <ct-vstack style={{ gap: "8px" }}>
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
                      color: "var(--ct-color-text-secondary)",
                      background: "var(--ct-color-bg)",
                      padding: "2px 8px",
                      borderRadius: "12px",
                    }}
                  >
                    {computed(() => learned.key("facts").get().length)} facts
                  </span>
                  <span style={{ color: "var(--ct-color-text-secondary)" }}>
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
                  <ct-vstack style={{ gap: "20px" }}>
                    {/* Personas */}
                    {computed(() => learned.key("personas").get().length > 0) &&
                      (
                        <ct-vstack style={{ gap: "8px" }}>
                          <label style={labelStyle}>Personas</label>
                          <ct-hstack style={{ gap: "8px", flexWrap: "wrap" }}>
                            {learned.key("personas").map((persona) => (
                              <span
                                style={{
                                  padding: "4px 12px",
                                  background:
                                    "var(--ct-color-primary-surface, #eff6ff)",
                                  color: "var(--ct-color-primary, #3b82f6)",
                                  borderRadius: "16px",
                                  fontSize: "13px",
                                }}
                              >
                                {persona}
                              </span>
                            ))}
                          </ct-hstack>
                        </ct-vstack>
                      )}

                    {/* Facts Table */}
                    <ct-vstack style={{ gap: "8px" }}>
                      <label style={labelStyle}>Learned Facts</label>
                      {computed(() =>
                        learned.key("facts").get().length === 0
                      ) && (
                        <p
                          style={{
                            fontSize: "13px",
                            color: "var(--ct-color-text-secondary)",
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
                                "1px solid var(--ct-color-border, #e5e5e7)",
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
                                      "var(--ct-color-bg-secondary, #f9fafb)",
                                  }}
                                >
                                  <th
                                    style={{
                                      padding: "10px 12px",
                                      textAlign: "left",
                                      fontWeight: "600",
                                      borderBottom:
                                        "1px solid var(--ct-color-border, #e5e5e7)",
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
                                        "1px solid var(--ct-color-border, #e5e5e7)",
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
                                        "1px solid var(--ct-color-border, #e5e5e7)",
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
                                        "1px solid var(--ct-color-border, #e5e5e7)",
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
                                          "1px solid var(--ct-color-border, #e5e5e7)",
                                      }}
                                    >
                                      {fact.content}
                                    </td>
                                    <td
                                      style={{
                                        padding: "10px 12px",
                                        borderBottom:
                                          "1px solid var(--ct-color-border, #e5e5e7)",
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
                                          "1px solid var(--ct-color-border, #e5e5e7)",
                                        color: "var(--ct-color-text-secondary)",
                                        fontSize: "12px",
                                      }}
                                    >
                                      {fact.source}
                                    </td>
                                    <td
                                      style={{
                                        padding: "10px 12px",
                                        borderBottom:
                                          "1px solid var(--ct-color-border, #e5e5e7)",
                                        color: "var(--ct-color-text-secondary)",
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
                    </ct-vstack>

                    {/* Preferences Table */}
                    {computed(() =>
                      learned.key("preferences").get().length > 0
                    ) && (
                      <ct-vstack style={{ gap: "8px" }}>
                        <label style={labelStyle}>Preferences</label>
                        <div
                          style={{
                            overflowX: "auto",
                            border: "1px solid var(--ct-color-border, #e5e5e7)",
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
                                    "var(--ct-color-bg-secondary, #f9fafb)",
                                }}
                              >
                                <th
                                  style={{
                                    padding: "10px 12px",
                                    textAlign: "left",
                                    fontWeight: "600",
                                    borderBottom:
                                      "1px solid var(--ct-color-border, #e5e5e7)",
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
                                      "1px solid var(--ct-color-border, #e5e5e7)",
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
                                      "1px solid var(--ct-color-border, #e5e5e7)",
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
                                        "1px solid var(--ct-color-border, #e5e5e7)",
                                      fontWeight: "500",
                                    }}
                                  >
                                    {pref.key}
                                  </td>
                                  <td
                                    style={{
                                      padding: "10px 12px",
                                      borderBottom:
                                        "1px solid var(--ct-color-border, #e5e5e7)",
                                    }}
                                  >
                                    {pref.value}
                                  </td>
                                  <td
                                    style={{
                                      padding: "10px 12px",
                                      borderBottom:
                                        "1px solid var(--ct-color-border, #e5e5e7)",
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
                      </ct-vstack>
                    )}

                    {/* Open Questions - Plain Text */}
                    {computed(() => {
                      const questions = learned.key("openQuestions").get();
                      const pending = questions.filter(
                        (q) => q.status === "pending",
                      );
                      return pending.length > 0;
                    }) && (
                      <ct-vstack style={{ gap: "8px" }}>
                        <label style={labelStyle}>
                          Pending Questions ({computed(() =>
                            learned
                              .key("openQuestions")
                              .get()
                              .filter((q) => q.status === "pending").length
                          )})
                        </label>
                        <ct-vstack
                          style={{
                            gap: "4px",
                            padding: "12px",
                            background: "var(--ct-color-bg-secondary, #f9fafb)",
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
                                  color: "var(--ct-color-text-secondary)",
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
                        </ct-vstack>
                      </ct-vstack>
                    )}
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
      learned,
    };
  },
);

export default Profile;
