/// <cts-enable />
/**
 * Person - Contact Entity for CRM
 *
 * The fundamental building block for relationship tracking.
 * Supports personal CRM patterns including contact info,
 * relationship types, and interaction history tracking.
 */
import {
  action,
  computed,
  Default,
  handler,
  NAME,
  pattern,
  Stream,
  UI,
  type VNode,
  Writable,
} from "commontools";
import { generateId, now, type Person } from "./schemas.tsx";

// =============================================================================
// TYPES
// =============================================================================

interface Input {
  persons?: Writable<Default<Person[], []>>;
}

interface Output {
  [NAME]: string;
  [UI]: VNode;
  persons: Person[];
  activePersons: Person[];
  personCount: number;
  addPerson: Stream<{
    name: string;
    email?: string;
    phone?: string;
    relationshipType?: string;
    organization?: string;
  }>;
  updatePerson: Stream<{ id: string; updates: Partial<Person> }>;
  archivePerson: Stream<{ id: string }>;
  restorePerson: Stream<{ id: string }>;
  deletePerson: Stream<{ id: string }>;
  recordContact: Stream<{ id: string }>;
}

// =============================================================================
// STYLES
// =============================================================================

const STYLES = {
  button: {
    base: {
      padding: "4px 8px",
      fontSize: "0.75rem",
      border: "1px solid #d1d5db",
      borderRadius: "4px",
      backgroundColor: "#fff",
      cursor: "pointer",
    },
    primary: {
      padding: "6px 12px",
      fontSize: "0.75rem",
      border: "none",
      borderRadius: "4px",
      backgroundColor: "#3b82f6",
      color: "#fff",
      cursor: "pointer",
    },
    danger: {
      padding: "6px 12px",
      fontSize: "0.75rem",
      border: "none",
      borderRadius: "4px",
      backgroundColor: "#fee2e2",
      color: "#dc2626",
      cursor: "pointer",
    },
    icon: {
      padding: "6px 8px",
      fontSize: "1rem",
      border: "1px solid #e5e7eb",
      borderRadius: "6px",
      backgroundColor: "#f9fafb",
      cursor: "pointer",
    },
  },
  label: {
    fontSize: "0.75rem",
    fontWeight: "500",
    display: "block",
    marginBottom: "4px",
    color: "#374151",
  },
  card: {
    padding: "12px",
    backgroundColor: "#fff",
    borderRadius: "8px",
    border: "1px solid #e5e7eb",
    marginBottom: "8px",
  },
  tag: {
    fontSize: "0.65rem",
    padding: "2px 8px",
    borderRadius: "9999px",
    backgroundColor: "#f3f4f6",
    color: "#6b7280",
  },
} as const;

// =============================================================================
// HANDLERS
// =============================================================================

// Enter key saves and closes modal
const handleEnterSave = handler<
  { key?: string },
  { saveEdit: Stream<void> }
>((event, { saveEdit }) => {
  if (event?.key === "Enter") {
    saveEdit.send();
  }
});

// =============================================================================
// HELPERS
// =============================================================================

function getRelationshipIcon(type: string | undefined): string {
  switch (type?.toLowerCase()) {
    case "family":
      return "👨‍👩‍👧‍👦";
    case "friend":
      return "🤝";
    case "colleague":
      return "💼";
    case "client":
      return "🤝";
    case "mentor":
      return "🎓";
    case "acquaintance":
      return "👋";
    default:
      return "👤";
  }
}

function formatLastContact(timestamp: number | undefined): string {
  if (!timestamp) return "Never";
  const days = Math.floor((Date.now() - timestamp) / (1000 * 60 * 60 * 24));
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;
  if (days < 30) return `${Math.floor(days / 7)} weeks ago`;
  if (days < 365) return `${Math.floor(days / 30)} months ago`;
  return `${Math.floor(days / 365)} years ago`;
}

