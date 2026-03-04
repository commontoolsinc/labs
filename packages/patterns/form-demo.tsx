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
  equals,
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
// ct-form flushes buffered values to bound cells before emitting ct-submit,
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
        <ct-form
          onct-submit={handleFormSubmit({
            formData,
            people,
            editing,
            modalOpen,
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
                type="reset"
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
      <ct-screen>
        {/* Header */}
        <ct-vstack slot="header" gap="2">
          <ct-hstack justify="between" align="center">
            <ct-heading level={4}>People Directory</ct-heading>
            <span style="font-size: 0.875rem; color: var(--ct-color-gray-500);">
              {peopleCount}{" "}
              {computed(() =>
                people.get().length === 1 ? "person" : "people"
              )}
            </span>
          </ct-hstack>
        </ct-vstack>

        {/* Main content - list of people */}
        <ct-vscroll flex showScrollbar fadeEdges>
          <ct-vstack gap="2" style="padding: 1rem;">
            {people.map((person) => (
              <ct-card
                style="cursor: pointer;"
                onClick={startEdit({
                  person,
                  people,
                  editing,
                  formData,
                  modalOpen,
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
                    onClick={deletePerson({ person, people })}
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
        <ct-modal
          $open={modalOpen}
          dismissable
          size="md"
          onct-modal-close={action(() => {
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
        </ct-modal>
      </ct-screen>
    ),
    people,
  };
});
