/// <cts-enable />
/**
 * Thing - Generic Entity/Resource
 *
 * A flexible type for objects, documents, accounts, or any
 * "noun" that isn't a person or place.
 *
 * Use cases:
 * - Documents: Contracts, licenses, important files
 * - Accounts: Bank accounts, subscriptions, services
 * - Tools: Equipment, software, credentials
 * - Assets: Possessions you need to track
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
import { generateId, now, type Thing } from "./schemas.tsx";

// =============================================================================
// TYPES
// =============================================================================

interface Input {
  things?: Writable<Default<Thing[], []>>;
}

interface Output {
  [NAME]: string;
  [UI]: VNode;
  things: Thing[];
  activeThings: Thing[];
  thingCount: number;
  addThing: Stream<{ name: string; type?: string; category?: string; url?: string }>;
  updateThing: Stream<{ id: string; updates: Partial<Thing> }>;
  archiveThing: Stream<{ id: string }>;
  restoreThing: Stream<{ id: string }>;
  deleteThing: Stream<{ id: string }>;
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
    textTransform: "capitalize" as const,
  },
} as const;

// =============================================================================
// HANDLERS
// =============================================================================

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

function getThingIcon(type: string | undefined): string {
  switch (type?.toLowerCase()) {
    case "document":
      return "📄";
    case "account":
      return "🏦";
    case "subscription":
      return "💳";
    case "tool":
      return "🔧";
    case "software":
      return "💾";
    case "asset":
      return "💎";
    case "credential":
      return "🔑";
    default:
      return "📦";
  }
}

// =============================================================================
// PATTERN
// =============================================================================

export default pattern<Input, Output>(({ things }) => {
  // ---------------------------------------------------------------------------
  // Computed Values
  // ---------------------------------------------------------------------------

  const activeThings = computed(() =>
    things.get().filter((t) => t.isActive !== false)
  );

  const thingCount = computed(() => activeThings.length);

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  const addThing = action(
    ({
      name,
      type,
      category,
      url,
    }: { name: string; type?: string; category?: string; url?: string }) => {
      const trimmed = name.trim();
      if (!trimmed) return;

      const newThing: Thing = {
        id: generateId(),
        name: trimmed,
        type,
        category,
        url,
        createdAt: now(),
        modifiedAt: now(),
        isActive: true,
      };

      things.set([...things.get(), newThing]);
    }
  );

  const updateThing = action(
    ({ id, updates }: { id: string; updates: Partial<Thing> }) => {
      const index = things.get().findIndex((t) => t.id === id);
      if (index === -1) return;
      const current = things.get()[index];
      const updated = { ...current, ...updates, modifiedAt: now() };
      things.set(things.get().toSpliced(index, 1, updated));
    }
  );

  const archiveThing = action(({ id }: { id: string }) => {
    updateThing.send({ id, updates: { isActive: false } });
  });

  const restoreThing = action(({ id }: { id: string }) => {
    updateThing.send({ id, updates: { isActive: true } });
  });

  const deleteThing = action(({ id }: { id: string }) => {
    const index = things.get().findIndex((t) => t.id === id);
    if (index !== -1) {
      things.set(things.get().toSpliced(index, 1));
    }
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
  const editType = Writable.of<string>("");
  const editCategory = Writable.of<string>("");
  const editUrl = Writable.of<string>("");

  // Open edit modal
  const openEditModal = action(({ thing }: { thing: Thing }) => {
    editingId.set(thing.id);
    editName.set(thing.name || "");
    editNotes.set(thing.description || "");
    notesExpanded.set(false);
    editType.set(thing.type || "");
    editCategory.set(thing.category || "");
    editUrl.set(thing.url || "");
    showEditModal.set(true);
  });

  // Save edits
  const saveEdit = action((_: void) => {
    const id = editingId.get();
    if (!id) return;
    updateThing.send({
      id,
      updates: {
        name: editName.get().trim() || undefined,
        description: editNotes.get().trim() || undefined,
        type: editType.get().trim() || undefined,
        category: editCategory.get().trim() || undefined,
        url: editUrl.get().trim() || undefined,
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
      deleteThing.send({ id });
    }
    showEditModal.set(false);
    editingId.set("");
  });

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return {
    [NAME]: computed(() => `Things (${thingCount})`),
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
              Things
            </span>
            <span style={{ fontSize: "0.75rem", color: "#6b7280" }}>
              ({thingCount} items)
            </span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "4px" }}>
            <ct-checkbox $checked={showArchived} />
            <span style={{ fontSize: "0.75rem" }}>Show archived</span>
          </div>
        </div>

        {/* Edit Modal */}
        <ct-modal $open={showEditModal} dismissable size="sm" label="Edit Thing">
          <span slot="header">Edit Thing</span>
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
                  <label style={STYLES.label}>Type</label>
                  <ct-input $value={editType} placeholder="document, account, tool, software..." style={{ width: "100%" }} />
                </div>
                <div>
                  <label style={STYLES.label}>Category</label>
                  <ct-input $value={editCategory} placeholder="Category" style={{ width: "100%" }} />
                </div>
                <div>
                  <label style={STYLES.label}>URL</label>
                  <ct-input $value={editUrl} placeholder="URL" style={{ width: "100%" }} />
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
                const thing = things.get().find((t) => t.id === currentId);
                if (thing?.isActive === false) {
                  restoreThing.send({ id: currentId });
                } else {
                  archiveThing.send({ id: currentId });
                }
                closeEditModal.send();
              }}
            >
              {computed(() => {
                const currentId = editingId.get();
                const thing = things.get().find((t) => t.id === currentId);
                return thing?.isActive === false ? "Restore" : "Archive";
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
              const thingsToShow = showArchived.get() ? things.get() : activeThings;

              if (thingsToShow.length === 0) {
                return (
                  <div style={{ textAlign: "center", color: "#6b7280", padding: "32px", fontSize: "0.875rem" }}>
                    No things yet. Track documents, accounts, tools, and other items.
                  </div>
                );
              }

              return thingsToShow.map((thing: Thing) => {
                const isArchived = thing.isActive === false;

                return (
                  <div
                    style={{
                      ...STYLES.card,
                      opacity: isArchived ? 0.6 : 1,
                      cursor: "pointer",
                    }}
                    onClick={() => openEditModal.send({ thing })}
                  >
                    <div style={{ display: "flex", gap: "12px", alignItems: "flex-start" }}>
                      {/* Icon */}
                      <div style={{ fontSize: "1.5rem" }}>
                        {getThingIcon(thing.type)}
                      </div>

                      {/* Content */}
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "4px" }}>
                          <span style={{ fontWeight: "600", fontSize: "0.9rem" }}>{thing.name}</span>
                          {thing.type ? (
                            <span style={STYLES.tag}>{thing.type}</span>
                          ) : null}
                        </div>

                        {thing.description ? (
                          <div style={{ fontSize: "0.75rem", color: "#6b7280", marginBottom: "4px" }}>
                            {thing.description}
                          </div>
                        ) : null}

                        <div style={{ display: "flex", gap: "8px", marginBottom: "4px" }}>
                          {thing.category ? (
                            <span style={{ fontSize: "0.65rem", color: "#9ca3af" }}>
                              {thing.category}
                            </span>
                          ) : null}
                        </div>

                        {thing.url ? (
                          <div style={{ fontSize: "0.75rem", color: "#3b82f6" }}>
                            🔗 {thing.url}
                          </div>
                        ) : null}
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
            placeholder="Add a thing (e.g., Passport, Laptop, Bank Account...)"
            style={{ width: "100%" }}
            onct-send={(e: { detail?: { message?: string } }) => {
              const name = e.detail?.message?.trim();
              if (name) {
                addThing.send({ name });
              }
            }}
          />
        </div>
      </ct-screen>
    ),
    things,
    activeThings,
    thingCount,
    addThing,
    updateThing,
    archiveThing,
    restoreThing,
    deleteThing,
  };
});
