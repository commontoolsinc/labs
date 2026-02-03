/// <cts-enable />
/**
 * Form Demo Pattern
 *
 * Demonstrates the form buffering system with both create and edit modes:
 * - Create mode: Modal form with fresh data
 * - Edit mode: Modal form with existing data
 * - Cancel discards buffered changes
 * - Submit flushes all fields atomically
 * - Validation prevents invalid submissions
 */
import {
  action,
  computed,
  Default,
  handler,
  ifElse,
  NAME,
  pattern,
  UI,
  type VNode,
  Writable,
} from "commontools";

// ===== Types =====

export interface Person {
  name: string;
  email: string;
  role: Default<"user" | "admin", "user">;
}

interface FormDemoInput {
  people?: Writable<Default<Person[], []>>;
}

interface FormDemoOutput {
  [NAME]: string;
  [UI]: VNode;
  people: Person[];
}

// ===== Module-scope handlers =====

const startEdit = handler<
  unknown,
  {
    index: number;
    people: Writable<Person[]>;
    formData: Writable<Person>;
    editingIndex: Writable<number | null>;
    showModal: Writable<boolean>;
  }
>((_event, { index, people, formData, editingIndex, showModal }) => {
  const list = people.get();
  const person = list[index];
  console.log("startEdit called:", { index, person });
  if (person) {
    const newFormData = {
      name: person.name,
      email: person.email,
      role: person.role,
    };
    console.log("setting formData to:", newFormData);
    formData.set(newFormData);
    console.log("formData after set:", formData.get());
    editingIndex.set(index);
    showModal.set(true);
  }
});

const deletePerson = handler<
  unknown,
  {
    index: number;
    people: Writable<Person[]>;
  }
>((_event, { index, people }) => {
  const current = people.get();
  if (index >= 0 && index < current.length) {
    people.set(current.toSpliced(index, 1));
  }
});

// Form submit handler - must be at module scope
// Event detail contains { values: { fieldName: value, ... } }
const handleFormSubmit = handler<
  { detail: { values: Record<string, unknown> } },
  {
    people: Writable<Person[]>;
    editingIndex: Writable<number | null>;
    showModal: Writable<boolean>;
  }
>((event, { people, editingIndex, showModal }) => {
  console.log("handleFormSubmit called");
  console.log("event.detail:", event?.detail);

  // Get values from event (passed by ct-form, survives serialization)
  const values = event?.detail?.values || {};
  console.log("values from form:", values);

  // Build person from form values
  const person: Person = {
    name: (values.name as string) || "",
    email: (values.email as string) || "",
    role: (values.role as "user" | "admin") || "user",
  };
  console.log("person to save:", person);

  const idx = editingIndex.get();

  if (idx !== null) {
    // Edit mode - update existing person
    const list = people.get();
    const updated = [...list];
    updated[idx] = person;
    people.set(updated);
  } else {
    // Create mode - add new person
    people.push(person);
  }

  // Close modal
  showModal.set(false);
  editingIndex.set(null);
});

// ===== Pattern =====

