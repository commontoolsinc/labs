/// <cts-enable />
/**
 * Place - Physical or Virtual Location
 *
 * Provides context for tasks and interactions.
 * Enables location-based filtering ("What can I do at the office?").
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
import { generateId, now, type Place, type PlaceType } from "./schemas.tsx";

// =============================================================================
// TYPES
// =============================================================================

interface Input {
  places?: Writable<Default<Place[], []>>;
}

interface Output {
  [NAME]: string;
  [UI]: VNode;
  places: Place[];
  activePlaces: Place[];
  placeCount: number;
  addPlace: Stream<{ name: string; type?: PlaceType; address?: string; url?: string }>;
  updatePlace: Stream<{ id: string; updates: Partial<Place> }>;
  archivePlace: Stream<{ id: string }>;
  restorePlace: Stream<{ id: string }>;
  deletePlace: Stream<{ id: string }>;
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

function getPlaceIcon(type: PlaceType | undefined): string {
  switch (type) {
    case "virtual":
      return "💻";
    case "hybrid":
      return "🏢";
    default:
      return "📍";
  }
}

// =============================================================================
// PATTERN
// =============================================================================

export default pattern<Input, Output>(({ places }) => {
  // ---------------------------------------------------------------------------
  // Computed Values
  // ---------------------------------------------------------------------------

  const activePlaces = computed(() =>
    places.get().filter((p) => p.isActive !== false)
  );

  const placeCount = computed(() => activePlaces.length);

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  const addPlace = action(
    ({
      name,
      type,
      address,
      url,
    }: { name: string; type?: PlaceType; address?: string; url?: string }) => {
      const trimmed = name.trim();
      if (!trimmed) return;

      const newPlace: Place = {
        id: generateId(),
        name: trimmed,
        type: type || "physical",
        address,
        url,
        createdAt: now(),
        modifiedAt: now(),
        isActive: true,
      };

      places.set([...places.get(), newPlace]);
    }
  );

  const updatePlace = action(
    ({ id, updates }: { id: string; updates: Partial<Place> }) => {
      const index = places.get().findIndex((p) => p.id === id);
      if (index === -1) return;
      const current = places.get()[index];
      const updated = { ...current, ...updates, modifiedAt: now() };
      places.set(places.get().toSpliced(index, 1, updated));
    }
  );

  const archivePlace = action(({ id }: { id: string }) => {
    updatePlace.send({ id, updates: { isActive: false } });
  });

  const restorePlace = action(({ id }: { id: string }) => {
    updatePlace.send({ id, updates: { isActive: true } });
  });

  const deletePlace = action(({ id }: { id: string }) => {
    const index = places.get().findIndex((p) => p.id === id);
    if (index !== -1) {
      places.set(places.get().toSpliced(index, 1));
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
  const editAddress = Writable.of<string>("");
  const editUrl = Writable.of<string>("");
  const editType = Writable.of<string>("");

  // Open edit modal
  const openEditModal = action(({ place }: { place: Place }) => {
    editingId.set(place.id);
    editName.set(place.name || "");
    editNotes.set(place.description || "");
    notesExpanded.set(false);
    editAddress.set(place.address || "");
    editUrl.set(place.url || "");
    editType.set(place.type || "physical");
    showEditModal.set(true);
  });

  // Save edits
  const saveEdit = action((_: void) => {
    const id = editingId.get();
    if (!id) return;
    updatePlace.send({
      id,
      updates: {
        name: editName.get().trim() || undefined,
        description: editNotes.get().trim() || undefined,
        address: editAddress.get().trim() || undefined,
        url: editUrl.get().trim() || undefined,
        type: (editType.get().trim() as PlaceType) || "physical",
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
      deletePlace.send({ id });
    }
    showEditModal.set(false);
    editingId.set("");
  });

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return {
    [NAME]: computed(() => `Places (${placeCount})`),
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
              Places
            </span>
            <span style={{ fontSize: "0.75rem", color: "#6b7280" }}>
              ({placeCount} locations)
            </span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "4px" }}>
            <ct-checkbox $checked={showArchived} />
            <span style={{ fontSize: "0.75rem" }}>Show archived</span>
          </div>
        </div>

        {/* Edit Modal */}
        <ct-modal $open={showEditModal} dismissable size="sm" label="Edit Place">
          <span slot="header">Edit Place</span>
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
                  <ct-input $value={editType} placeholder="physical, virtual, hybrid" style={{ width: "100%" }} />
                </div>
                <div>
                  <label style={STYLES.label}>Address</label>
                  <ct-input $value={editAddress} placeholder="Address" style={{ width: "100%" }} />
                </div>
                <div>
                  <label style={STYLES.label}>URL (for virtual places)</label>
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
                const place = places.get().find((p) => p.id === currentId);
                if (place?.isActive === false) {
                  restorePlace.send({ id: currentId });
                } else {
                  archivePlace.send({ id: currentId });
                }
                closeEditModal.send();
              }}
            >
              {computed(() => {
                const currentId = editingId.get();
                const place = places.get().find((p) => p.id === currentId);
                return place?.isActive === false ? "Restore" : "Archive";
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
              const placesToShow = showArchived.get() ? places.get() : activePlaces;

              if (placesToShow.length === 0) {
                return (
                  <div style={{ textAlign: "center", color: "#6b7280", padding: "32px", fontSize: "0.875rem" }}>
                    No places yet. Add locations where you work or spend time.
                  </div>
                );
              }

              return placesToShow.map((place: Place) => {
                const isArchived = place.isActive === false;

                return (
                  <div
                    style={{
                      ...STYLES.card,
                      opacity: isArchived ? 0.6 : 1,
                      cursor: "pointer",
                    }}
                    onClick={() => openEditModal.send({ place })}
                  >
                    <div style={{ display: "flex", gap: "12px", alignItems: "flex-start" }}>
                      {/* Icon */}
                      <div style={{ fontSize: "1.5rem" }}>
                        {getPlaceIcon(place.type)}
                      </div>

                      {/* Content */}
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "4px" }}>
                          <span style={{ fontWeight: "600", fontSize: "0.9rem" }}>{place.name}</span>
                          <span style={STYLES.tag}>{place.type || "physical"}</span>
                        </div>

                        {place.address ? (
                          <div style={{ fontSize: "0.75rem", color: "#6b7280", marginBottom: "4px" }}>
                            📍 {place.address}
                          </div>
                        ) : null}

                        {place.url ? (
                          <div style={{ fontSize: "0.75rem", color: "#3b82f6", marginBottom: "4px" }}>
                            🔗 {place.url}
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
            placeholder="Add a place (e.g., Home, Office, Coffee Shop...)"
            style={{ width: "100%" }}
            onct-send={(e: { detail?: { message?: string } }) => {
              const name = e.detail?.message?.trim();
              if (name) {
                addPlace.send({ name });
              }
            }}
          />
        </div>
      </ct-screen>
    ),
    places,
    activePlaces,
    placeCount,
    addPlace,
    updatePlace,
    archivePlace,
    restorePlace,
    deletePlace,
  };
});
