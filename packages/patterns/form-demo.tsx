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
  equals,
  handler,
  ifElse,
  NAME,
  pattern,
  UI,
  type VNode,
  Writable,
} from "commonfabric";

// ===== Types =====

export interface Person {
  name: string;
  email: string;
  role: Default<"user" | "admin", "user">;
}

interface FormDemoInput {
  people: Writable<Default<Person[], []>>;
}

interface FormDemoOutput {
  [NAME]: string;
  [UI]: VNode;
  people: Person[];
}

const createEmptyPerson = (): Person => ({
  name: "",
  email: "",
  role: "user",
});

// Form submit handler - must be at module scope
// cf-form flushes buffered values to bound cells before emitting cf-submit,
// so handlers read from the cells directly (type-safe, no reconstruction needed)
const handleFormSubmit = handler<
  unknown,
  {
    formData: Writable<Person>;
    people: Writable<Person[]>;
    editing: Writable<{ editing: Person | null }>;
    modalOpen: Writable<boolean>;
  }
>((_, { formData, people, editing, modalOpen }) => {
  const next = { ...formData.get() };
  const target = editing.get().editing;
  if (target === null) {
    people.push(next);
  } else {
    const current = people.get();
    const index = current.findIndex((p) => equals(p, target));
    if (index >= 0) {
      const updated = [...current];
      updated[index] = next;
      people.set(updated);
    }
  }

  modalOpen.set(false);
  editing.set({ editing: null });
});

export const EditPerson = pattern<
  {
    editing: Writable<{ editing: Person | null }>;
    formData: Writable<Person>;
    people: Writable<Person[]>;
    modalOpen: Writable<boolean>;
  },
  { [UI]: VNode }
>(
  ({ editing, formData, people, modalOpen }) => {
    const isEditMode = computed(() => editing.get().editing !== null);

    // Cancel handler - close modal without saving
    const handleCancel = action(() => {
      modalOpen.set(false);
      editing.set({ editing: null });
      // Form fields automatically reset via form.reset()
    });

    return {
      [UI]: (
        <cf-form
          oncf-submit={handleFormSubmit({
            formData,
            people,
            editing,
            modalOpen,
          })}
        >
          <cf-vstack gap="3">
            {/* Name field */}
            <cf-vstack gap="1">
              <label style="font-weight: 500; font-size: 0.875rem;">
                Name *
              </label>
              <cf-input
                name="name"
                $value={formData.key("name")}
                placeholder="Enter full name"
                required
              />
            </cf-vstack>

            {/* Email field */}
            <cf-vstack gap="1">
              <label style="font-weight: 500; font-size: 0.875rem;">
                Email *
              </label>
              <cf-input
                name="email"
                $value={formData.key("email")}
                type="email"
                placeholder="email@example.com"
                required
              />
            </cf-vstack>

            {/* Role field */}
            <cf-vstack gap="1">
              <label style="font-weight: 500; font-size: 0.875rem;">
                Role
              </label>
              <cf-select
                name="role"
                $value={formData.key("role")}
                items={[
                  { label: "User", value: "user" },
                  { label: "Admin", value: "admin" },
                ]}
              />
            </cf-vstack>

            {/* Form actions */}
            <cf-hstack gap="2" style="margin-top: 1rem;">
              <cf-button
                type="reset"
                variant="secondary"
                onClick={handleCancel}
                style="flex: 1;"
              >
                Cancel
              </cf-button>
              <cf-button
                type="submit"
                variant="primary"
                style="flex: 1;"
              >
                {isEditMode ? "Save" : "Create"}
              </cf-button>
            </cf-hstack>
          </cf-vstack>
        </cf-form>
      ),
    };
  },
);

// ===== Module-scope handlers =====

const startEdit = handler<
  unknown,
  {
    person: Person;
    people: Writable<Person[]>;
    editing: Writable<{ editing: Person | null }>;
    formData: Writable<Person>;
    modalOpen: Writable<boolean>;
  }
>((_event, { person, people, editing, formData, modalOpen }) => {
  const current = people.get();
  const index = current.findIndex((p) => equals(p, person));
  if (index >= 0) {
    formData.set({ ...current[index] });
    editing.set({ editing: person });
    modalOpen.set(true);
  }
});

