/// <cts-enable />
// @ts-nocheck
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

interface CourseModule {
  id: string;
  title: string;
  durationWeeks: number;
}

interface TimelineEntry {
  id: string;
  title: string;
  startWeek: number;
  endWeek: number;
}

interface ReorderEvent {
  from?: number;
  to?: number;
}

const defaultModules: CourseModule[] = [
  { id: "orientation", title: "Orientation", durationWeeks: 1 },
  { id: "foundations", title: "Core Foundations", durationWeeks: 2 },
  { id: "project", title: "Capstone Project", durationWeeks: 3 },
];

const sanitizeText = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const sanitizeDuration = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) return 1;
  const integer = Math.round(value);
  return integer > 0 ? integer : 1;
};

const buildModuleId = (value: string): string => {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
};

const sanitizeModule = (
  module: CourseModule | undefined,
): CourseModule | null => {
  const title = sanitizeText(module?.title);
  if (!title) return null;
  const idSource = sanitizeText(module?.id) ?? title;
  const id = buildModuleId(idSource);
  if (id.length === 0) return null;
  const durationWeeks = sanitizeDuration(module?.durationWeeks);
  return { id, title, durationWeeks };
};

const sanitizeModules = (
  value: readonly CourseModule[] | undefined,
): CourseModule[] => {
  if (!Array.isArray(value)) return structuredClone(defaultModules);
  const seen = new Set<string>();
  const sanitized: CourseModule[] = [];
  for (const item of value) {
    const entry = sanitizeModule(item);
    if (!entry || seen.has(entry.id)) continue;
    seen.add(entry.id);
    sanitized.push(entry);
  }
  return sanitized.length > 0 ? sanitized : structuredClone(defaultModules);
};

const sanitizeStartWeek = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) return 1;
  const rounded = Math.round(value);
  return rounded > 0 ? rounded : 1;
};

const buildTimeline = (
  modules: readonly CourseModule[],
  startWeek: number,
): TimelineEntry[] => {
  const result: TimelineEntry[] = [];
  let currentWeek = startWeek;
  for (const module of modules) {
    const duration = sanitizeDuration(module.durationWeeks);
    const start = currentWeek;
    const end = currentWeek + duration - 1;
    result.push({
      id: module.id,
      title: module.title,
      startWeek: start,
      endWeek: end,
    });
    currentWeek = end + 1;
  }
  return result;
};

const formatTimeline = (entries: readonly TimelineEntry[]): string => {
  if (entries.length === 0) return "No modules scheduled";
  const segments = entries.map((entry) =>
    `${entry.title} (W${entry.startWeek}-W${entry.endWeek})`
  );
  return segments.join(" → ");
};

const clampIndex = (value: unknown, length: number): number => {
  if (length <= 0) return 0;
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  const index = Math.round(value);
  if (index < 0) return 0;
  if (index >= length) return length - 1;
  return index;
};

interface EducationCoursePlannerArgs {
  modules: Default<CourseModule[], typeof defaultModules>;
  startWeek: Default<number, 1>;
}

const reorderModulesHandler = handler(
  (
    event: ReorderEvent | undefined,
    manager: {
      modules: Cell<CourseModule[]>;
      reorderCount: Cell<number>;
      lastAction: Cell<string>;
    },
  ) => {
    const currentModules = sanitizeModules(manager.modules.get());
    if (currentModules.length < 2) {
      return;
    }
    const from = clampIndex(event?.from, currentModules.length);
    const to = clampIndex(event?.to, currentModules.length);
    if (from === to) return;
    const updated = currentModules.slice();
    const [moved] = updated.splice(from, 1);
    updated.splice(to, 0, moved);
    manager.modules.set(updated);
    const count = (manager.reorderCount.get() ?? 0) + 1;
    manager.reorderCount.set(count);
    const position = to + 1;
    manager.lastAction.set(`Moved ${moved.title} to position ${position}`);
  },
);

