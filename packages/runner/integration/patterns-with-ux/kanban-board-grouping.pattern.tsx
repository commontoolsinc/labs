/// <cts-enable />
import {
  type Cell,
  cell,
  compute,
  Default,
  h,
  handler,
  lift,
  NAME,
  recipe,
  str,
  UI,
} from "commontools";

const columnOrder = [
  "backlog",
  "inProgress",
  "review",
  "done",
] as const;

type ColumnKey = (typeof columnOrder)[number];

interface KanbanTaskInput {
  id?: string;
  title?: string;
  column?: string;
  points?: number;
}

interface KanbanTask extends KanbanTaskInput {
  id: string;
  title: string;
  column: ColumnKey;
  points: number;
}

interface KanbanBoardArgs {
  tasks: Default<KanbanTaskInput[], typeof defaultTasks>;
  wipLimits: Default<Record<ColumnKey, number>, typeof defaultWipLimits>;
}

interface MoveTaskEvent {
  id?: string;
  taskId?: string;
  to?: string;
  column?: string;
}

interface LimitUpdateEvent {
  column?: string;
  limit?: number;
  value?: number;
}

interface ColumnSummary {
  key: ColumnKey;
  title: string;
  limit: number;
  count: number;
  overloaded: boolean;
  items: KanbanTask[];
}

interface MoveRecord {
  taskId: string;
  from: ColumnKey;
  to: ColumnKey;
}

const defaultTasks: KanbanTask[] = [
  {
    id: "task-plan-roadmap",
    title: "Plan roadmap",
    column: "backlog",
    points: 3,
  },
  {
    id: "task-sketch-wireframes",
    title: "Sketch wireframes",
    column: "inProgress",
    points: 5,
  },
  {
    id: "task-review-copy",
    title: "Review copy",
    column: "review",
    points: 2,
  },
  {
    id: "task-release-update",
    title: "Release update",
    column: "done",
    points: 1,
  },
  {
    id: "task-write-tests",
    title: "Write tests",
    column: "inProgress",
    points: 3,
  },
];

const defaultWipLimits: Record<ColumnKey, number> = {
  backlog: 4,
  inProgress: 2,
  review: 2,
  done: 6,
};

const columnTitles: Record<ColumnKey, string> = {
  backlog: "Backlog",
  inProgress: "In Progress",
  review: "Review",
  done: "Done",
};

const columnSlugMap: Record<string, ColumnKey> = {
  backlog: "backlog",
  "in-progress": "inProgress",
  inprogress: "inProgress",
  review: "review",
  done: "done",
};

const slugify = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  if (trimmed.length === 0) return null;
  const slug = trimmed.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : null;
};

const ensureUniqueId = (
  desired: string | undefined,
  fallback: string,
  used: Set<string>,
  index: number,
): string => {
  const base = slugify(desired) ?? slugify(fallback) ?? `task-${index + 1}`;
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  return candidate;
};

const normalizeTitle = (value: unknown, fallback: string): string => {
  if (typeof value === "string") {
    const trimmed = value.trim().replace(/\s+/g, " ");
    if (trimmed.length > 0) return trimmed;
  }
  return fallback;
};

const normalizePoints = (value: unknown, fallback: number): number => {
  if (typeof value === "number" && Number.isFinite(value)) {
    const normalized = Math.trunc(value);
    return normalized > 0 ? normalized : 1;
  }
  return fallback > 0 ? Math.trunc(fallback) : 1;
};

const resolveColumn = (value: unknown): ColumnKey | null => {
  const slug = slugify(value);
  if (!slug) return null;
  return columnSlugMap[slug] ?? null;
};

const normalizeColumn = (
  value: unknown,
  fallback: ColumnKey,
): ColumnKey => resolveColumn(value) ?? fallback;

const normalizeLimit = (value: unknown, fallback: number): number => {
  if (typeof value === "number" && Number.isFinite(value)) {
    const normalized = Math.trunc(value);
    return normalized >= 0 ? normalized : 0;
  }
  return fallback >= 0 ? Math.trunc(fallback) : 0;
};

const sanitizeTaskList = (value: unknown): KanbanTask[] => {
  const source = Array.isArray(value) && value.length > 0
    ? value
    : defaultTasks;
  const sanitized: KanbanTask[] = [];
  const used = new Set<string>();
  for (let index = 0; index < source.length; index++) {
    const raw = source[index] as KanbanTaskInput | undefined;
    const fallback = defaultTasks[index % defaultTasks.length];
    const id = ensureUniqueId(raw?.id, fallback.id, used, index);
    used.add(id);
    const title = normalizeTitle(raw?.title, fallback.title);
    const column = normalizeColumn(raw?.column, fallback.column);
    const points = normalizePoints(raw?.points, fallback.points);
    sanitized.push({ id, title, column, points });
  }
  return sanitized;
};

