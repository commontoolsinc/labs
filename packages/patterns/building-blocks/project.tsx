/// <cts-enable />
/**
 * Project - Multi-Task Container with Outcome (GTD/PARA)
 *
 * A project is any outcome requiring more than one task.
 * It's a container, not a big task.
 *
 * Key distinction: Projects have completion states.
 * They answer: "What do I want to complete?"
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
  type Project,
  type ProjectStatus,
} from "./schemas.tsx";

// =============================================================================
// TYPES
// =============================================================================

interface Input {
  projects?: Writable<Default<Project[], []>>;
}

interface Output {
  [NAME]: string;
  [UI]: VNode;
  projects: Project[];
  activeProjects: Project[];
  projectCount: number;
  addProject: Stream<{ title: string; description?: string; targetDate?: string }>;
  updateProject: Stream<{ id: string; updates: Partial<Project> }>;
  setStatus: Stream<{ id: string; status: ProjectStatus }>;
  deleteProject: Stream<{ id: string }>;
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

function getStatusIcon(status: ProjectStatus | undefined): string {
  switch (status) {
    case "active":
      return "🚀";
    case "on-hold":
      return "⏸️";
    case "someday":
      return "💭";
    case "done":
      return "✅";
    case "archived":
      return "📦";
    default:
      return "🚀";
  }
}

function getStatusColor(status: ProjectStatus | undefined): string {
  switch (status) {
    case "active":
      return "#22c55e";
    case "on-hold":
      return "#eab308";
    case "someday":
      return "#3b82f6";
    case "done":
      return "#9ca3af";
    case "archived":
      return "#d1d5db";
    default:
      return "#22c55e";
  }
}

function isOverdue(project: Project): boolean {
  if (!project.targetDate || project.status === "done") return false;
  return new Date(project.targetDate) < new Date();
}

// =============================================================================
// PATTERN
// =============================================================================

export default pattern<Input, Output>(({ projects }) => {
  // ---------------------------------------------------------------------------
  // Computed Values
  // ---------------------------------------------------------------------------

  const activeProjects = computed(() =>
    projects.get().filter((p) => p.status !== "archived" && p.status !== "done")
  );

  const projectCount = computed(() => activeProjects.length);

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  const addProject = action(
    ({
      title,
      description,
      targetDate,
    }: { title: string; description?: string; targetDate?: string }) => {
      const trimmed = title.trim();
      if (!trimmed) return;

      const newProject: Project = {
        id: generateId(),
        title: trimmed,
        description,
        targetDate,
        status: "active",
        createdAt: now(),
        modifiedAt: now(),
      };

      projects.set([...projects.get(), newProject]);
    }
  );

  const updateProject = action(
    ({ id, updates }: { id: string; updates: Partial<Project> }) => {
      const index = projects.get().findIndex((p) => p.id === id);
      if (index === -1) return;
      const current = projects.get()[index];
      const updated = { ...current, ...updates, modifiedAt: now() };
      if (updates.status === "done" && !current.completedAt) {
        updated.completedAt = now();
      }
      projects.set(projects.get().toSpliced(index, 1, updated));
    }
  );

  const setStatus = action(
    ({ id, status }: { id: string; status: ProjectStatus }) => {
      updateProject.send({ id, updates: { status } });
    }
  );

  const deleteProject = action(({ id }: { id: string }) => {
    const index = projects.get().findIndex((p) => p.id === id);
    if (index !== -1) {
      projects.set(projects.get().toSpliced(index, 1));
    }
  });

  // ---------------------------------------------------------------------------
  // Local UI State
  // ---------------------------------------------------------------------------

  const showCompleted = Writable.of<boolean>(false);
  const showEditModal = Writable.of<boolean>(false);
  const editingId = Writable.of<string>("");
  const editTitle = Writable.of<string>("");
  const editNotes = Writable.of<string>("");
  const notesExpanded = Writable.of<boolean>(false);
  const editTargetDate = Writable.of<string>("");
  const editStatus = Writable.of<string>("");

  const openEditModal = action(({ project }: { project: Project }) => {
    editingId.set(project.id);
    editTitle.set(project.title || "");
    editNotes.set(project.description || "");
    notesExpanded.set(false);
    editTargetDate.set(project.targetDate || "");
    editStatus.set(project.status || "active");
    showEditModal.set(true);
  });

  const saveEdit = action((_: void) => {
    const id = editingId.get();
    if (!id) return;
    updateProject.send({
      id,
      updates: {
        title: editTitle.get().trim() || undefined,
        description: editNotes.get().trim() || undefined,
        targetDate: editTargetDate.get().trim() || undefined,
        status: (editStatus.get() as ProjectStatus) || "active",
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
      deleteProject.send({ id });
    }
    showEditModal.set(false);
    editingId.set("");
  });

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return {
    [NAME]: computed(() => `Projects (${projectCount})`),
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
            <span style={{ fontWeight: "600", fontSize: "1.1rem" }}>Projects</span>
            <span style={{ fontSize: "0.75rem", color: "#6b7280" }}>
              ({projectCount} active)
            </span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "4px" }}>
            <ct-checkbox $checked={showCompleted} />
            <span style={{ fontSize: "0.75rem" }}>Show completed</span>
          </div>
        </div>

        {/* Edit Modal */}
        <ct-modal $open={showEditModal} dismissable size="sm" label="Edit Project">
          <span slot="header">Edit Project</span>
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
                  <label style={STYLES.label}>Target Date</label>
                  <ct-input $value={editTargetDate} placeholder="YYYY-MM-DD" style={{ width: "100%" }} />
                </div>
                <div>
                  <label style={STYLES.label}>Status</label>
                  <div style={{ display: "flex", gap: "4px", flexWrap: "wrap" }}>
                    {(["active", "on-hold", "someday", "done"] as const).map((status) => (
                      <button
                        type="button"
                        style={{
                          ...STYLES.button.base,
                          backgroundColor: computed(() => editStatus.get() === status ? "#3b82f6" : "#fff"),
                          color: computed(() => editStatus.get() === status ? "#fff" : "#374151"),
                          borderColor: computed(() => editStatus.get() === status ? "#3b82f6" : "#d1d5db"),
                        }}
                        onClick={() => editStatus.set(status)}
                      >
                        {getStatusIcon(status)} {status}
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
                const project = projects.get().find((p) => p.id === currentId);
                if (project?.status === "archived") {
                  setStatus.send({ id: currentId, status: "active" });
                } else {
                  setStatus.send({ id: currentId, status: "archived" });
                }
                closeEditModal.send();
              }}
            >
              {computed(() => {
                const currentId = editingId.get();
                const project = projects.get().find((p) => p.id === currentId);
                return project?.status === "archived" ? "Restore" : "Archive";
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
              const projectsToShow = showCompleted.get() ? projects.get() : activeProjects;

              if (projectsToShow.length === 0) {
                return (
                  <div style={{ textAlign: "center", color: "#6b7280", padding: "32px", fontSize: "0.875rem" }}>
                    No projects yet. Projects are outcomes requiring multiple tasks.
                  </div>
                );
              }

              return projectsToShow.map((project: Project) => {
                const overdue = isOverdue(project);
                const isDone = project.status === "done";
                const isArchived = project.status === "archived";

                return (
                  <div
                    style={{
                      ...STYLES.card,
                      borderLeft: `4px solid ${getStatusColor(project.status)}`,
                      opacity: isDone || isArchived ? 0.6 : 1,
                      backgroundColor: overdue ? "#fef2f2" : "#fff",
                      cursor: "pointer",
                    }}
                    onClick={() => openEditModal.send({ project })}
                  >
                    <div style={{ display: "flex", gap: "12px", alignItems: "flex-start" }}>
                      <span style={{ fontSize: "1.25rem" }}>
                        {getStatusIcon(project.status)}
                      </span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "4px" }}>
                          <span style={{ fontWeight: "600", fontSize: "0.9rem", textDecoration: isDone ? "line-through" : "none" }}>
                            {project.title}
                          </span>
                          <span style={STYLES.tag}>{project.status || "active"}</span>
                        </div>

                        {project.description ? (
                          <div style={{ fontSize: "0.75rem", color: "#6b7280", marginBottom: "4px" }}>
                            {project.description}
                          </div>
                        ) : null}

                        <div style={{ display: "flex", gap: "8px" }}>
                          {project.targetDate ? (
                            <span style={{ fontSize: "0.65rem", padding: "2px 6px", borderRadius: "4px", backgroundColor: overdue ? "#fee2e2" : "#f3f4f6", color: overdue ? "#dc2626" : "#6b7280" }}>
                              📅 {project.targetDate}
                            </span>
                          ) : null}
                        </div>
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
            placeholder="Add a project (desired outcome, e.g., 'Kitchen renovated'...)"
            style={{ width: "100%" }}
            onct-send={(e: { detail?: { message?: string } }) => {
              const title = e.detail?.message?.trim();
              if (title) {
                addProject.send({ title });
              }
            }}
          />
        </div>
      </ct-screen>
    ),
    projects,
    activeProjects,
    projectCount,
    addProject,
    updateProject,
    setStatus,
    deleteProject,
  };
});