const addModuleHandler = handler(
  (
    _event: undefined,
    manager: {
      modules: Cell<CourseModule[]>;
      titleField: Cell<string>;
      durationField: Cell<string>;
      lastAction: Cell<string>;
    },
  ) => {
    const titleStr = manager.titleField.get();
    const durationStr = manager.durationField.get();

    if (typeof titleStr !== "string" || titleStr.trim() === "") return;

    const title = titleStr.trim();
    const duration = parseInt(durationStr || "1", 10);
    const weeks = sanitizeDuration(duration);

    const id = buildModuleId(title);
    const currentModules = sanitizeModules(manager.modules.get());

    // Check for duplicate IDs
    if (currentModules.some((m) => m.id === id)) {
      manager.lastAction.set(`Module "${title}" already exists`);
      return;
    }

    const newModule: CourseModule = { id, title, durationWeeks: weeks };
    manager.modules.set([...currentModules, newModule]);
    manager.titleField.set("");
    manager.durationField.set("");
    manager.lastAction.set(`Added module "${title}" (${weeks} weeks)`);
  },
);

const moveUpHandler = handler(
  (
    _event: undefined,
    manager: {
      modules: Cell<CourseModule[]>;
      indexField: Cell<string>;
      lastAction: Cell<string>;
      reorderCount: Cell<number>;
    },
  ) => {
    const indexStr = manager.indexField.get();
    if (typeof indexStr !== "string" || indexStr.trim() === "") return;

    const index = parseInt(indexStr, 10);
    const currentModules = sanitizeModules(manager.modules.get());

    if (isNaN(index) || index < 1 || index >= currentModules.length) return;

    const updated = currentModules.slice();
    const [moved] = updated.splice(index, 1);
    updated.splice(index - 1, 0, moved);

    manager.modules.set(updated);
    const count = (manager.reorderCount.get() ?? 0) + 1;
    manager.reorderCount.set(count);
    manager.lastAction.set(`Moved ${moved.title} up to position ${index}`);
  },
);

const moveDownHandler = handler(
  (
    _event: undefined,
    manager: {
      modules: Cell<CourseModule[]>;
      indexField: Cell<string>;
      lastAction: Cell<string>;
      reorderCount: Cell<number>;
    },
  ) => {
    const indexStr = manager.indexField.get();
    if (typeof indexStr !== "string" || indexStr.trim() === "") return;

    const index = parseInt(indexStr, 10);
    const currentModules = sanitizeModules(manager.modules.get());

    if (isNaN(index) || index < 0 || index >= currentModules.length - 1) return;

    const updated = currentModules.slice();
    const [moved] = updated.splice(index, 1);
    updated.splice(index + 1, 0, moved);

    manager.modules.set(updated);
    const count = (manager.reorderCount.get() ?? 0) + 1;
    manager.reorderCount.set(count);
    manager.lastAction.set(
      `Moved ${moved.title} down to position ${index + 2}`,
    );
  },
);