const deletePerson = handler<
  Event,
  {
    person: Person;
    people: Writable<Person[]>;
  }
>((event, { person, people }) => {
  // Stop propagation to prevent card's onClick (startEdit) from firing
  event?.stopPropagation?.();
  const current = people.get();
  const filteredPeople = current.filter((p) => !equals(p, person));
  people.set(filteredPeople);
});

// ===== Pattern =====

export default pattern<FormDemoInput, FormDemoOutput>(({ people }) => {
  const editing = Writable.of<{ editing: Person | null }>({ editing: null });
  const formData = Writable.of<Person>(createEmptyPerson());
  const modalOpen = Writable.of(false);

  // Computed values
  const peopleCount = computed(() => people.get().length);
  const isEditMode = computed(() => editing.get().editing !== null);
  const modalTitle = ifElse(isEditMode, "Edit Person", "Add Person");

  const showModal = computed(() => modalOpen.get());

  // Open modal in create mode
  const startCreate = action(() => {
    formData.set(createEmptyPerson());
    editing.set({ editing: null });
    modalOpen.set(true);
  });

  return {
    [NAME]: computed(() => `People Directory (${people.get().length})`),
    [UI]: (
      <cf-screen>
        {/* Header */}
        <cf-vstack slot="header" gap="2">
          <cf-hstack justify="between" align="center">
            <cf-heading level={4}>People Directory</cf-heading>
            <span style="font-size: 0.875rem; color: var(--cf-color-gray-500);">
              {peopleCount}{" "}
              {computed(() => people.get().length === 1 ? "person" : "people")}
            </span>
          </cf-hstack>
        </cf-vstack>

        {/* Main content - list of people */}
        <cf-vscroll flex showScrollbar fadeEdges>
          <cf-vstack gap="2" style="padding: 1rem;">
            {people.map((person) => (
              <cf-card
                style="cursor: pointer;"
                onClick={startEdit({
                  person,
                  people,
                  editing,
                  formData,
                  modalOpen,
                })}
              >
                <cf-hstack gap="2" align="center">
                  <cf-vstack gap="1" style="flex: 1;">
                    <span style="font-weight: 600; font-size: 1rem;">
                      {person.name || "(unnamed)"}
                    </span>
                    <span style="font-size: 0.875rem; color: var(--cf-color-gray-600);">
                      {person.email}
                    </span>
                    <span
                      style={{
                        fontSize: "0.75rem",
                        padding: "2px 8px",
                        borderRadius: "4px",
                        background: ifElse(
                          computed(() => person.role === "admin"),
                          "var(--cf-color-blue-100)",
                          "var(--cf-color-gray-100)",
                        ),
                        color: ifElse(
                          computed(() => person.role === "admin"),
                          "var(--cf-color-blue-700)",
                          "var(--cf-color-gray-700)",
                        ),
                        width: "fit-content",
                      }}
                    >
                      {person.role}
                    </span>
                  </cf-vstack>
                  <cf-button
                    variant="ghost"
                    onClick={deletePerson({ person, people })}
                  >
                    ×
                  </cf-button>
                </cf-hstack>
              </cf-card>
            ))}

            {ifElse(
              computed(() => people.get().length === 0),
              <div style="text-align: center; color: var(--cf-color-gray-500); padding: 2rem;">
                No people yet. Click "Add Person" to create one!
              </div>,
              null,
            )}
          </cf-vstack>
        </cf-vscroll>

        {/* Footer - Add button */}
        <cf-hstack slot="footer" gap="2" style="padding: 1rem;">
          <cf-button
            variant="primary"
            onClick={startCreate}
            style="flex: 1;"
          >
            + Add Person
          </cf-button>
        </cf-hstack>

        {/* Modal form */}
        <cf-modal
          $open={modalOpen}
          dismissable
          size="md"
          oncf-modal-close={action(() => {
            modalOpen.set(false);
            editing.set({ editing: null });
          })}
        >
          <span slot="header">{modalTitle}</span>
          {ifElse(
            showModal,
            <EditPerson
              editing={editing}
              formData={formData}
              people={people}
              modalOpen={modalOpen}
            />,
            null,
          )}
        </cf-modal>
      </cf-screen>
    ),
    people,
  };
});