const sanitizeWipLimits = (
  value: unknown,
  fallback: Record<ColumnKey, number>,
): Record<ColumnKey, number> => {
  const sanitized: Record<ColumnKey, number> = { ...fallback };
  if (!value || typeof value !== "object") {
    return sanitized;
  }
  const raw = value as Record<string, unknown>;
  for (const column of columnOrder) {
    const slugKey = column === "inProgress" ? "in-progress" : column;
    const candidate = raw[column] ?? raw[slugKey];
    sanitized[column] = normalizeLimit(candidate, fallback[column]);
  }
  return sanitized;
};

const buildColumnSummaries = (
  input: {
    tasks: KanbanTask[];
    limits: Record<ColumnKey, number>;
  },
): ColumnSummary[] => {
  const groups: Record<ColumnKey, KanbanTask[]> = {
    backlog: [],
    inProgress: [],
    review: [],
    done: [],
  };
  for (const task of input.tasks) {
    const group = groups[task.column];
    group.push(task);
  }
  return columnOrder.map((key) => {
    const items = groups[key].map((task) => ({ ...task }));
    const count = items.length;
    const limit = input.limits[key];
    return {
      key,
      title: columnTitles[key],
      limit,
      count,
      overloaded: count > limit,
      items,
    };
  });
};

const describeStatus = (summaries: ColumnSummary[]): string => {
  const overloaded = summaries.filter((summary) => summary.overloaded);
  if (overloaded.length === 0) {
    return "All columns within limits";
  }
  const segments = overloaded.map((summary) =>
    `${summary.title} ${summary.count}/${summary.limit}`
  );
  return `Over capacity: ${segments.join(", ")}`;
};

const uiMoveTaskHandler = handler(
  (
    _event: unknown,
    context: {
      tasks: Cell<KanbanTaskInput[]>;
      history: Cell<MoveRecord[]>;
      taskIdField: Cell<string>;
      targetColumnField: Cell<string>;
    },
  ) => {
    const current = sanitizeTaskList(context.tasks.get());
    const identifier = slugify(context.taskIdField.get());
    if (!identifier) return;
    const nextColumn = resolveColumn(context.targetColumnField.get());
    if (!nextColumn) return;
    const index = current.findIndex((task) => task.id === identifier);
    if (index < 0) return;
    const existing = current[index];
    if (existing.column === nextColumn) return;

    const updated = current.slice();
    updated[index] = { ...existing, column: nextColumn };
    context.tasks.set(updated);

    const history = context.history.get();
    const entries = Array.isArray(history) ? history.slice() : [];
    entries.push({
      taskId: existing.id,
      from: existing.column,
      to: nextColumn,
    });
    context.history.set(entries);

    context.taskIdField.set("");
    context.targetColumnField.set("");
  },
);

const uiUpdateLimitHandler = handler(
  (
    _event: unknown,
    context: {
      wipLimits: Cell<Record<ColumnKey, number>>;
      columnField: Cell<string>;
      limitField: Cell<string>;
    },
  ) => {
    const column = resolveColumn(context.columnField.get());
    if (!column) return;
    const current = sanitizeWipLimits(
      context.wipLimits.get(),
      defaultWipLimits,
    );
    const limitStr = context.limitField.get();
    const desiredLimit = typeof limitStr === "string" && limitStr.trim() !== ""
      ? parseInt(limitStr.trim(), 10)
      : undefined;
    const nextLimit = normalizeLimit(desiredLimit, current[column]);
    if (nextLimit === current[column]) return;
    const updated = { ...current, [column]: nextLimit };
    context.wipLimits.set(updated);

    context.columnField.set("");
    context.limitField.set("");
  },
);

