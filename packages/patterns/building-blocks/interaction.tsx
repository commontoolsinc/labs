/// <cts-enable />
/**
 * Interaction - Touchpoint Log for CRM
 *
 * Records engagement with people, places, or things.
 * This is the "memory" of relationships - tracking conversations,
 * meetings, gifts, and other touchpoints.
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
import {
  generateId,
  now,
  type Interaction,
  type Person,
  type Place,
  type Thing,
} from "./schemas.tsx";

// =============================================================================
// TYPES
// =============================================================================

interface Input {
  interactions?: Writable<Default<Interaction[], []>>;
  // Optional entity collections for linking
  persons?: Default<Person[], []>;
  places?: Default<Place[], []>;
  things?: Default<Thing[], []>;
}

interface Output {
  [NAME]: string;
  [UI]: VNode;
  interactions: Interaction[];
  recentInteractions: Interaction[];
  activeInteractions: Interaction[];
  interactionCount: number;
  addInteraction: Stream<{
    type: string;
    summary?: string;
    notes?: string;
    personIds?: string[];
    placeId?: string;
    thingIds?: string[];
  }>;
  updateInteraction: Stream<{ id: string; updates: Partial<Interaction> }>;
  archiveInteraction: Stream<{ id: string }>;
  restoreInteraction: Stream<{ id: string }>;
  deleteInteraction: Stream<{ id: string }>;
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

function getTypeIcon(type: string | undefined): string {
  switch (type?.toLowerCase()) {
    case "call":
      return "📞";
    case "email":
      return "📧";
    case "meeting":
      return "🤝";
    case "message":
      return "💬";
    case "video":
      return "📹";
    case "gift":
      return "🎁";
    case "meal":
      return "🍽️";
    case "event":
      return "🎉";
    case "note":
      return "📝";
    default:
      return "💬";
  }
}

function formatTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) {
    return `Today at ${date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  } else if (diffDays === 1) {
    return "Yesterday";
  } else if (diffDays < 7) {
    return `${diffDays} days ago`;
  } else {
    return date.toLocaleDateString();
  }
}

// Common interaction types for quick-add
const INTERACTION_TYPES = [
  { key: "call", label: "Call", icon: "📞" },
  { key: "email", label: "Email", icon: "📧" },
  { key: "meeting", label: "Meeting", icon: "🤝" },
  { key: "message", label: "Message", icon: "💬" },
  { key: "note", label: "Note", icon: "📝" },
];

// =============================================================================
// PATTERN
// =============================================================================

export default pattern<Input, Output>(({ interactions, persons, places, things }) => {
  // ---------------------------------------------------------------------------
  // Computed Values
  // ---------------------------------------------------------------------------

  // Active interactions (not archived)
  const activeInteractions = computed(() =>
    interactions.get().filter((i) => i.isActive !== false)
  );

  // Sort by most recent first
  const recentInteractions = computed(() =>
    [...interactions.get()].sort((a, b) => b.occurredAt - a.occurredAt)
  );

  const interactionCount = computed(() => activeInteractions.length);

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  const addInteraction = action(
    ({
      type,
      summary,
      notes,
      personIds,
      placeId,
      thingIds,
    }: {
      type: string;
      summary?: string;
      notes?: string;
      personIds?: string[];
      placeId?: string;
      thingIds?: string[];
    }) => {
      const newInteraction: Interaction = {
        id: generateId(),
        type,
        summary,
        notes,
        personIds,
        placeId,
        thingIds,
        occurredAt: now(),
        createdAt: now(),
        modifiedAt: now(),
        isActive: true,
      };

      interactions.set([...interactions.get(), newInteraction]);
    }
  );

  const updateInteraction = action(
    ({ id, updates }: { id: string; updates: Partial<Interaction> }) => {
      const index = interactions.get().findIndex((i) => i.id === id);
      if (index === -1) return;
      const current = interactions.get()[index];
      const updated = { ...current, ...updates, modifiedAt: now() };
      interactions.set(interactions.get().toSpliced(index, 1, updated));
    }
  );

  const deleteInteraction = action(({ id }: { id: string }) => {
    const index = interactions.get().findIndex((i) => i.id === id);
    if (index !== -1) {
      interactions.set(interactions.get().toSpliced(index, 1));
    }
  });

  const archiveInteraction = action(({ id }: { id: string }) => {
    updateInteraction.send({ id, updates: { isActive: false } });
  });

  const restoreInteraction = action(({ id }: { id: string }) => {
    updateInteraction.send({ id, updates: { isActive: true } });
  });

  // ---------------------------------------------------------------------------
  // Local UI State
  // ---------------------------------------------------------------------------

  const selectedType = Writable.of<string>("all");
  const showArchived = Writable.of<boolean>(false);
  const showLinkPanel = Writable.of<boolean>(false);
  const selectedPersonIds = Writable.of<string[]>([]);
  const selectedPlaceId = Writable.of<string>("");
  const selectedThingIds = Writable.of<string[]>([]);

  // Edit modal state
  const showEditModal = Writable.of<boolean>(false);
  const editingId = Writable.of<string>("");
  const editType = Writable.of<string>("");
  const editSummary = Writable.of<string>("");
  const editNotes = Writable.of<string>("");
  const notesExpanded = Writable.of<boolean>(false);

  const openEditModal = action(({ interaction }: { interaction: Interaction }) => {
    editingId.set(interaction.id);
    editType.set(interaction.type || "call");
    editSummary.set(interaction.summary || "");
    editNotes.set(interaction.notes || "");
    notesExpanded.set(false);
    showEditModal.set(true);
  });

  const saveEdit = action((_: void) => {
    const id = editingId.get();
    if (!id) return;
    updateInteraction.send({
      id,
      updates: {
        type: editType.get().trim() || "call",
        summary: editSummary.get().trim() || undefined,
        notes: editNotes.get().trim() || undefined,
      },
    });
    showEditModal.set(false);
    editingId.set("");
    notesExpanded.set(false);
  });

  const closeEditModal = action((_: void) => {
    showEditModal.set(false);
    editingId.set("");
  });

  const deleteFromModal = action((_: void) => {
    const id = editingId.get();
    if (id) {
      deleteInteraction.send({ id });
    }
    showEditModal.set(false);
    editingId.set("");
  });

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return {
    [NAME]: computed(() => `Interactions (${interactionCount})`),
    [UI]: (
      <ct-screen>
        {/* Header */}
        <div
          slot="header"
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "8px",
            padding: "8px 0",
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <span style={{ fontWeight: "600", fontSize: "1.1rem" }}>Interactions</span>
              <span style={{ fontSize: "0.75rem", color: "#6b7280" }}>
                ({interactionCount} logged)
              </span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: "4px" }}>
              <ct-checkbox $checked={showArchived} />
              <span style={{ fontSize: "0.75rem" }}>Show archived</span>
            </div>
          </div>

          {/* Type filter tabs */}
          <div style={{ display: "flex", gap: "4px", overflowX: "auto", paddingBottom: "4px" }}>
            <button
              type="button"
              style={{
                ...STYLES.button.base,
                backgroundColor: computed(() => selectedType.get() === "all" ? "#3b82f6" : "#fff"),
                color: computed(() => selectedType.get() === "all" ? "#fff" : "#374151"),
                borderColor: computed(() => selectedType.get() === "all" ? "#3b82f6" : "#d1d5db"),
              }}
              onClick={() => selectedType.set("all")}
            >
              📋 All
            </button>
            {INTERACTION_TYPES.map(({ key, label, icon }) => (
              <button
                type="button"
                style={{
                  ...STYLES.button.base,
                  backgroundColor: computed(() => selectedType.get() === key ? "#3b82f6" : "#fff"),
                  color: computed(() => selectedType.get() === key ? "#fff" : "#374151"),
                  borderColor: computed(() => selectedType.get() === key ? "#3b82f6" : "#d1d5db"),
                }}
                onClick={() => selectedType.set(key)}
              >
                {icon} {label} ({computed(() => interactions.get().filter((i) => i.type === key && i.isActive !== false).length)})
              </button>
            ))}
          </div>
        </div>

        {/* Edit Modal */}
        <ct-modal $open={showEditModal} dismissable size="sm" label="Edit Interaction">
          <span slot="header">Edit Interaction</span>
          <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
            <div>
              <label style={STYLES.label}>Summary</label>
              <ct-input $value={editSummary} placeholder="Summary" style={{ width: "100%" }} onct-keydown={handleEnterSave({ saveEdit })} />
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
                  <div style={{ display: "flex", gap: "4px", flexWrap: "wrap" }}>
                    {INTERACTION_TYPES.map(({ key, label, icon }) => (
                      <button
                        type="button"
                        style={{
                          ...STYLES.button.base,
                          backgroundColor: computed(() => editType.get() === key ? "#3b82f6" : "#fff"),
                          color: computed(() => editType.get() === key ? "#fff" : "#374151"),
                          borderColor: computed(() => editType.get() === key ? "#3b82f6" : "#d1d5db"),
                        }}
                        onClick={() => editType.set(key)}
                      >
                        {icon} {label}
                      </button>
                    ))}
                  </div>
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
                const interaction = interactions.get().find((i) => i.id === currentId);
                if (interaction?.isActive === false) {
                  restoreInteraction.send({ id: currentId });
                } else {
                  archiveInteraction.send({ id: currentId });
                }
                closeEditModal.send();
              }}
            >
              {computed(() => {
                const currentId = editingId.get();
                const interaction = interactions.get().find((i) => i.id === currentId);
                return interaction?.isActive === false ? "Restore" : "Archive";
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
              const typeFilter = selectedType.get();
              let interactionsToShow = showArchived.get()
                ? recentInteractions
                : recentInteractions.filter((i: Interaction) => i.isActive !== false);

              // Filter by type if not "all"
              if (typeFilter !== "all") {
                interactionsToShow = interactionsToShow.filter((i: Interaction) => i.type === typeFilter);
              }

              if (interactionsToShow.length === 0) {
                return (
                  <div style={{ textAlign: "center", color: "#6b7280", padding: "32px", fontSize: "0.875rem" }}>
                    No interactions yet. Log calls, emails, meetings, and other
                    touchpoints.
                  </div>
                );
              }

              return interactionsToShow.map((interaction: Interaction) => {
                const isArchived = interaction.isActive === false;
                return (
                <div
                  style={{
                    ...STYLES.card,
                    cursor: "pointer",
                    opacity: isArchived ? 0.6 : 1,
                  }}
                  onClick={() => openEditModal.send({ interaction })}
                >
                  <div style={{ display: "flex", gap: "12px", alignItems: "flex-start" }}>
                    <span style={{ fontSize: "1.5rem" }}>
                      {getTypeIcon(interaction.type)}
                    </span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "4px" }}>
                        <span style={{ fontWeight: "600", fontSize: "0.9rem", textTransform: "capitalize" }}>
                          {interaction.type}
                        </span>
                        <span style={{ fontSize: "0.65rem", color: "#9ca3af" }}>
                          {formatTimestamp(interaction.occurredAt)}
                        </span>
                      </div>
                      {interaction.summary ? (
                        <div style={{ fontSize: "0.875rem", marginBottom: "4px" }}>
                          {interaction.summary}
                        </div>
                      ) : null}
                      {interaction.notes ? (
                        <div style={{ fontSize: "0.75rem", color: "#6b7280", marginBottom: "4px" }}>
                          {interaction.notes}
                        </div>
                      ) : null}
                      <div style={{ display: "flex", gap: "4px", flexWrap: "wrap" }}>
                        {interaction.personIds && interaction.personIds.length > 0
                          ? interaction.personIds.map((pid: string) => (
                            <span style={{ fontSize: "0.65rem", backgroundColor: "#f3e8ff", color: "#7c3aed", padding: "2px 6px", borderRadius: "4px" }}>
                              👤 {persons.find((p) => p.id === pid)?.name || "Person"}
                            </span>
                          ))
                          : null}
                        {interaction.placeId ? (
                          <span style={{ fontSize: "0.65rem", backgroundColor: "#dbeafe", color: "#2563eb", padding: "2px 6px", borderRadius: "4px" }}>
                            📍 {places.find((p) => p.id === interaction.placeId)?.name || "Place"}
                          </span>
                        ) : null}
                        {interaction.thingIds && interaction.thingIds.length > 0
                          ? interaction.thingIds.map((tid: string) => (
                            <span style={{ fontSize: "0.65rem", backgroundColor: "#fef3c7", color: "#d97706", padding: "2px 6px", borderRadius: "4px" }}>
                              📦 {things.find((t) => t.id === tid)?.name || "Thing"}
                            </span>
                          ))
                          : null}
                      </div>
                    </div>
                  </div>
                </div>
              );});
            })}
          </div>
        </ct-vscroll>

        {/* Footer with Add Input */}
        <div slot="footer" style={{ display: "flex", flexDirection: "column", gap: "8px", padding: "12px" }}>
          {/* Link Panel - shows when expanded */}
          {computed(() => {
            if (!showLinkPanel.get()) return null;

            const hasEntities = persons.length > 0 || places.length > 0 || things.length > 0;
            if (!hasEntities) {
              return (
                <div style={{ fontSize: "0.75rem", color: "#6b7280", padding: "8px", textAlign: "center" }}>
                  No entities available to link. Create persons, places, or things first.
                </div>
              );
            }

            return (
              <div style={{ display: "flex", flexDirection: "column", gap: "8px", padding: "8px", backgroundColor: "#f9fafb", borderRadius: "8px" }}>
                {/* Persons - multi-select */}
                {persons.length > 0 ? (
                  <div>
                    <span style={{ fontSize: "0.65rem", color: "#6b7280", marginBottom: "4px", display: "block" }}>👤 People (click to toggle)</span>
                    <div style={{ display: "flex", gap: "4px", flexWrap: "wrap" }}>
                      {persons.map((p) => (
                        <button
                          type="button"
                          style={{
                            ...STYLES.button.base,
                            backgroundColor: computed(() => selectedPersonIds.get().includes(p.id) ? "#3b82f6" : "#fff"),
                            color: computed(() => selectedPersonIds.get().includes(p.id) ? "#fff" : "#374151"),
                          }}
                          onClick={() => {
                            const current = selectedPersonIds.get();
                            if (current.includes(p.id)) {
                              selectedPersonIds.set(current.filter((id) => id !== p.id));
                            } else {
                              selectedPersonIds.set([...current, p.id]);
                            }
                          }}
                        >
                          {p.name}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null}

                {/* Places - single select */}
                {places.length > 0 ? (
                  <div>
                    <span style={{ fontSize: "0.65rem", color: "#6b7280", marginBottom: "4px", display: "block" }}>📍 Place</span>
                    <div style={{ display: "flex", gap: "4px", flexWrap: "wrap" }}>
                      {places.map((p) => (
                        <button
                          type="button"
                          style={{
                            ...STYLES.button.base,
                            backgroundColor: computed(() => selectedPlaceId.get() === p.id ? "#3b82f6" : "#fff"),
                            color: computed(() => selectedPlaceId.get() === p.id ? "#fff" : "#374151"),
                          }}
                          onClick={() => selectedPlaceId.set(selectedPlaceId.get() === p.id ? "" : p.id)}
                        >
                          {p.name}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null}

                {/* Things - multi-select */}
                {things.length > 0 ? (
                  <div>
                    <span style={{ fontSize: "0.65rem", color: "#6b7280", marginBottom: "4px", display: "block" }}>📦 Things (click to toggle)</span>
                    <div style={{ display: "flex", gap: "4px", flexWrap: "wrap" }}>
                      {things.map((t) => (
                        <button
                          type="button"
                          style={{
                            ...STYLES.button.base,
                            backgroundColor: computed(() => selectedThingIds.get().includes(t.id) ? "#3b82f6" : "#fff"),
                            color: computed(() => selectedThingIds.get().includes(t.id) ? "#fff" : "#374151"),
                          }}
                          onClick={() => {
                            const current = selectedThingIds.get();
                            if (current.includes(t.id)) {
                              selectedThingIds.set(current.filter((id) => id !== t.id));
                            } else {
                              selectedThingIds.set([...current, t.id]);
                            }
                          }}
                        >
                          {t.name}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            );
          })}

          {/* Selected links indicator */}
          {computed(() => {
            const selPersonIds = selectedPersonIds.get();
            const selPlaceId = selectedPlaceId.get();
            const selThingIds = selectedThingIds.get();

            const personNames = selPersonIds.map((pid) => persons.find((p) => p.id === pid)?.name).filter(Boolean);
            const placeName = selPlaceId ? places.find((p) => p.id === selPlaceId)?.name : null;
            const thingNames = selThingIds.map((tid) => things.find((t) => t.id === tid)?.name).filter(Boolean);

            const hasSelections = personNames.length > 0 || placeName || thingNames.length > 0;
            if (!hasSelections) return null;

            return (
              <div style={{ display: "flex", gap: "4px", flexWrap: "wrap" }}>
                {personNames.map((name) => (
                  <span style={{ fontSize: "0.65rem", backgroundColor: "#f3e8ff", color: "#7c3aed", padding: "2px 6px", borderRadius: "4px" }}>
                    👤 {name}
                  </span>
                ))}
                {placeName ? (
                  <span style={{ fontSize: "0.65rem", backgroundColor: "#dbeafe", color: "#2563eb", padding: "2px 6px", borderRadius: "4px" }}>
                    📍 {placeName}
                  </span>
                ) : null}
                {thingNames.map((name) => (
                  <span style={{ fontSize: "0.65rem", backgroundColor: "#fef3c7", color: "#d97706", padding: "2px 6px", borderRadius: "4px" }}>
                    📦 {name}
                  </span>
                ))}
              </div>
            );
          })}

          {/* Input row */}
          <div style={{ display: "flex", gap: "8px" }}>
            <button
              type="button"
              style={{
                ...STYLES.button.base,
                backgroundColor: computed(() => showLinkPanel.get() ? "#3b82f6" : "#fff"),
                color: computed(() => showLinkPanel.get() ? "#fff" : "#374151"),
              }}
              onClick={() => showLinkPanel.set(!showLinkPanel.get())}
              title="Link to entities"
            >
              🔗
            </button>
            <ct-message-input
              placeholder={computed(() => {
                const type = selectedType.get();
                return type === "all" ? "Log an interaction (select type above)..." : `Log a ${type} (optional notes)...`;
              })}
              style={{ flex: 1 }}
              onct-send={(e: { detail?: { message?: string } }) => {
                const summary = e.detail?.message?.trim();
                const personIds = selectedPersonIds.get();
                const placeId = selectedPlaceId.get();
                const thingIds = selectedThingIds.get();
                const type = selectedType.get();
                addInteraction.send({
                  type: type === "all" ? "note" : type,
                  summary: summary || undefined,
                  personIds: personIds.length > 0 ? [...personIds] : undefined,
                  placeId: placeId || undefined,
                  thingIds: thingIds.length > 0 ? [...thingIds] : undefined,
                });
                selectedPersonIds.set([]);
                selectedPlaceId.set("");
                selectedThingIds.set([]);
                showLinkPanel.set(false);
              }}
            />
          </div>
        </div>
      </ct-screen>
    ),
    interactions,
    recentInteractions,
    activeInteractions,
    interactionCount,
    addInteraction,
    updateInteraction,
    archiveInteraction,
    restoreInteraction,
    deleteInteraction,
  };
});