export const educationCoursePlanner = recipe<EducationCoursePlannerArgs>(
  "Education Course Planner",
  ({ modules, startWeek }) => {
    const reorderCount = cell(0);
    const lastAction = cell("initialized");
    const titleField = cell("");
    const durationField = cell("");
    const indexField = cell("");

    const modulesView = lift(sanitizeModules)(modules);
    const startWeekView = lift(sanitizeStartWeek)(startWeek);

    const timeline = lift((inputs: {
      modules: CourseModule[];
      start: number;
    }) => buildTimeline(inputs.modules, inputs.start))({
      modules: modulesView,
      start: startWeekView,
    });

    const totalDuration = lift((entries: CourseModule[] | undefined) => {
      if (!Array.isArray(entries)) return 0;
      return entries.reduce(
        (sum, entry) => sum + sanitizeDuration(entry.durationWeeks),
        0,
      );
    })(modulesView);

    const moduleOrder = lift((entries: CourseModule[] | undefined) => {
      if (!Array.isArray(entries)) return [] as string[];
      return entries.map((entry) => entry.id);
    })(modulesView);

    const reorderCountView = lift((count: number | undefined) => {
      if (typeof count !== "number" || !Number.isFinite(count)) return 0;
      return Math.max(0, Math.trunc(count));
    })(reorderCount);

    const timelineSummary = lift((entries: TimelineEntry[] | undefined) =>
      Array.isArray(entries) ? formatTimeline(entries) : "No modules scheduled"
    )(timeline);

    const label = str`Course timeline: ${timelineSummary}`;

    const context = {
      modules,
      reorderCount,
      lastAction,
    } as const;

    const addContext = {
      modules,
      titleField,
      durationField,
      lastAction,
    } as const;

    const moveContext = {
      modules,
      indexField,
      lastAction,
      reorderCount,
    } as const;

    const reorder = reorderModulesHandler(context as never);
    const addModule = addModuleHandler(addContext as never);
    const moveUp = moveUpHandler(moveContext as never);
    const moveDown = moveDownHandler(moveContext as never);

    const name = lift((entries: CourseModule[] | undefined) => {
      if (!Array.isArray(entries) || entries.length === 0) {
        return "Course Planner";
      }
      return `Course Planner (${entries.length} modules)`;
    })(modulesView);

    const timelineCards = lift((entries: TimelineEntry[] | undefined) => {
      if (!Array.isArray(entries) || entries.length === 0) {
        return h("div", {
          style:
            "text-align: center; padding: 2rem; color: #64748b; background: #f8fafc; border: 2px dashed #cbd5e1; border-radius: 8px;",
        }, "No modules scheduled. Add a module to get started!");
      }

      const cards = [];
      const colors = ["#3b82f6", "#8b5cf6", "#ec4899", "#f59e0b", "#10b981"];

      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        const color = colors[i % colors.length];
        const duration = entry.endWeek - entry.startWeek + 1;

        const cardStyle = "background: white; border-left: 4px solid " + color +
          "; border-radius: 8px; padding: 1rem; box-shadow: 0 1px 3px rgba(0,0,0,0.1);";
        const indexStyle =
          "display: inline-block; width: 2rem; height: 2rem; line-height: 2rem; text-align: center; background: " +
          color +
          "; color: white; border-radius: 50%; font-weight: 600; margin-right: 0.75rem;";
        const titleStyle =
          "font-weight: 600; font-size: 1.1rem; color: #1e293b; margin-bottom: 0.5rem;";
        const weekStyle =
          "font-family: 'SF Mono', Monaco, monospace; color: #475569; font-size: 0.9rem; margin-right: 1rem;";
        const durationStyle = "color: #64748b; font-size: 0.9rem;";

        cards.push(
          h(
            "div",
            { style: cardStyle },
            h(
              "div",
              {
                style:
                  "display: flex; align-items: center; margin-bottom: 0.5rem;",
              },
              h("span", { style: indexStyle }, String(i)),
              h("span", { style: titleStyle }, entry.title),
            ),
            h(
              "div",
              { style: "display: flex; gap: 1rem; padding-left: 2.75rem;" },
              h(
                "span",
                { style: weekStyle },
                "W" + String(entry.startWeek) + " - W" + String(entry.endWeek),
              ),
              h(
                "span",
                { style: durationStyle },
                String(duration) + " " + (duration === 1 ? "week" : "weeks"),
              ),
            ),
          ),
        );
      }

      return h("div", {
        style: "display: flex; flex-direction: column; gap: 0.75rem;",
      }, ...cards);
    })(timeline);

    const ui = h(
      "div",
      {
        style:
          "max-width: 900px; margin: 0 auto; padding: 1.5rem; font-family: system-ui, -apple-system, sans-serif; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); min-height: 100vh;",
      },
      // Header
      h(
        "div",
        {
          style:
            "background: white; border-radius: 12px; padding: 2rem; margin-bottom: 1.5rem; box-shadow: 0 4px 6px rgba(0,0,0,0.1);",
        },
        h(
          "h1",
          {
            style:
              "margin: 0 0 0.5rem 0; color: #1e293b; font-size: 2rem; display: flex; align-items: center; gap: 0.5rem;",
          },
          h("span", {}, "📚"),
          name,
        ),
        h(
          "div",
          {
            style:
              "display: grid; grid-template-columns: repeat(2, 1fr); gap: 1rem; margin-top: 1rem;",
          },
          h(
            "div",
            {
              style:
                "background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 1rem; border-radius: 8px; color: white;",
            },
            h("div", {
              style:
                "font-size: 0.875rem; opacity: 0.9; margin-bottom: 0.25rem;",
            }, "Total Duration"),
            h(
              "div",
              { style: "font-size: 2rem; font-weight: 700;" },
              totalDuration,
              h("span", {
                style: "font-size: 1rem; margin-left: 0.5rem; opacity: 0.9;",
              }, "weeks"),
            ),
          ),
          h(
            "div",
            {
              style:
                "background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%); padding: 1rem; border-radius: 8px; color: white;",
            },
            h("div", {
              style:
                "font-size: 0.875rem; opacity: 0.9; margin-bottom: 0.25rem;",
            }, "Start Week"),
            h(
              "div",
              { style: "font-size: 2rem; font-weight: 700;" },
              h("span", {}, "W"),
              startWeekView,
            ),
          ),
        ),
      ),
      // Timeline
      h(
        "div",
        {
          style:
            "background: white; border-radius: 12px; padding: 1.5rem; margin-bottom: 1.5rem; box-shadow: 0 4px 6px rgba(0,0,0,0.1);",
        },
        h(
          "h2",
          {
            style:
              "margin: 0 0 1rem 0; color: #1e293b; font-size: 1.25rem; display: flex; align-items: center; gap: 0.5rem;",
          },
          h("span", {}, "🗓️"),
          "Course Timeline",
        ),
        timelineCards,
      ),
      // Add Module
      h(
        "div",
        {
          style:
            "background: white; border-radius: 12px; padding: 1.5rem; margin-bottom: 1.5rem; box-shadow: 0 4px 6px rgba(0,0,0,0.1);",
        },
        h("h3", {
          style: "margin: 0 0 1rem 0; color: #1e293b; font-size: 1.1rem;",
        }, "➕ Add Module"),
        h(
          "div",
          {
            style:
              "display: grid; grid-template-columns: 1fr auto auto; gap: 0.75rem; align-items: end;",
          },
          h(
            "div",
            {},
            h("label", {
              style:
                "display: block; font-size: 0.875rem; font-weight: 500; color: #475569; margin-bottom: 0.25rem;",
            }, "Module Title"),
            h("ct-input", {
              $value: titleField,
              placeholder: "e.g., Advanced Topics",
              style: "width: 100%;",
            }),
          ),
          h(
            "div",
            {},
            h("label", {
              style:
                "display: block; font-size: 0.875rem; font-weight: 500; color: #475569; margin-bottom: 0.25rem;",
            }, "Duration (weeks)"),
            h("ct-input", {
              $value: durationField,
              placeholder: "1",
              style: "width: 100px;",
            }),
          ),
          h(
            "ct-button",
            { onClick: addModule, style: "white-space: nowrap;" },
            "Add Module",
          ),
        ),
      ),
      // Reorder Controls
      h(
        "div",
        {
          style:
            "background: white; border-radius: 12px; padding: 1.5rem; margin-bottom: 1.5rem; box-shadow: 0 4px 6px rgba(0,0,0,0.1);",
        },
        h("h3", {
          style: "margin: 0 0 1rem 0; color: #1e293b; font-size: 1.1rem;",
        }, "🔄 Reorder Modules"),
        h(
          "div",
          {
            style:
              "display: grid; grid-template-columns: 1fr auto auto; gap: 0.75rem; align-items: end;",
          },
          h(
            "div",
            {},
            h("label", {
              style:
                "display: block; font-size: 0.875rem; font-weight: 500; color: #475569; margin-bottom: 0.25rem;",
            }, "Module Position (0-indexed)"),
            h("ct-input", {
              $value: indexField,
              placeholder: "0",
              style: "width: 100%;",
            }),
          ),
          h("ct-button", { onClick: moveUp }, "▲ Move Up"),
          h("ct-button", { onClick: moveDown }, "▼ Move Down"),
        ),
        h(
          "div",
          {
            style:
              "margin-top: 0.75rem; padding: 0.75rem; background: #f8fafc; border-radius: 6px; font-size: 0.875rem; color: #475569;",
          },
          h("strong", {}, "Tip: "),
          "Enter the current position of a module (starting from 0) to move it up or down in the sequence.",
        ),
      ),
      // Status
      h(
        "div",
        {
          style:
            "background: white; border-radius: 12px; padding: 1rem; box-shadow: 0 4px 6px rgba(0,0,0,0.1);",
        },
        h(
          "div",
          {
            style:
              "display: flex; justify-content: space-between; align-items: center;",
          },
          h(
            "div",
            { style: "font-size: 0.875rem; color: #475569;" },
            h("strong", {}, "Last Action: "),
            lastAction,
          ),
          h(
            "div",
            { style: "font-size: 0.875rem; color: #475569;" },
            h("strong", {}, "Reorder Count: "),
            reorderCountView,
          ),
        ),
      ),
    );

    return {
      [NAME]: name,
      [UI]: ui,
      modules,
      startWeek,
      modulesView,
      moduleOrder,
      timeline,
      timelineSummary,
      totalDuration,
      label,
      reorderCount: reorderCountView,
      lastAction,
      reorder,
    };
  },
);