export default pattern<FormDemoInput, FormDemoOutput>(({ people }) => {
  // State for modal visibility
  const showModal = Writable.of(false);

  // State for edit vs create mode (null = create, number = edit index)
  const editingIndex = Writable.of<number | null>(null);

  // Draft cell for form data - this will be bound to form inputs
  const formData = Writable.of<Person>({
    name: "",
    email: "",
    role: "user",
  });

  // Computed values
  const peopleCount = computed(() => people.get().length);
  const isEditMode = computed(() => editingIndex.get() !== null);
  const modalTitle = ifElse(isEditMode, "Edit Person", "Add Person");

  // Cancel handler - close modal without saving
  const handleCancel = action(() => {
    showModal.set(false);
    editingIndex.set(null);
    // Form fields automatically reset via form.reset()
  });

  // Open modal in create mode
  const startCreate = action(() => {
    console.log("startCreate called");
    // Reset form data to defaults
    formData.set({
      name: "",
      email: "",
      role: "user",
    });
    editingIndex.set(null);
    showModal.set(true);
    console.log("showModal set to true");
  });

  return {
    [NAME]: computed(() => `People Directory (${people.get().length})`),
    [UI]: (
      <ct-screen>
        {/* Header */}
        <ct-vstack slot="header" gap="2">
          <ct-hstack justify="between" align="center">
            <ct-heading level={4}>People Directory</ct-heading>
            <span style="font-size: 0.875rem; color: var(--ct-color-gray-500);">
              {peopleCount}{" "}
              {computed(() => people.get().length === 1 ? "person" : "people")}
            </span>
          </ct-hstack>
        </ct-vstack>

        {/* Main content - list of people */}
        <ct-vscroll flex showScrollbar fadeEdges>
          <ct-vstack gap="2" style="padding: 1rem;">
            {people.map((person, index) => (
              <ct-card
                style="cursor: pointer;"
                onClick={startEdit({
                  index,
                  people,
                  formData,
                  editingIndex,
                  showModal,
                })}
              >
                <ct-hstack gap="2" align="center">
                  <ct-vstack gap="1" style="flex: 1;">
                    <span style="font-weight: 600; font-size: 1rem;">
                      {person.name || "(unnamed)"}
                    </span>
                    <span style="font-size: 0.875rem; color: var(--ct-color-gray-600);">
                      {person.email}
                    </span>
                    <span
                      style={{
                        fontSize: "0.75rem",
                        padding: "2px 8px",
                        borderRadius: "4px",
                        background: ifElse(
                          computed(() => person.role === "admin"),
                          "var(--ct-color-blue-100)",
                          "var(--ct-color-gray-100)",
                        ),
                        color: ifElse(
                          computed(() => person.role === "admin"),
                          "var(--ct-color-blue-700)",
                          "var(--ct-color-gray-700)",
                        ),
                        width: "fit-content",
                      }}
                    >
                      {person.role}
                    </span>
                  </ct-vstack>
                  <ct-button
                    variant="ghost"
                    onClick={deletePerson({ index, people })}
                  >
                    ×
                  </ct-button>
                </ct-hstack>
              </ct-card>
            ))}

            {ifElse(
              computed(() => people.get().length === 0),
              <div style="text-align: center; color: var(--ct-color-gray-500); padding: 2rem;">
                No people yet. Click "Add Person" to create one!
              </div>,
              null,
            )}
          </ct-vstack>
        </ct-vscroll>

        {/* Footer - Add button */}
        <ct-hstack slot="footer" gap="2" style="padding: 1rem;">
          <ct-button
            variant="primary"
            onClick={startCreate}
            style="flex: 1;"
          >
            + Add Person
          </ct-button>
        </ct-hstack>

        {/* Modal form */}
        <ct-modal $open={showModal} dismissable size="md">
          <span slot="header">{modalTitle}</span>

          <ct-form
            onct-submit={handleFormSubmit({
              people,
              editingIndex,
              showModal,
            })}
          >
            <ct-vstack gap="3">
              {/* Name field */}
              <ct-vstack gap="1">
                <label style="font-weight: 500; font-size: 0.875rem;">
                  Name *
                </label>
                <ct-input
                  name="name"
                  $value={formData.key("name")}
                  placeholder="Enter full name"
                  required
                />
              </ct-vstack>

              {/* Email field */}
              <ct-vstack gap="1">
                <label style="font-weight: 500; font-size: 0.875rem;">
                  Email *
                </label>
                <ct-input
                  name="email"
                  $value={formData.key("email")}
                  type="email"
                  placeholder="email@example.com"
                  required
                />
              </ct-vstack>

              {/* Role field */}
              <ct-vstack gap="1">
                <label style="font-weight: 500; font-size: 0.875rem;">
                  Role
                </label>
                <ct-select
                  name="role"
                  $value={formData.key("role")}
                  items={[
                    { label: "User", value: "user" },
                    { label: "Admin", value: "admin" },
                  ]}
                />
              </ct-vstack>

              {/* Form actions */}
              <ct-hstack gap="2" style="margin-top: 1rem;">
                <ct-button
                  type="button"
                  variant="secondary"
                  onClick={handleCancel}
                  style="flex: 1;"
                >
                  Cancel
                </ct-button>
                <ct-button
                  type="submit"
                  variant="primary"
                  style="flex: 1;"
                >
                  {isEditMode ? "Save" : "Create"}
                </ct-button>
              </ct-hstack>
            </ct-vstack>
          </ct-form>
        </ct-modal>
      </ct-screen>
    ),
    people,
  };
});
