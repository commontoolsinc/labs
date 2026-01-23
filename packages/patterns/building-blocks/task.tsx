/// <cts-enable />
/**
 * Task - Atomic Action (GTD Next Action)
 *
 * A task is a single, concrete action that can be done in one session.
 * This is the fundamental unit of work.
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
  isOverdue,
  now,
  type Person,
  type Project,
  type Role,
  type Task,
  type TaskStatus,
} from "./schemas.tsx";

// =============================================================================
// TYPES
// =============================================================================

interface Input {
  tasks?: Writable<Default<Task[], []>>;
  persons?: Default<Person[], []>;
  projects?: Default<Project[], []>;
  roles?: Default<Role[], []>;
}

interface Output {
  [NAME]: string;
  [UI]: VNode;
  tasks: Task[];
  taskCount: number;
  addTask: Stream<{ title: string; status?: TaskStatus; personId?: string; projectId?: string; roleId?: string }>;
  updateTask: Stream<{ id: string; updates: Partial<Task> }>;
  setStatus: Stream<{ id: string; status: TaskStatus }>;
  completeTask: Stream<{ id: string }>;
  deleteTask: Stream<{ id: string }>;
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

function getStatusIcon(status: TaskStatus | undefined): string {
  switch (status) {
    case "inbox": return "📥";
    case "next": return "⚡";
    case "waiting": return "⏳";
    case "someday": return "💭";
    case "done": return "✅";
    case "archived": return "📦";
    default: return "📥";
  }
}

function getStatusLabel(status: string): string {
  switch (status) {
    case "inbox": return "Inbox";
    case "next": return "Next";
    case "waiting": return "Waiting";
    case "someday": return "Someday";
    case "done": return "Done";
    case "archived": return "Archived";
    default: return "Inbox";
  }
}

function getStatusColor(status: TaskStatus | undefined): string {
  switch (status) {
    case "inbox": return "#eab308";
    case "next": return "#22c55e";
    case "waiting": return "#f97316";
    case "someday": return "#3b82f6";
    case "done": return "#9ca3af";
    case "archived": return "#d1d5db";
    default: return "#eab308";
  }
}

// =============================================================================
// PATTERN
// =============================================================================

export default pattern<Input, Output>(({ tasks, persons, projects, roles }) => {
  // ---------------------------------------------------------------------------
  // Computed Values
  // ---------------------------------------------------------------------------

  const taskCount = computed(() =>
    tasks.get().filter((t) => t.status !== "done" && t.status !== "archived").length
  );

  // Pre-computed filtered tasks based on current view
  // This is outside the render to ensure proper reactivity
  const currentView = Writable.of<string>("inbox");

  const filteredTasks = computed(() => {
    const view = currentView.get();
    const allTasks = tasks.get();
    return allTasks.filter((t) => (t.status || "inbox") === view);
  });

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  const addTask = action(
    ({ title, status, personId, projectId, roleId }: { title: string; status?: TaskStatus; personId?: string; projectId?: string; roleId?: string }) => {
      const trimmed = title.trim();
      if (!trimmed) return;

      const newTask: Task = {
        id: generateId(),
        title: trimmed,
        status: status || "inbox",
        createdAt: now(),
        modifiedAt: now(),
        delegatedToId: personId,
        projectId: projectId,
        roleId: roleId,
      };

      tasks.set([...tasks.get(), newTask]);
    }
  );

  const updateTask = action(
    ({ id, updates }: { id: string; updates: Partial<Task> }) => {
      const index = tasks.get().findIndex((t) => t.id === id);
      if (index === -1) return;
      const current = tasks.get()[index];
      const updated = { ...current, ...updates, modifiedAt: now() };
      if (updates.status === "done" && !current.completedAt) {
        updated.completedAt = now();
      }
      tasks.set(tasks.get().toSpliced(index, 1, updated));
    }
  );

  const setStatus = action(
    ({ id, status }: { id: string; status: TaskStatus }) => {
      updateTask.send({ id, updates: { status } });
    }
  );

  const completeTask = action(({ id }: { id: string }) => {
    setStatus.send({ id, status: "done" });
  });

  const deleteTask = action(({ id }: { id: string }) => {
    const index = tasks.get().findIndex((t) => t.id === id);
    if (index !== -1) {
      tasks.set(tasks.get().toSpliced(index, 1));
    }
  });

  // ---------------------------------------------------------------------------
  // Local UI State
  // ---------------------------------------------------------------------------

  const showEditModal = Writable.of<boolean>(false);
  const editingId = Writable.of<string>("");
  const editTitle = Writable.of<string>("");
  const editNotes = Writable.of<string>("");
  const notesExpanded = Writable.of<boolean>(false);
  const editStatus = Writable.of<string>("");
  const editDueAt = Writable.of<string>("");

  const openEditModal = action(({ task }: { task: Task }) => {
    editingId.set(task.id);
    editTitle.set(task.title || "");
    editNotes.set(task.description || "");
    notesExpanded.set(false);
    editStatus.set(task.status || "inbox");
    editDueAt.set(task.dueAt || "");
    showEditModal.set(true);
  });

  const saveEdit = action((_: void) => {
    const id = editingId.get();
    if (!id) return;
    updateTask.send({
      id,
      updates: {
        title: editTitle.get().trim() || undefined,
        description: editNotes.get().trim() || undefined,
        status: (editStatus.get() as TaskStatus) || "inbox",
        dueAt: editDueAt.get().trim() || undefined,
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
      deleteTask.send({ id });
    }
    showEditModal.set(false);
    editingId.set("");
  });

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return {
    [NAME]: computed(() => `Tasks (${taskCount})`),
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
            <span style={{ fontWeight: "600", fontSize: "1.1rem" }}>Tasks</span>
            <span style={{ fontSize: "0.75rem", color: "#6b7280" }}>
              ({taskCount} active)
            </span>
          </div>

          {/* GTD List Tabs */}
          <div style={{ display: "flex", gap: "4px", overflowX: "auto", paddingBottom: "4px" }}>
            {["inbox", "next", "waiting", "someday", "done"].map((status) => (
              <button
                type="button"
                style={{
                  ...STYLES.button.base,
                  backgroundColor: computed(() => currentView.get() === status ? "#3b82f6" : "#fff"),
                  color: computed(() => currentView.get() === status ? "#fff" : "#374151"),
                  borderColor: computed(() => currentView.get() === status ? "#3b82f6" : "#d1d5db"),
                }}
                onClick={() => currentView.set(status)}
              >
                {getStatusIcon(status as TaskStatus)} {getStatusLabel(status)} ({computed(() => tasks.get().filter((t) => (t.status || "inbox") === status).length)})
              </button>
            ))}
          </div>
        </div>

        {/* Edit Modal */}
        <ct-modal $open={showEditModal} dismissable size="sm" label="Edit Task">
          <span slot="header">Edit Task</span>
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
                  <label style={STYLES.label}>Status</label>
                  <div style={{ display: "flex", gap: "4px", flexWrap: "wrap" }}>
                    {(["inbox", "next", "waiting", "someday", "done"] as const).map((status) => (
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
                        {getStatusIcon(status)} {getStatusLabel(status)}
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <label style={STYLES.label}>Due Date</label>
                  <ct-input $value={editDueAt} placeholder="YYYY-MM-DD" style={{ width: "100%" }} />
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
                const task = tasks.get().find((t) => t.id === currentId);
                if (task?.status === "archived") {
                  setStatus.send({ id: currentId, status: "inbox" });
                } else {
                  setStatus.send({ id: currentId, status: "archived" });
                }
                closeEditModal.send();
              }}
            >
              {computed(() => {
                const currentId = editingId.get();
                const task = tasks.get().find((t) => t.id === currentId);
                return task?.status === "archived" ? "Restore" : "Archive";
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
              const view = currentView.get();
              const tasksToShow = filteredTasks;

              if (tasksToShow.length === 0) {
                return (
                  <div style={{ textAlign: "center", color: "#6b7280", padding: "32px", fontSize: "0.875rem" }}>
                    No tasks in {getStatusLabel(view)}.
                    {view !== "done" ? " Add tasks below." : ""}
                  </div>
                );
              }

              return tasksToShow.map((task: Task) => {
                const overdue = isOverdue(task);
                const isDone = task.status === "done";

                return (
                  <div
                    style={{
                      ...STYLES.card,
                      borderLeft: `4px solid ${getStatusColor(task.status)}`,
                      opacity: isDone ? 0.6 : 1,
                      backgroundColor: overdue ? "#fef2f2" : "#fff",
                      cursor: "pointer",
                    }}
                    onClick={() => openEditModal.send({ task })}
                  >
                    <div style={{ display: "flex", gap: "12px", alignItems: "flex-start" }}>
                      <input
                        type="checkbox"
                        checked={isDone}
                        onChange={() =>
                          isDone
                            ? setStatus.send({ id: task.id, status: "next" })
                            : completeTask.send({ id: task.id })}
                        style={{ cursor: "pointer", width: "16px", height: "16px" }}
                      />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "4px" }}>
                          <span style={{ fontWeight: "500", fontSize: "0.9rem", textDecoration: isDone ? "line-through" : "none", color: isDone ? "#9ca3af" : "#111827" }}>
                            {task.title}
                          </span>
                        </div>

                        {task.description ? (
                          <div style={{ fontSize: "0.75rem", color: "#6b7280", marginBottom: "4px" }}>
                            {task.description}
                          </div>
                        ) : null}

                        <div style={{ display: "flex", gap: "4px", flexWrap: "wrap" }}>
                          {task.dueAt ? (
                            <span style={{ fontSize: "0.65rem", padding: "2px 6px", borderRadius: "4px", backgroundColor: overdue ? "#fee2e2" : "#f3f4f6", color: overdue ? "#dc2626" : "#6b7280" }}>
                              📅 {task.dueAt}
                            </span>
                          ) : null}
                          {task.delegatedToId ? (
                            <span style={{ fontSize: "0.65rem", backgroundColor: "#f3e8ff", color: "#7c3aed", padding: "2px 6px", borderRadius: "4px" }}>
                              👤 {persons.find((p) => p.id === task.delegatedToId)?.name || "Person"}
                            </span>
                          ) : null}
                          {task.projectId ? (
                            <span style={{ fontSize: "0.65rem", backgroundColor: "#dcfce7", color: "#16a34a", padding: "2px 6px", borderRadius: "4px" }}>
                              📁 {projects.find((p) => p.id === task.projectId)?.title || "Project"}
                            </span>
                          ) : null}
                          {task.roleId ? (
                            <span style={{ fontSize: "0.65rem", backgroundColor: "#e0e7ff", color: "#4f46e5", padding: "2px 6px", borderRadius: "4px" }}>
                              🎭 {roles.find((r) => r.id === task.roleId)?.title || "Role"}
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
            placeholder={computed(() => `Add task to ${getStatusLabel(currentView.get())}...`)}
            style={{ width: "100%" }}
            onct-send={(e: { detail?: { message?: string } }) => {
              const title = e.detail?.message?.trim();
              if (title) {
                const view = currentView.get();
                const status = view === "done" ? "inbox" : view as TaskStatus;
                addTask.send({ title, status });
              }
            }}
          />
        </div>
      </ct-screen>
    ),
    tasks,
    taskCount,
    addTask,
    updateTask,
    setStatus,
    completeTask,
    deleteTask,
  };
});