export const kanbanBoardGrouping = recipe<KanbanBoardArgs>(
  "Kanban Board Grouping",
  ({ tasks, wipLimits }) => {
    const moveHistory = cell<MoveRecord[]>([]);
    const normalizedTasks = lift(sanitizeTaskList)(tasks);
    const limitView = lift(
      (value: Record<ColumnKey, number> | undefined) =>
        sanitizeWipLimits(value, defaultWipLimits),
    )(wipLimits);
    const limitSnapshot = lift((limits: Record<ColumnKey, number>) => ({
      backlog: limits.backlog,
      inProgress: limits.inProgress,
      review: limits.review,
      done: limits.done,
    }))(limitView);
    const columnSummaries = lift(buildColumnSummaries)({
      tasks: normalizedTasks,
      limits: limitView,
    });
    const overloadedColumns = lift((summaries: ColumnSummary[]) =>
      summaries
        .filter((summary) => summary.overloaded)
        .map((summary) => summary.key)
    )(columnSummaries);
    const statusText = lift(describeStatus)(columnSummaries);
    const status = str`${statusText}`;
    const historyView = lift((entries: MoveRecord[] | undefined) =>
      Array.isArray(entries) ? entries : []
    )(moveHistory);

    const taskIdField = cell("");
    const targetColumnField = cell("");
    const columnField = cell("");
    const limitField = cell("");

    const name = lift((s: ColumnSummary[]) => {
      const totalTasks = s.reduce((sum, col) => sum + col.count, 0);
      const overloadedCount = s.filter((col) => col.overloaded).length;
      if (overloadedCount > 0) {
        return `Kanban Board (${totalTasks} tasks, ${overloadedCount} over limit)`;
      }
      return `Kanban Board (${totalTasks} tasks)`;
    })(columnSummaries);

    const boardUi = lift(
      (input: { columns: ColumnSummary[]; history: MoveRecord[] }) => {
        const columns = input.columns;
        const history = input.history;

        const columnColors: Record<ColumnKey, string> = {
          backlog: "#e0e7ff",
          inProgress: "#fef3c7",
          review: "#dbeafe",
          done: "#dcfce7",
        };

        const overloadColors: Record<ColumnKey, string> = {
          backlog: "#fca5a5",
          inProgress: "#fca5a5",
          review: "#fca5a5",
          done: "#fca5a5",
        };

        const boardColumns = [];
        for (const col of columns) {
          const bgColor = col.overloaded
            ? overloadColors[col.key]
            : columnColors[col.key];
          const borderColor = col.overloaded ? "#dc2626" : "#9ca3af";
          const limitColor = col.overloaded ? "#dc2626" : "#4b5563";

          const taskElements = [];
          for (const task of col.items) {
            taskElements.push(
              h("div", {
                style:
                  "background: white; border: 1px solid #d1d5db; border-radius: 6px; padding: 10px; margin-bottom: 8px;",
              }, [
                h("div", {
                  style:
                    "font-weight: 600; font-size: 14px; margin-bottom: 4px;",
                }, task.title),
                h("div", {
                  style:
                    "display: flex; justify-content: space-between; align-items: center; font-size: 12px; color: #6b7280;",
                }, [
                  h("span", {
                    style: "font-family: monospace;",
                  }, task.id),
                  h("span", {
                    style:
                      "background: #e0e7ff; color: #3730a3; padding: 2px 8px; border-radius: 4px; font-weight: 600;",
                  }, String(task.points) + " pts"),
                ]),
              ]),
            );
          }

          boardColumns.push(
            h("div", {
              style: "background: " + bgColor + "; border: 2px solid " +
                borderColor +
                "; border-radius: 8px; padding: 12px; min-width: 200px;",
            }, [
              h("div", {
                style: "margin-bottom: 12px;",
              }, [
                h("div", {
                  style:
                    "font-weight: 700; font-size: 16px; margin-bottom: 4px;",
                }, col.title),
                h("div", {
                  style: "font-size: 13px; color: " + limitColor +
                    "; font-weight: 600;",
                }, String(col.count) + " / " + String(col.limit) + " items"),
              ]),
              ...taskElements,
            ]),
          );
        }

        const historyElements = [];
        const recentHistory = history.slice().reverse().slice(0, 6);
        for (let i = 0; i < recentHistory.length; i++) {
          const entry = recentHistory[i];
          const bgColor = i % 2 === 0 ? "#ffffff" : "#f9fafb";
          historyElements.push(
            h("div", {
              style: "background: " + bgColor +
                "; padding: 8px; border-bottom: 1px solid #e5e7eb; font-size: 13px;",
            }, [
              h("span", {
                style: "font-family: monospace; font-weight: 600;",
              }, entry.taskId),
              h("span", {}, " moved from "),
              h("span", {
                style: "color: #7c3aed; font-weight: 600;",
              }, columnTitles[entry.from]),
              h("span", {}, " to "),
              h("span", {
                style: "color: #059669; font-weight: 600;",
              }, columnTitles[entry.to]),
            ]),
          );
        }

        return {
          header: h("div", {
            style: "text-align: center; margin-bottom: 24px;",
          }, [
            h("h1", {
              style:
                "font-size: 28px; font-weight: 800; margin-bottom: 8px; color: #1f2937;",
            }, "Kanban Board"),
            h("div", {
              style: "background: " + (input.columns.some((c) =>
                  c.overloaded
                )
                ? "#fee2e2"
                : "#d1fae5") +
                "; color: " + (input.columns.some((c) => c.overloaded)
                  ? "#991b1b"
                  : "#065f46") +
                "; border: 2px solid " + (input.columns.some((c) =>
                    c.overloaded
                  )
                  ? "#fca5a5"
                  : "#86efac") +
                "; border-radius: 8px; padding: 12px; font-weight: 600; font-size: 14px;",
            }, describeStatus(columns)),
          ]),
          board: h("div", {
            style:
              "display: flex; gap: 16px; overflow-x: auto; margin-bottom: 20px; padding-bottom: 12px;",
          }, ...boardColumns),
          historySection: h("div", {
            style:
              "background: white; border: 1px solid #e5e7eb; border-radius: 8px; overflow: hidden;",
          }, [
            h("div", {
              style:
                "background: #f3f4f6; padding: 12px; border-bottom: 2px solid #e5e7eb;",
            }, [
              h("h2", {
                style: "font-size: 16px; font-weight: 700; color: #374151;",
              }, "Recent Moves"),
            ]),
            historyElements.length > 0
              ? h("div", {}, ...historyElements)
              : h("div", {
                style:
                  "padding: 20px; text-align: center; color: #9ca3af; font-size: 14px;",
              }, "No moves yet"),
          ]),
        };
      },
    )({ columns: columnSummaries, history: historyView });

    const boardHeader = lift((parts: typeof boardUi) => parts.header)(boardUi);
    const board = lift((parts: typeof boardUi) => parts.board)(boardUi);
    const historySection = lift((parts: typeof boardUi) =>
      parts.historySection
    )(boardUi);

    const ui = (
      <div style="font-family: system-ui, -apple-system, sans-serif; max-width: 1200px; margin: 0 auto; padding: 20px;">
        {boardHeader}

        <div style="background: white; border: 1px solid #e5e7eb; border-radius: 8px; padding: 16px; margin-bottom: 20px;">
          <h2 style="font-size: 18px; font-weight: 700; margin-bottom: 12px; color: #374151;">
            Move Task
          </h2>
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 12px;">
            <div>
              <label style="display: block; font-size: 13px; font-weight: 600; margin-bottom: 4px; color: #4b5563;">
                Task ID
              </label>
              <ct-input
                $value={taskIdField}
                placeholder="e.g., task-write-tests"
                style="width: 100%;"
              />
            </div>
            <div>
              <label style="display: block; font-size: 13px; font-weight: 600; margin-bottom: 4px; color: #4b5563;">
                Target Column
              </label>
              <ct-input
                $value={targetColumnField}
                placeholder="backlog, in-progress, review, done"
                style="width: 100%;"
              />
            </div>
          </div>
          <ct-button
            onClick={uiMoveTaskHandler({
              tasks,
              history: moveHistory,
              taskIdField,
              targetColumnField,
            })}
            style="background: #3b82f6; color: white; padding: 10px 20px; border-radius: 6px; font-weight: 600; cursor: pointer;"
          >
            Move Task
          </ct-button>
        </div>

        <div style="background: white; border: 1px solid #e5e7eb; border-radius: 8px; padding: 16px; margin-bottom: 20px;">
          <h2 style="font-size: 18px; font-weight: 700; margin-bottom: 12px; color: #374151;">
            Update WIP Limit
          </h2>
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 12px;">
            <div>
              <label style="display: block; font-size: 13px; font-weight: 600; margin-bottom: 4px; color: #4b5563;">
                Column
              </label>
              <ct-input
                $value={columnField}
                placeholder="backlog, in-progress, review, done"
                style="width: 100%;"
              />
            </div>
            <div>
              <label style="display: block; font-size: 13px; font-weight: 600; margin-bottom: 4px; color: #4b5563;">
                New Limit
              </label>
              <ct-input
                $value={limitField}
                placeholder="e.g., 3"
                style="width: 100%;"
              />
            </div>
          </div>
          <ct-button
            onClick={uiUpdateLimitHandler({
              wipLimits,
              columnField,
              limitField,
            })}
            style="background: #8b5cf6; color: white; padding: 10px 20px; border-radius: 6px; font-weight: 600; cursor: pointer;"
          >
            Update Limit
          </ct-button>
        </div>

        {board}
        {historySection}
      </div>
    );

    return {
      [NAME]: name,
      [UI]: ui,
      tasks: normalizedTasks,
      columns: columnSummaries,
      limits: limitSnapshot,
      overloadedColumns,
      status,
      history: historyView,
    };
  },
);
