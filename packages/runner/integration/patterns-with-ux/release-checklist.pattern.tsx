/// <cts-enable />
// @ts-nocheck
import {
  type Cell,
  cell,
  Default,
  h,
  handler,
  lift,
  NAME,
  recipe,
  str,
  UI,
} from "commontools";

type ReleaseTaskStatus = "pending" | "in_progress" | "blocked" | "done";

interface ReleaseTask {
  id: string;
  label: string;
  required: boolean;
  status: ReleaseTaskStatus;
  owner: string | null;
  note: string | null;
}

interface ReleaseChecklistArgs {
  tasks: Default<ReleaseTask[], typeof defaultTasks>;
}

interface TaskProgressEvent {
  id?: string;
  status?: string;
  owner?: string | null;
  note?: string | null;
}

interface ReleaseChecklistStats {
  total: number;
  requiredTotal: number;
  completedRequired: number;
  completedTotal: number;
  blocked: string[];
  pendingRequired: string[];
  ready: boolean;
}

const statusValues: ReleaseTaskStatus[] = [
  "pending",
  "in_progress",
  "blocked",
  "done",
];

const statusSet = new Set<ReleaseTaskStatus>(statusValues);

const defaultTasks: ReleaseTask[] = [
  {
    id: "qa-signoff",
    label: "QA Sign-off",
    required: true,
    status: "pending",
    owner: "Jordan Patel",
    note: null,
  },
  {
    id: "documentation",
    label: "Documentation Updated",
    required: true,
    status: "pending",
    owner: "Avery Fox",
    note: null,
  },
  {
    id: "ops-runbook",
    label: "Operations Runbook",
    required: true,
    status: "pending",
    owner: "Taylor Young",
    note: null,
  },
  {
    id: "marketing-review",
    label: "Marketing Review",
    required: false,
    status: "pending",
    owner: null,
    note: null,
  },
];

const cloneTask = (task: ReleaseTask): ReleaseTask => ({
  id: task.id,
  label: task.label,
  required: task.required,
  status: task.status,
  owner: task.owner ?? null,
  note: task.note ?? null,
});

const cloneTasks = (entries: readonly ReleaseTask[]): ReleaseTask[] =>
  entries.map((entry) => cloneTask(entry));

const taskEquals = (left: ReleaseTask, right: ReleaseTask): boolean =>
  left.id === right.id &&
  left.label === right.label &&
  left.required === right.required &&
  left.status === right.status &&
  (left.owner ?? null) === right.owner &&
  (left.note ?? null) === right.note;

const listsEqual = (
  current: unknown,
  sanitized: ReleaseTask[],
): current is ReleaseTask[] => {
  if (!Array.isArray(current) || current.length !== sanitized.length) {
    return false;
  }
  for (let index = 0; index < sanitized.length; index++) {
    if (!taskEquals(current[index] as ReleaseTask, sanitized[index])) {
      return false;
    }
  }
  return true;
};