function isOverdueForContact(person: Person): boolean {
  if (!person.contactFrequencyDays || !person.lastContactAt) return false;
  const daysSinceContact = Math.floor(
    (Date.now() - person.lastContactAt) / (1000 * 60 * 60 * 24)
  );
  return daysSinceContact > person.contactFrequencyDays;
}

// =============================================================================
// PATTERN
// =============================================================================

export default pattern<Input, Output>(({ persons }) => {
  // ---------------------------------------------------------------------------
  // Computed Values
  // ---------------------------------------------------------------------------

  const activePersons = computed(() =>
    persons.get().filter((p) => p.isActive !== false)
  );

  const personCount = computed(() => activePersons.length);

  const overdueContacts = computed(() =>
    activePersons.filter((p: Person) => isOverdueForContact(p))
  );

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  const addPerson = action(
    ({
      name,
      email,
      phone,
      relationshipType,
      organization,
    }: {
      name: string;
      email?: string;
      phone?: string;
      relationshipType?: string;
      organization?: string;
    }) => {
      const trimmed = name.trim();
      if (!trimmed) return;

      const newPerson: Person = {
        id: generateId(),
        name: trimmed,
        email,
        phone,
        relationshipType,
        organization,
        createdAt: now(),
        modifiedAt: now(),
        isActive: true,
      };

      persons.set([...persons.get(), newPerson]);
    }
  );

  const updatePerson = action(
    ({ id, updates }: { id: string; updates: Partial<Person> }) => {
      const index = persons.get().findIndex((p) => p.id === id);
      if (index === -1) return;
      const current = persons.get()[index];
      const updated = { ...current, ...updates, modifiedAt: now() };
      persons.set(persons.get().toSpliced(index, 1, updated));
    }
  );

  const archivePerson = action(({ id }: { id: string }) => {
    updatePerson.send({ id, updates: { isActive: false } });
  });

  const restorePerson = action(({ id }: { id: string }) => {
    updatePerson.send({ id, updates: { isActive: true } });
  });

  const deletePerson = action(({ id }: { id: string }) => {
    const index = persons.get().findIndex((p) => p.id === id);
    if (index !== -1) {
      persons.set(persons.get().toSpliced(index, 1));
    }
  });

  const recordContact = action(({ id }: { id: string }) => {
    updatePerson.send({ id, updates: { lastContactAt: now() } });
  });

  // ---------------------------------------------------------------------------
  // Local UI State
  // ---------------------------------------------------------------------------

  const showArchived = Writable.of<boolean>(false);
  const showEditModal = Writable.of<boolean>(false);
  const editingId = Writable.of<string>("");
  const editName = Writable.of<string>("");
  const editNotes = Writable.of<string>("");
  const notesExpanded = Writable.of<boolean>(false);
  const editEmail = Writable.of<string>("");
  const editPhone = Writable.of<string>("");
  const editOrganization = Writable.of<string>("");
  const editRelationshipType = Writable.of<string>("");

  // Open edit modal
  const openEditModal = action(({ person }: { person: Person }) => {
    editingId.set(person.id);
    editName.set(person.name || "");
    editNotes.set(person.notes || "");
    notesExpanded.set(false);
    editEmail.set(person.email || "");
    editPhone.set(person.phone || "");
    editOrganization.set(person.organization || "");
    editRelationshipType.set(person.relationshipType || "");
    showEditModal.set(true);
  });

  // Save edits
  const saveEdit = action((_: void) => {
    const id = editingId.get();
    if (!id) return;
    updatePerson.send({
      id,
      updates: {
        name: editName.get().trim() || undefined,
        notes: editNotes.get().trim() || undefined,
        email: editEmail.get().trim() || undefined,
        phone: editPhone.get().trim() || undefined,
        organization: editOrganization.get().trim() || undefined,
        relationshipType: editRelationshipType.get().trim() || undefined,
      },
    });
    showEditModal.set(false);
    editingId.set("");
    notesExpanded.set(false);
  });

  // Close modal
  const closeEditModal = action((_: void) => {
    showEditModal.set(false);
    editingId.set("");
  });

  // Delete from modal
  const deleteFromModal = action((_: void) => {
    const id = editingId.get();
    if (id) {
      deletePerson.send({ id });
    }
    showEditModal.set(false);
    editingId.set("");
  });

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return {
    [NAME]: computed(() => `People (${personCount})`),
    [UI]: (
      <ct-screen>
        {/* Header */}
        <div
          slot="header"
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            padding: "8px 0",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <span style={{ fontWeight: "600", fontSize: "1.1rem" }}>
              People
            </span>
            <span style={{ fontSize: "0.75rem", color: "#6b7280" }}>
              ({personCount} contacts)
            </span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "4px" }}>
            <ct-checkbox $checked={showArchived} />
            <span style={{ fontSize: "0.75rem" }}>Show archived</span>
          </div>
        </div>

        {/* Overdue Warning */}
        {computed(() =>
          overdueContacts.length > 0
            ? (
              <div style={{ fontSize: "0.75rem", color: "#f97316", padding: "4px 16px", backgroundColor: "#fff7ed", borderRadius: "4px", margin: "0 0 8px 0" }}>
                ⚠️ {overdueContacts.length} contacts overdue for follow-up
              </div>
            )
            : null
        )}

        {/* Edit Modal */}
        <ct-modal $open={showEditModal} dismissable size="sm" label="Edit Person">
          <span slot="header">Edit Person</span>
          <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
            <div>
              <label style={STYLES.label}>Name</label>
              <ct-input $value={editName} placeholder="Name" style={{ width: "100%" }} onct-keydown={handleEnterSave({ saveEdit })} />
            </div>
            <div
              style={{
                backgroundColor: "#fef9c3",
                borderRadius: "8px",
                padding: "8px",
                border: "1px solid #fde047",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "4px" }}>
                <label style={{ ...STYLES.label, color: "#a16207", marginBottom: 0 }}>Notes</label>
                <button
                  type="button"
                  style={{ ...STYLES.button.base, padding: "2px 6px", fontSize: "0.65rem" }}
                  onClick={() => notesExpanded.set(!notesExpanded.get())}
                >
                  {computed(() => notesExpanded.get() ? "▼ Collapse" : "▶ Expand")}
                </button>
              </div>
              <ct-textarea
                $value={editNotes}
                placeholder="Add notes..."
                rows={computed(() => notesExpanded.get() ? 8 : 2)}
                style={{ width: "100%", backgroundColor: "#fffef5", border: "none", borderRadius: "4px" }}
              />
            </div>
            {computed(() => notesExpanded.get() ? null : (
              <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                <div>
                  <label style={STYLES.label}>Email</label>
                  <ct-input $value={editEmail} placeholder="Email" style={{ width: "100%" }} />
                </div>
                <div>
                  <label style={STYLES.label}>Phone</label>
                  <ct-input $value={editPhone} placeholder="Phone" style={{ width: "100%" }} />
                </div>
                <div>
                  <label style={STYLES.label}>Organization</label>
                  <ct-input $value={editOrganization} placeholder="Organization" style={{ width: "100%" }} />
                </div>
                <div>
                  <label style={STYLES.label}>Relationship</label>
                  <ct-input $value={editRelationshipType} placeholder="friend, family, colleague..." style={{ width: "100%" }} />
                </div>
              </div>
            ))}
          </div>
          <div slot="footer" style={{ display: "flex", gap: "8px", justifyContent: "flex-end", width: "100%" }}>
            <button type="button" style={STYLES.button.danger} onClick={() => deleteFromModal.send()}>
              Delete
            </button>
            <button
              type="button"
              style={STYLES.button.base}
              onClick={() => {
                const currentId = editingId.get();
                const person = persons.get().find((p) => p.id === currentId);
                if (person?.isActive === false) {
                  restorePerson.send({ id: currentId });
                } else {
                  archivePerson.send({ id: currentId });
                }
                closeEditModal.send();
              }}
            >
              {computed(() => {
                const currentId = editingId.get();
                const person = persons.get().find((p) => p.id === currentId);
                return person?.isActive === false ? "Restore" : "Archive";
              })}
            </button>
            <div style={{ flex: 1 }} />
            <button type="button" style={STYLES.button.base} onClick={() => closeEditModal.send()}>
              Cancel
            </button>
            <button type="button" style={STYLES.button.primary} onClick={() => saveEdit.send()}>
              Save
            </button>
          </div>
        </ct-modal>

        {/* List */}
        <ct-vscroll flex showScrollbar fadeEdges>
          <div style={{ padding: "8px" }}>
            {computed(() => {
              const peopleToShow = showArchived.get() ? persons.get() : activePersons;

              if (peopleToShow.length === 0) {
                return (
                  <div style={{ textAlign: "center", color: "#6b7280", padding: "32px", fontSize: "0.875rem" }}>
                    No contacts yet. Add people you want to stay in touch with.
                  </div>
                );
              }

              return peopleToShow.map((person: Person) => {
                const overdue = isOverdueForContact(person);
                const isArchived = person.isActive === false;

                return (
                  <div
                    style={{
                      ...STYLES.card,
                      opacity: isArchived ? 0.6 : 1,
                      borderLeft: overdue ? "3px solid #f97316" : "1px solid #e5e7eb",
                      cursor: "pointer",
                    }}
                    onClick={() => openEditModal.send({ person })}
                  >
                    <div style={{ display: "flex", gap: "12px", alignItems: "flex-start" }}>
                      {/* Icon */}
                      <div style={{ fontSize: "1.5rem" }}>
                        {getRelationshipIcon(person.relationshipType)}
                      </div>

                      {/* Content */}
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "4px" }}>
                          <span style={{ fontWeight: "600", fontSize: "0.9rem" }}>{person.name}</span>
                          {person.relationshipType ? (
                            <span style={STYLES.tag}>{person.relationshipType}</span>
                          ) : null}
                        </div>

                        {person.organization ? (
                          <div style={{ fontSize: "0.75rem", color: "#6b7280", marginBottom: "4px" }}>
                            {person.organization}
                            {person.role ? ` • ${person.role}` : ""}
                          </div>
                        ) : null}

                        <div style={{ display: "flex", gap: "12px", marginBottom: "4px" }}>
                          {person.email ? (
                            <span style={{ fontSize: "0.75rem", color: "#3b82f6" }}>
                              📧 {person.email}
                            </span>
                          ) : null}
                          {person.phone ? (
                            <span style={{ fontSize: "0.75rem", color: "#3b82f6" }}>
                              📱 {person.phone}
                            </span>
                          ) : null}
                        </div>

                        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                          <span style={{ fontSize: "0.65rem", color: overdue ? "#f97316" : "#9ca3af" }}>
                            Last contact: {formatLastContact(person.lastContactAt)}
                          </span>
                        </div>
                      </div>

                      {/* Actions */}
                      <div style={{ display: "flex", gap: "4px", alignItems: "center" }}>
                        <button
                          type="button"
                          style={STYLES.button.base}
                          onClick={() => recordContact.send({ id: person.id })}
                        >
                          Contact
                        </button>
                      </div>
                    </div>
                  </div>
                );
              });
            })}
          </div>
        </ct-vscroll>

        {/* Footer with Add Input */}
        <div slot="footer" style={{ padding: "12px" }}>
          <ct-message-input
            placeholder="Add a person (e.g., John Smith, Mom, Jane from work...)"
            style={{ width: "100%" }}
            onct-send={(e: { detail?: { message?: string } }) => {
              const name = e.detail?.message?.trim();
              if (name) {
                addPerson.send({ name });
              }
            }}
          />
        </div>
      </ct-screen>
    ),
    persons,
    activePersons,
    personCount,
    addPerson,
    updatePerson,
    archivePerson,
    restorePerson,
    deletePerson,
    recordContact,
  };
});
