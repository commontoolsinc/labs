/// <cts-enable />
/**
 * Role - Ongoing Responsibility Domain (PARA Method)
 *
 * Roles are perpetual domains of responsibility with no endpoint.
 * They answer: "What hats do I wear? What standards must I maintain?"
 *
 * Examples: Parent, Employee, Friend, Homeowner, Health Manager
 *
 * Key distinction from Projects: Roles don't complete. You maintain them.
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
import { generateId, now, type Role } from "./schemas.tsx";

// =============================================================================
// TYPES
// =============================================================================

interface Input {
  roles?: Writable<Default<Role[], []>>;
}

interface Output {
  [NAME]: string;
  [UI]: VNode;
  roles: Role[];
  activeRoles: Role[];
  roleCount: number;
  addRole: Stream<{ title: string; icon?: string; color?: string }>;
  updateRole: Stream<{ id: string; updates: Partial<Role> }>;
  archiveRole: Stream<{ id: string }>;
  restoreRole: Stream<{ id: string }>;
  deleteRole: Stream<{ id: string }>;
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
// PATTERN
// =============================================================================

export default pattern<Input, Output>(({ roles }) => {
  // ---------------------------------------------------------------------------
  // Computed Values
  // ---------------------------------------------------------------------------

  const activeRoles = computed(() =>
    roles.get().filter((r) => r.isActive !== false)
  );

  const roleCount = computed(() => activeRoles.length);

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  const addRole = action(
    ({ title, icon, color }: { title: string; icon?: string; color?: string }) => {
      const trimmed = title.trim();
      if (!trimmed) return;

      const newRole: Role = {
        id: generateId(),
        title: trimmed,
        icon: icon || "🎭",
        color: color || "#6366f1",
        createdAt: now(),
        modifiedAt: now(),
        isActive: true,
      };

      roles.set([...roles.get(), newRole]);
    }
  );

  const updateRole = action(
    ({ id, updates }: { id: string; updates: Partial<Role> }) => {
      const index = roles.get().findIndex((r) => r.id === id);
      if (index === -1) return;
      const current = roles.get()[index];
      const updated = { ...current, ...updates, modifiedAt: now() };
      roles.set(roles.get().toSpliced(index, 1, updated));
    }
  );

  const archiveRole = action(({ id }: { id: string }) => {
    updateRole.send({ id, updates: { isActive: false } });
  });

  const restoreRole = action(({ id }: { id: string }) => {
    updateRole.send({ id, updates: { isActive: true } });
  });

  const deleteRole = action(({ id }: { id: string }) => {
    const index = roles.get().findIndex((r) => r.id === id);
    if (index !== -1) {
      roles.set(roles.get().toSpliced(index, 1));
    }
  });

  // ---------------------------------------------------------------------------
  // Local UI State
  // ---------------------------------------------------------------------------

  const showArchived = Writable.of<boolean>(false);
  const showEditModal = Writable.of<boolean>(false);
  const editingId = Writable.of<string>("");
  const editTitle = Writable.of<string>("");
  const editIcon = Writable.of<string>("");
  const editColor = Writable.of<string>("");
  const editNotes = Writable.of<string>("");
  const notesExpanded = Writable.of<boolean>(false);

  const openEditModal = action(({ role }: { role: Role }) => {
    editingId.set(role.id);
    editTitle.set(role.title || "");
    editNotes.set(role.description || "");
    notesExpanded.set(false);
    editIcon.set(role.icon || "🎭");
    editColor.set(role.color || "#6366f1");
    showEditModal.set(true);
  });

  const saveEdit = action((_: void) => {
    const id = editingId.get();
    if (!id) return;
    updateRole.send({
      id,
      updates: {
        title: editTitle.get().trim() || undefined,
        icon: editIcon.get().trim() || "🎭",
        color: editColor.get().trim() || "#6366f1",
        description: editNotes.get().trim() || undefined,
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
      deleteRole.send({ id });
    }
    showEditModal.set(false);
    editingId.set("");
  });

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return {
    [NAME]: computed(() => `Roles (${roleCount})`),
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
            <span style={{ fontWeight: "600", fontSize: "1.1rem" }}>Roles</span>
            <span style={{ fontSize: "0.75rem", color: "#6b7280" }}>
              ({roleCount} active)
            </span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "4px" }}>
            <ct-checkbox $checked={showArchived} />
            <span style={{ fontSize: "0.75rem" }}>Show archived</span>
          </div>
        </div>

        {/* Edit Modal */}
        <ct-modal $open={showEditModal} dismissable size="sm" label="Edit Role">
          <span slot="header">Edit Role</span>
          <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
            <div>
              <label style={STYLES.label}>Title</label>
              <ct-input $value={editTitle} placeholder="Title" style={{ width: "100%" }} onct-keydown={handleEnterSave({ saveEdit })} />
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
                  <label style={STYLES.label}>Icon (emoji)</label>
                  <ct-input $value={editIcon} placeholder="🎭" style={{ width: "100%" }} />
                </div>
                <div>
                  <label style={STYLES.label}>Color</label>
                  <ct-input $value={editColor} placeholder="#6366f1" style={{ width: "100%" }} />
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
                const role = roles.get().find((r) => r.id === currentId);
                if (role?.isActive === false) {
                  restoreRole.send({ id: currentId });
                } else {
                  archiveRole.send({ id: currentId });
                }
                closeEditModal.send();
              }}
            >
              {computed(() => {
                const currentId = editingId.get();
                const role = roles.get().find((r) => r.id === currentId);
                return role?.isActive === false ? "Restore" : "Archive";
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
              const rolesToShow = showArchived.get() ? roles.get() : activeRoles;

              if (rolesToShow.length === 0) {
                return (
                  <div style={{ textAlign: "center", color: "#6b7280", padding: "32px", fontSize: "0.875rem" }}>
                    No roles yet. Add the hats you wear (e.g., Parent, Employee, Friend).
                  </div>
                );
              }

              return rolesToShow.map((role: Role) => {
                const isArchived = role.isActive === false;

                return (
                  <div
                    style={{
                      ...STYLES.card,
                      borderLeft: `4px solid ${role.color || "#6366f1"}`,
                      opacity: isArchived ? 0.6 : 1,
                      cursor: "pointer",
                    }}
                    onClick={() => openEditModal.send({ role })}
                  >
                    <div style={{ display: "flex", gap: "12px", alignItems: "center" }}>
                      <span style={{ fontSize: "1.5rem" }}>{role.icon || "🎭"}</span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <span style={{ fontWeight: "600", fontSize: "0.9rem" }}>{role.title}</span>
                        {role.description ? (
                          <div style={{ fontSize: "0.75rem", color: "#6b7280" }}>
                            {role.description}
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
            placeholder="Add a role (e.g., Parent, Employee, Friend...)"
            style={{ width: "100%" }}
            onct-send={(e: { detail?: { message?: string } }) => {
              const title = e.detail?.message?.trim();
              if (title) {
                addRole.send({ title });
              }
            }}
          />
        </div>
      </ct-screen>
    ),
    roles,
    activeRoles,
    roleCount,
    addRole,
    updateRole,
    archiveRole,
    restoreRole,
    deleteRole,
  };
});