const toOptionalString = (value: unknown): string | null => {
  if (value === null) return null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const toStatus = (value: unknown): ReleaseTaskStatus | null => {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return statusSet.has(normalized as ReleaseTaskStatus)
    ? normalized as ReleaseTaskStatus
    : null;
};

const toLabel = (id: string, label: unknown): string => {
  if (typeof label === "string") {
    const trimmed = label.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return id
    .split(/[-_]/g)
    .filter((part) => part.length > 0)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(" ");
};

const sanitizeTask = (value: unknown): ReleaseTask | null => {
  if (typeof value !== "object" || value === null) return null;
  const input = value as {
    id?: unknown;
    label?: unknown;
    required?: unknown;
    status?: unknown;
    owner?: unknown;
    note?: unknown;
  };
  const rawId = typeof input.id === "string" ? input.id.trim() : "";
  if (rawId.length === 0) return null;
  const id = rawId;
  const label = toLabel(id, input.label);
  const required = typeof input.required === "boolean" ? input.required : true;
  const status = toStatus(input.status) ?? "pending";
  const owner = toOptionalString(input.owner);
  const note = toOptionalString(input.note);
  return { id, label, required, status, owner, note };
};

const compareTasks = (left: ReleaseTask, right: ReleaseTask): number => {
  if (left.required !== right.required) {
    return left.required ? -1 : 1;
  }
  const byLabel = left.label.localeCompare(right.label);
  if (byLabel !== 0) return byLabel;
  return left.id.localeCompare(right.id);
};

const sanitizeTaskList = (value: unknown): ReleaseTask[] => {
  if (!Array.isArray(value)) {
    return cloneTasks(defaultTasks);
  }
  const seen = new Set<string>();
  const sanitized: ReleaseTask[] = [];
  for (const entry of value) {
    const task = sanitizeTask(entry);
    if (!task) continue;
    if (seen.has(task.id)) continue;
    seen.add(task.id);
    sanitized.push(task);
  }
  if (sanitized.length === 0) {
    return cloneTasks(defaultTasks);
  }
  sanitized.sort(compareTasks);
  return sanitized;
};

const ensureTaskList = (source: Cell<ReleaseTask[]>): ReleaseTask[] => {
  const current = source.get();
  const sanitized = sanitizeTaskList(current);
  if (!listsEqual(current, sanitized)) {
    source.set(sanitized);
    return sanitized;
  }
  return Array.isArray(current) ? current : sanitized;
};

const analyzeTasks = (tasks: ReleaseTask[]): ReleaseChecklistStats => {
  const blocked: string[] = [];
  const pendingRequired: string[] = [];
  let requiredTotal = 0;
  let completedRequired = 0;
  let completedTotal = 0;

  for (const task of tasks) {
    if (task.status === "blocked") {
      blocked.push(task.label);
    }
    if (task.status === "done") {
      completedTotal++;
    }
    if (task.required) {
      requiredTotal++;
      if (task.status === "done") {
        completedRequired++;
      } else {
        pendingRequired.push(task.label);
      }
    }
  }

  const ready = blocked.length === 0 && pendingRequired.length === 0;

  return {
    total: tasks.length,
    requiredTotal,
    completedRequired,
    completedTotal,
    blocked,
    pendingRequired,
    ready,
  };
};

const describeGating = (stats: ReleaseChecklistStats): string => {
  if (stats.ready) {
    return "All checks complete";
  }
  const segments: string[] = [];
  if (stats.blocked.length > 0) {
    segments.push(`Blocked: ${stats.blocked.join(", ")}`);
  }
  if (stats.pendingRequired.length > 0) {
    segments.push(`Pending: ${stats.pendingRequired.join(", ")}`);
  }
  return segments.join(" | ") || "Pending";
};

const updateTaskProgress = handler(
  (
    event: TaskProgressEvent | undefined,
    context: { tasks: Cell<ReleaseTask[]> },
  ) => {
    const id = typeof event?.id === "string" ? event.id.trim() : "";
    if (id.length === 0) return;

    const tasks = ensureTaskList(context.tasks);
    const index = tasks.findIndex((task) => task.id === id);
    if (index === -1) return;

    const status = toStatus(event?.status) ?? undefined;
    const ownerValue = event?.owner;
    const noteValue = event?.note;
    const owner = ownerValue === undefined
      ? undefined
      : toOptionalString(ownerValue);
    const note = noteValue === undefined
      ? undefined
      : toOptionalString(noteValue);

    const next = tasks.slice();
    const current = next[index];
    next[index] = {
      id: current.id,
      label: current.label,
      required: current.required,
      status: status ?? current.status,
      owner: owner === undefined ? current.owner : owner,
      note: note === undefined ? current.note : note,
    };

    context.tasks.set(next);
  },
);

export const releaseChecklistUx = recipe<ReleaseChecklistArgs>(
  "Release Checklist (UX)",
  ({ tasks }) => {
    const sanitizedTasks = lift(sanitizeTaskList)(tasks);
    const stats = lift(analyzeTasks)(sanitizedTasks);
    const readyFlag = lift((info: ReleaseChecklistStats) => info.ready)(stats);
    const status = lift((info: ReleaseChecklistStats) => {
      if (info.ready) return "ready";
      if (info.blocked.length > 0) return "blocked";
      return "pending";
    })(stats);
    const statusCaps = lift((value: string) => value.toUpperCase())(status);
    const requiredTotal = lift((info: ReleaseChecklistStats) =>
      info.requiredTotal
    )(stats);
    const completedRequired = lift((info: ReleaseChecklistStats) =>
      info.completedRequired
    )(stats);
    const completedTotal = lift((info: ReleaseChecklistStats) =>
      info.completedTotal
    )(stats);
    const totalTasks = lift((info: ReleaseChecklistStats) => info.total)(stats);
    const gatingNote = lift(describeGating)(stats);

    const summary =
      str`${completedRequired}/${requiredTotal} required complete`;
    const headline =
      str`${statusCaps} • ${completedTotal}/${totalTasks} tasks done`;

    const updateTask = updateTaskProgress({ tasks });

    // UI form fields
    const taskIdField = cell<string>("");
    const statusField = cell<string>("");
    const ownerField = cell<string>("");
    const noteField = cell<string>("");

    // UI handler to update task from form fields
    const applyTaskUpdate = handler(
      (_event: unknown, context: {
        tasks: Cell<ReleaseTask[]>;
        taskId: Cell<string>;
        statusVal: Cell<string>;
        ownerVal: Cell<string>;
        noteVal: Cell<string>;
      }) => {
        const id = toOptionalString(context.taskId.get());
        if (!id) return;

        const taskList = ensureTaskList(context.tasks);
        const index = taskList.findIndex((task) => task.id === id);
        if (index === -1) return;

        const statusStr = context.statusVal.get();
        const ownerStr = context.ownerVal.get();
        const noteStr = context.noteVal.get();

        const status = typeof statusStr === "string" && statusStr.trim() !== ""
          ? toStatus(statusStr)
          : undefined;
        const owner = typeof ownerStr === "string" && ownerStr.trim() !== ""
          ? toOptionalString(ownerStr)
          : undefined;
        const note = typeof noteStr === "string" && noteStr.trim() !== ""
          ? toOptionalString(noteStr)
          : undefined;

        const next = taskList.slice();
        const current = next[index];
        next[index] = {
          id: current.id,
          label: current.label,
          required: current.required,
          status: status ?? current.status,
          owner: owner === undefined ? current.owner : owner,
          note: note === undefined ? current.note : note,
        };

        context.tasks.set(next);

        // Clear form fields after successful update
        context.taskId.set("");
        context.statusVal.set("");
        context.ownerVal.set("");
        context.noteVal.set("");
      },
    );

    const updateHandler = applyTaskUpdate({
      tasks,
      taskId: taskIdField,
      statusVal: statusField,
      ownerVal: ownerField,
      noteVal: noteField,
    });

    // Status indicator styles
    const statusColor = lift((st: string) => {
      if (st === "ready") return "#10b981";
      if (st === "blocked") return "#ef4444";
      return "#f59e0b";
    })(status);

    const statusBg = lift((st: string) => {
      if (st === "ready") return "#d1fae5";
      if (st === "blocked") return "#fee2e2";
      return "#fef3c7";
    })(status);

    const progressPercent = lift((stats: ReleaseChecklistStats) => {
      if (stats.requiredTotal === 0) return 100;
      return Math.round(
        (stats.completedRequired / stats.requiredTotal) * 100,
      );
    })(stats);

    // Render task cards
    const tasksDisplay = lift((taskList: ReleaseTask[]) => {
      const cards = [];
      for (const task of taskList) {
        const statusColor = task.status === "done"
          ? "#10b981"
          : task.status === "blocked"
          ? "#ef4444"
          : task.status === "in_progress"
          ? "#3b82f6"
          : "#94a3b8";

        const statusBg = task.status === "done"
          ? "#d1fae5"
          : task.status === "blocked"
          ? "#fee2e2"
          : task.status === "in_progress"
          ? "#dbeafe"
          : "#f1f5f9";

        const statusLabel = task.status === "done"
          ? "DONE"
          : task.status === "blocked"
          ? "BLOCKED"
          : task.status === "in_progress"
          ? "IN PROGRESS"
          : "PENDING";

        const borderColor = task.required ? "#6366f1" : "#94a3b8";

        const cardStyle = "background: #ffffff; border: 2px solid " +
          borderColor +
          "; border-radius: 8px; padding: 16px; margin-bottom: 12px;";

        const headerStyle =
          "display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px;";

        const titleStyle = "font-size: 16px; font-weight: 600; color: #1e293b;";

        const badgeContainerStyle =
          "display: flex; align-items: center; gap: 8px;";

        const requiredBadgeStyle = "background: " +
          (task.required ? "#eef2ff" : "#f1f5f9") +
          "; color: " + (task.required ? "#4f46e5" : "#64748b") +
          "; padding: 4px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; text-transform: uppercase;";

        const statusBadgeStyle = "background: " + statusBg + "; color: " +
          statusColor +
          "; padding: 4px 8px; border-radius: 4px; font-size: 11px; font-weight: 600;";

        const detailStyle = "font-size: 13px; color: #64748b; margin-top: 8px;";

        const idStyle =
          "font-family: monospace; font-size: 12px; color: #94a3b8; margin-top: 4px;";

        cards.push(
          h("div", { style: cardStyle }, [
            h("div", { style: headerStyle }, [
              h("div", { style: titleStyle }, task.label),
              h("div", { style: badgeContainerStyle }, [
                h(
                  "span",
                  { style: requiredBadgeStyle },
                  task.required ? "Required" : "Optional",
                ),
                h("span", { style: statusBadgeStyle }, statusLabel),
              ]),
            ]),
            task.owner
              ? h("div", { style: detailStyle }, "Owner: " + task.owner)
              : null,
            task.note
              ? h(
                "div",
                { style: detailStyle },
                "Note: " + task.note,
              )
              : null,
            h("div", { style: idStyle }, "ID: " + task.id),
          ]),
        );
      }
      return h("div", {}, ...cards);
    })(sanitizedTasks);

    const name = str`Release Checklist • ${summary}`;

    const ui = (
      <div
        style={{
          fontFamily:
            "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
          maxWidth: "800px",
          margin: "0 auto",
          padding: "24px",
          background: "#f8fafc",
        }}
      >
        <div
          style={{
            background: "linear-gradient(135deg, #667eea 0%, #764ba2 100%)",
            borderRadius: "12px",
            padding: "32px",
            marginBottom: "24px",
            color: "#ffffff",
          }}
        >
          <h1
            style={{
              margin: "0 0 16px 0",
              fontSize: "32px",
              fontWeight: "700",
            }}
          >
            Release Checklist
          </h1>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "12px",
              marginBottom: "16px",
            }}
          >
            <div
              style={lift((bg: string, color: string) =>
                "background: " + bg + "; color: " + color +
                "; padding: 8px 16px; border-radius: 8px; font-size: 18px; font-weight: 700;"
              )(statusBg, statusColor)}
            >
              {statusCaps}
            </div>
            <div style={{ fontSize: "18px", fontWeight: "600" }}>
              {completedTotal}/{totalTasks} tasks complete
            </div>
          </div>
          <div
            style={{
              background: "rgba(255,255,255,0.2)",
              borderRadius: "8px",
              height: "24px",
              overflow: "hidden",
            }}
          >
            <div
              style={lift((pct: number) =>
                "background: #ffffff; height: 100%; width: " + String(pct) +
                "%; transition: width 0.3s;"
              )(progressPercent)}
            >
            </div>
          </div>
          <div style={{ marginTop: "12px", fontSize: "15px", opacity: "0.9" }}>
            {gatingNote}
          </div>
        </div>

        <ct-card style={{ marginBottom: "24px" }}>
          <h2 style={{ margin: "0 0 16px 0", fontSize: "20px" }}>Tasks</h2>
          {tasksDisplay}
        </ct-card>

        <ct-card>
          <h2 style={{ margin: "0 0 16px 0", fontSize: "20px" }}>
            Update Task
          </h2>
          <div style={{ display: "grid", gap: "12px" }}>
            <div>
              <label
                style={{
                  display: "block",
                  fontSize: "13px",
                  fontWeight: "600",
                  marginBottom: "4px",
                  color: "#475569",
                }}
              >
                Task ID
              </label>
              <ct-input
                $value={taskIdField}
                placeholder="e.g., qa-signoff"
                style={{ width: "100%" }}
              />
            </div>
            <div>
              <label
                style={{
                  display: "block",
                  fontSize: "13px",
                  fontWeight: "600",
                  marginBottom: "4px",
                  color: "#475569",
                }}
              >
                Status (pending, in_progress, blocked, done)
              </label>
              <ct-input
                $value={statusField}
                placeholder="e.g., done"
                style={{ width: "100%" }}
              />
            </div>
            <div>
              <label
                style={{
                  display: "block",
                  fontSize: "13px",
                  fontWeight: "600",
                  marginBottom: "4px",
                  color: "#475569",
                }}
              >
                Owner (optional)
              </label>
              <ct-input
                $value={ownerField}
                placeholder="e.g., Jordan Patel"
                style={{ width: "100%" }}
              />
            </div>
            <div>
              <label
                style={{
                  display: "block",
                  fontSize: "13px",
                  fontWeight: "600",
                  marginBottom: "4px",
                  color: "#475569",
                }}
              >
                Note (optional)
              </label>
              <ct-input
                $value={noteField}
                placeholder="e.g., Waiting for final approval"
                style={{ width: "100%" }}
              />
            </div>
            <ct-button onClick={updateHandler} style={{ marginTop: "8px" }}>
              Update Task
            </ct-button>
          </div>
        </ct-card>
      </div>
    );

    return {
      [NAME]: name,
      [UI]: ui,
      tasks: sanitizedTasks,
      ready: readyFlag,
      status,
      headline,
      summary,
      gatingNote,
      requiredTotal,
      completedRequired,
      completedTotal,
      updateTask,
    };
  },
);

export type { ReleaseTask };
