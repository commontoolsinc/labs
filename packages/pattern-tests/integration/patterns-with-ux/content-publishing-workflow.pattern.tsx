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

type DraftPriority = "high" | "medium" | "low";

type DraftStage =
  | "ideation"
  | "drafting"
  | "review"
  | "ready"
  | "scheduled"
  | "published";

interface DraftSeed {
  id?: string;
  title?: string;
  summary?: string;
  priority?: string;
  stage?: string;
  scheduledDate?: string;
  assignedEditor?: string;
}

interface DraftEntry extends DraftSeed {
  id: string;
  title: string;
  summary: string;
  priority: DraftPriority;
  stage: DraftStage;
  scheduledDate: string;
  assignedEditor: string;
}

interface ContentPublishingWorkflowArgs {
  drafts: Default<DraftSeed[], typeof defaultDrafts>;
}

const defaultDrafts: DraftEntry[] = [
  {
    id: "draft-launch-announcement",
    title: "Launch Announcement",
    summary: "Feature launch hero article.",
    priority: "high",
    stage: "review",
    scheduledDate: "2024-07-02",
    assignedEditor: "Noah",
  },
  {
    id: "draft-customer-story",
    title: "Finch Story",
    summary: "Spotlight on Finch pilot results.",
    priority: "medium",
    stage: "ready",
    scheduledDate: "2024-07-04",
    assignedEditor: "Ravi",
  },
  {
    id: "draft-quarterly-recap",
    title: "Quarterly Recap",
    summary: "Q2 product summary newsletter.",
    priority: "medium",
    stage: "drafting",
    scheduledDate: "2024-07-06",
    assignedEditor: "Amelia",
  },
];

const stageOrder: readonly DraftStage[] = [
  "ideation",
  "drafting",
  "review",
  "ready",
  "scheduled",
  "published",
];

const priorityRank: Record<DraftPriority, number> = {
  high: 0,
  medium: 1,
  low: 2,
};

const stageRank: Record<DraftStage, number> = {
  ideation: 0,
  drafting: 1,
  review: 2,
  ready: 3,
  scheduled: 4,
  published: 5,
};

const datePattern = /^\d{4}-\d{2}-\d{2}$/;

const sanitizeIdentifier = (value: unknown, fallback: string): string => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    const normalized = trimmed
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "");
    if (normalized.length > 0) return normalized;
  }
  return fallback;
};

const sanitizeText = (value: unknown, fallback: string): string => {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  if (trimmed.length === 0) return fallback;
  return trimmed.replace(/\s+/g, " ");
};

const sanitizeTitle = (value: unknown, fallback: string): string => {
  const base = sanitizeText(value, fallback);
  if (base.length === 0) return fallback;
  return base[0].toUpperCase() + base.slice(1);
};

const sanitizeSummary = (value: unknown, fallback: string): string => {
  return sanitizeText(value, fallback);
};

const sanitizeEditor = (value: unknown, fallback: string): string => {
  const base = sanitizeText(value, fallback);
  return base.length === 0 ? fallback : base;
};

const sanitizePriority = (
  value: unknown,
  fallback: DraftPriority,
): DraftPriority => {
  if (value === "high" || value === "medium" || value === "low") {
    return value;
  }
  if (typeof value === "string") {
    const lower = value.toLowerCase();
    if (lower === "high" || lower === "medium" || lower === "low") {
      return lower as DraftPriority;
    }
  }
  return fallback;
};

const sanitizeStage = (
  value: unknown,
  fallback: DraftStage,
): DraftStage => {
  if (typeof value === "string") {
    const lower = value.trim().toLowerCase();
    if (stageOrder.includes(lower as DraftStage)) {
      return lower as DraftStage;
    }
  }
  return fallback;
};

const sanitizeDate = (value: unknown, fallback: string): string => {
  if (typeof value === "string") {
    const trimmed = value.trim().replace(/\//g, "-");
    if (datePattern.test(trimmed)) {
      return trimmed;
    }
  }
  if (datePattern.test(fallback)) {
    return fallback;
  }
  return "2024-07-31";
};

const ensureUniqueId = (candidate: string, used: Set<string>): string => {
  if (!used.has(candidate)) {
    used.add(candidate);
    return candidate;
  }
  let index = 2;
  let id = `${candidate}-${index}`;
  while (used.has(id)) {
    index += 1;
    id = `${candidate}-${index}`;
  }
  used.add(id);
  return id;
};

const sanitizeDraft = (
  seed: DraftSeed | undefined,
  fallback: DraftSeed,
  index: number,
  used: Set<string>,
): DraftEntry => {
  const fallbackId = typeof fallback.id === "string" && fallback.id.length > 0
    ? fallback.id
    : `draft-${index + 1}`;
  const id = ensureUniqueId(
    sanitizeIdentifier(seed?.id, fallbackId),
    used,
  );
  const fallbackTitle = typeof fallback.title === "string" &&
      fallback.title.length > 0
    ? fallback.title
    : `Draft ${index + 1}`;
  const title = sanitizeTitle(seed?.title, fallbackTitle);
  const summary = sanitizeSummary(
    seed?.summary,
    typeof fallback.summary === "string"
      ? fallback.summary
      : "Workflow draft placeholder.",
  );
  const fallbackPriority = sanitizePriority(
    fallback.priority,
    "medium",
  );
  const priority = sanitizePriority(seed?.priority, fallbackPriority);
  const fallbackStage = sanitizeStage(fallback.stage, "drafting");
  const stage = sanitizeStage(seed?.stage, fallbackStage);
  const fallbackDate = sanitizeDate(
    fallback.scheduledDate,
    `2024-07-${String(index + 1).padStart(2, "0")}`,
  );
  const scheduledDate = sanitizeDate(seed?.scheduledDate, fallbackDate);
  const assignedEditor = sanitizeEditor(
    seed?.assignedEditor,
    sanitizeEditor(fallback.assignedEditor, "Unassigned"),
  );
  return {
    id,
    title,
    summary,
    priority,
    stage,
    scheduledDate,
    assignedEditor,
  };
};

const sanitizeDraftList = (
  value: readonly DraftSeed[] | undefined,
): DraftEntry[] => {
  const seeds = Array.isArray(value) && value.length > 0
    ? value
    : defaultDrafts;
  const used = new Set<string>();
  const drafts: DraftEntry[] = [];
  for (let index = 0; index < seeds.length; index += 1) {
    const fallback = defaultDrafts[index % defaultDrafts.length];
    drafts.push(sanitizeDraft(seeds[index], fallback, index, used));
  }
  return drafts;
};

const compareSchedule = (a: string, b: string): number => {
  if (a === b) return 0;
  const [aYear, aMonth, aDay] = a.split("-").map((segment) => Number(segment));
  const [bYear, bMonth, bDay] = b.split("-").map((segment) => Number(segment));
  if (aYear !== bYear) return aYear - bYear;
  if (aMonth !== bMonth) return aMonth - bMonth;
  return aDay - bDay;
};

const buildQueue = (entries: readonly DraftEntry[]): DraftEntry[] => {
  return entries
    .filter((entry) =>
      entry.stage !== "scheduled" && entry.stage !== "published"
    )
    .map((entry) => ({ ...entry }))
    .sort((a, b) => {
      const priorityDiff = priorityRank[a.priority] - priorityRank[b.priority];
      if (priorityDiff !== 0) return priorityDiff;
      const scheduleDiff = compareSchedule(a.scheduledDate, b.scheduledDate);
      if (scheduleDiff !== 0) return scheduleDiff;
      const stageDiff = stageRank[a.stage] - stageRank[b.stage];
      if (stageDiff !== 0) return stageDiff;
      return a.title.localeCompare(b.title);
    });
};

const sortDrafts = (entries: readonly DraftEntry[]): DraftEntry[] => {
  return entries.slice().sort((a, b) => {
    const priorityDiff = priorityRank[a.priority] - priorityRank[b.priority];
    if (priorityDiff !== 0) return priorityDiff;
    const scheduleDiff = compareSchedule(a.scheduledDate, b.scheduledDate);
    if (scheduleDiff !== 0) return scheduleDiff;
    const stageDiff = stageRank[a.stage] - stageRank[b.stage];
    if (stageDiff !== 0) return stageDiff;
    return a.title.localeCompare(b.title);
  });
};

const buildStageTotals = (
  entries: readonly DraftEntry[],
): Record<DraftStage, number> => {
  const totals: Record<DraftStage, number> = {
    ideation: 0,
    drafting: 0,
    review: 0,
    ready: 0,
    scheduled: 0,
    published: 0,
  };
  for (const entry of entries) {
    totals[entry.stage] += 1;
  }
  return totals;
};

const appendHistory = (
  history: readonly string[],
  entry: string,
): string[] => {
  const next = [...history, entry];
  return next.length > 6 ? next.slice(next.length - 6) : next;
};

const stageActionLabel = (stage: DraftStage): string => {
  switch (stage) {
    case "ideation":
      return "ideation";
    case "drafting":
      return "drafting";
    case "review":
      return "review";
    case "ready":
      return "ready for scheduling";
    case "scheduled":
      return "scheduled";
    case "published":
      return "published";
  }
};

const suggestSchedule = (sequence: number): string => {
  const day = ((sequence - 1) % 27) + 1;
  return `2024-07-${day.toString().padStart(2, "0")}`;
};

const stageLabels: Record<DraftStage, string> = {
  ideation: "Ideation",
  drafting: "Drafting",
  review: "Review",
  ready: "Ready",
  scheduled: "Scheduled",
  published: "Published",
};

export const contentPublishingWorkflowUx = recipe<
  ContentPublishingWorkflowArgs
>(
  "Content Publishing Workflow (UX)",
  ({ drafts }) => {
    const sequence = cell(0);
    const activityLog = cell<string[]>(["Workflow initialized"]);

    const draftsView = lift(sanitizeDraftList)(drafts);
    const queue = lift(buildQueue)(draftsView);
    const queueCount = lift((entries: DraftEntry[]) => entries.length)(queue);
    const scheduledCount = lift((entries: DraftEntry[]) =>
      entries.filter((entry) => entry.stage === "scheduled").length
    )(draftsView);
    const publishedCount = lift((entries: DraftEntry[]) =>
      entries.filter((entry) => entry.stage === "published").length
    )(draftsView);

    const stageTotals = lift(buildStageTotals)(draftsView);

    const nextDraft = lift((entries: DraftEntry[]) =>
      entries.length > 0 ? entries[0] : null
    )(queue);

    const name = str`Content Publishing (${
      lift((e: DraftEntry[]) => e.length)(draftsView)
    } drafts)`;

    // UI cells for adding new draft
    const newDraftTitle = cell<string>("");
    const newDraftSummary = cell<string>("");
    const newDraftPriority = cell<string>("medium");
    const newDraftEditor = cell<string>("");

    // UI cells for draft actions
    const selectedDraftId = cell<string>("");

    const addDraftHandler = handler<
      unknown,
      {
        drafts: Cell<DraftSeed[]>;
        sequence: Cell<number>;
        activityLog: Cell<string[]>;
        titleField: Cell<string>;
        summaryField: Cell<string>;
        priorityField: Cell<string>;
        editorField: Cell<string>;
      }
    >(
      (
        _event,
        {
          drafts,
          sequence,
          activityLog,
          titleField,
          summaryField,
          priorityField,
          editorField,
        },
      ) => {
        const current = sanitizeDraftList(drafts.get());
        const used = new Set(current.map((draft) => draft.id));
        const nextIndex = Math.max(sequence.get() ?? 0, current.length) + 1;
        sequence.set(nextIndex);

        const fallback = defaultDrafts[(nextIndex - 1) % defaultDrafts.length];
        const title = sanitizeTitle(
          titleField.get(),
          fallback.title ?? `Draft ${nextIndex}`,
        );
        const id = ensureUniqueId(
          sanitizeIdentifier(titleField.get(), `draft-${nextIndex}`),
          used,
        );
        const summary = sanitizeSummary(
          summaryField.get(),
          fallback.summary ?? "Workflow intake submission.",
        );
        const priority = sanitizePriority(
          priorityField.get(),
          fallback.priority ?? "medium",
        );
        const scheduledDate = suggestSchedule(nextIndex);
        const assignedEditor = sanitizeEditor(
          editorField.get(),
          fallback.assignedEditor ?? "Unassigned",
        );

        const entry: DraftEntry = {
          id,
          title,
          summary,
          priority,
          stage: "drafting",
          scheduledDate,
          assignedEditor,
        };

        drafts.set(sortDrafts([...current, entry]));
        const message =
          `${title} queued as ${priority} priority due ${scheduledDate}`;
        activityLog.set(appendHistory(activityLog.get(), message));

        // Clear form fields
        titleField.set("");
        summaryField.set("");
        priorityField.set("medium");
        editorField.set("");
      },
    )({
      drafts,
      sequence,
      activityLog,
      titleField: newDraftTitle,
      summaryField: newDraftSummary,
      priorityField: newDraftPriority,
      editorField: newDraftEditor,
    });

    const advanceStageHandler = handler<
      unknown,
      {
        drafts: Cell<DraftSeed[]>;
        activityLog: Cell<string[]>;
        draftId: Cell<string>;
      }
    >((_event, { drafts, activityLog, draftId }) => {
      const id = sanitizeIdentifier(draftId.get(), "");
      if (id.length === 0) return;

      const current = sanitizeDraftList(drafts.get());
      const index = current.findIndex((draft) => draft.id === id);
      if (index === -1) return;

      const draft = current[index];
      const nextStageIdx = stageRank[draft.stage] + 1;
      const nextStage = stageOrder[nextStageIdx] ?? draft.stage;
      if (nextStage === draft.stage) return;

      const next = current.slice();
      next[index] = { ...draft, stage: nextStage };
      drafts.set(sortDrafts(next));

      const message = `${draft.title} moved to ${stageActionLabel(nextStage)}`;
      activityLog.set(appendHistory(activityLog.get(), message));
    })({ drafts, activityLog, draftId: selectedDraftId });

    const priorityColors: Record<DraftPriority, string> = {
      high: "#ef4444",
      medium: "#f59e0b",
      low: "#10b981",
    };

    const stageColors: Record<DraftStage, string> = {
      ideation: "#94a3b8",
      drafting: "#3b82f6",
      review: "#8b5cf6",
      ready: "#06b6d4",
      scheduled: "#10b981",
      published: "#6b7280",
    };

    return {
      [NAME]: name,
      [UI]: (
        <div style="
            display: flex;
            flex-direction: column;
            gap: 1.5rem;
            max-width: 60rem;
          ">
          <ct-card>
            <div
              slot="content"
              style="
                display: flex;
                flex-direction: column;
                gap: 1.25rem;
              "
            >
              <div style="
                  display: flex;
                  flex-direction: column;
                  gap: 0.25rem;
                ">
                <span style="
                    color: #475569;
                    font-size: 0.75rem;
                    letter-spacing: 0.08em;
                    text-transform: uppercase;
                  ">
                  Content Publishing Workflow
                </span>
                <h2 style="
                    margin: 0;
                    font-size: 1.3rem;
                    color: #0f172a;
                  ">
                  Track content drafts through editorial stages
                </h2>
              </div>

              <div style="
                  background: #f8fafc;
                  border-radius: 0.75rem;
                  padding: 1rem;
                  display: flex;
                  gap: 2rem;
                ">
                <div style="flex: 1; display: flex; flex-direction: column; gap: 0.25rem;">
                  <span style="font-size: 0.7rem; color: #64748b; text-transform: uppercase; letter-spacing: 0.05em;">
                    Queue
                  </span>
                  <strong style="font-size: 1.8rem; color: #0f172a;">
                    {queueCount}
                  </strong>
                  <span style="font-size: 0.75rem; color: #475569;">
                    awaiting
                  </span>
                </div>

                <div style="flex: 1; display: flex; flex-direction: column; gap: 0.25rem;">
                  <span style="font-size: 0.7rem; color: #64748b; text-transform: uppercase; letter-spacing: 0.05em;">
                    Scheduled
                  </span>
                  <strong style="font-size: 1.8rem; color: #10b981;">
                    {scheduledCount}
                  </strong>
                  <span style="font-size: 0.75rem; color: #475569;">
                    ready to go
                  </span>
                </div>

                <div style="flex: 1; display: flex; flex-direction: column; gap: 0.25rem;">
                  <span style="font-size: 0.7rem; color: #64748b; text-transform: uppercase; letter-spacing: 0.05em;">
                    Published
                  </span>
                  <strong style="font-size: 1.8rem; color: #6b7280;">
                    {publishedCount}
                  </strong>
                  <span style="font-size: 0.75rem; color: #475569;">
                    live
                  </span>
                </div>
              </div>
            </div>
          </ct-card>

          <ct-card>
            <div slot="header">
              <h3 style="margin: 0; font-size: 1rem; color: #0f172a;">
                Add New Draft
              </h3>
            </div>
            <div
              slot="content"
              style="
                display: flex;
                flex-direction: column;
                gap: 1rem;
              "
            >
              <div style="display: flex; gap: 1rem;">
                <div style="flex: 2;">
                  <label style="display: block; font-size: 0.75rem; color: #475569; margin-bottom: 0.25rem;">
                    Title
                  </label>
                  <ct-input
                    $value={newDraftTitle}
                    placeholder="Draft title..."
                    style="width: 100%;"
                  />
                </div>

                <div style="flex: 1;">
                  <label style="display: block; font-size: 0.75rem; color: #475569; margin-bottom: 0.25rem;">
                    Priority
                  </label>
                  <ct-input
                    $value={newDraftPriority}
                    placeholder="high/medium/low"
                    style="width: 100%;"
                  />
                </div>
              </div>

              <div style="display: flex; gap: 1rem;">
                <div style="flex: 2;">
                  <label style="display: block; font-size: 0.75rem; color: #475569; margin-bottom: 0.25rem;">
                    Summary
                  </label>
                  <ct-input
                    $value={newDraftSummary}
                    placeholder="Brief description..."
                    style="width: 100%;"
                  />
                </div>

                <div style="flex: 1;">
                  <label style="display: block; font-size: 0.75rem; color: #475569; margin-bottom: 0.25rem;">
                    Editor
                  </label>
                  <ct-input
                    $value={newDraftEditor}
                    placeholder="Editor name..."
                    style="width: 100%;"
                  />
                </div>
              </div>

              <div>
                <ct-button onClick={addDraftHandler}>Add Draft</ct-button>
              </div>
            </div>
          </ct-card>

          <ct-card>
            <div slot="header">
              <h3 style="margin: 0; font-size: 1rem; color: #0f172a;">
                Draft Queue ({queueCount})
              </h3>
            </div>
            <div
              slot="content"
              style="
                display: flex;
                flex-direction: column;
                gap: 0.75rem;
              "
            >
              {lift((entries: DraftEntry[]) => {
                if (entries.length === 0) {
                  return (
                    <div style="
                        text-align: center;
                        padding: 2rem;
                        color: #64748b;
                        font-size: 0.9rem;
                      ">
                      No drafts in queue. Add a new draft to get started.
                    </div>
                  );
                }

                const elements = [];
                for (const entry of entries.slice(0, 10)) {
                  const priorityColor = priorityColors[entry.priority];
                  const stageColor = stageColors[entry.stage];
                  const borderStyle =
                    "border: 1px solid #e2e8f0; border-radius: 0.5rem; padding: 0.75rem; background: white; border-left-width: 4px; border-left-color: " +
                    priorityColor + ";";
                  const stageBadgeStyle =
                    "display: inline-block; padding: 0.125rem 0.5rem; border-radius: 0.25rem; background: " +
                    stageColor +
                    "; color: white; font-weight: 500;";

                  elements.push(
                    <div key={entry.id} style={borderStyle}>
                      <div style="
                          display: flex;
                          justify-content: space-between;
                          align-items: start;
                          gap: 1rem;
                        ">
                        <div style="flex: 1;">
                          <div style="
                              font-weight: 600;
                              color: #0f172a;
                              margin-bottom: 0.25rem;
                            ">
                            {entry.title}
                          </div>
                          <div style="
                              font-size: 0.85rem;
                              color: #64748b;
                              margin-bottom: 0.5rem;
                            ">
                            {entry.summary}
                          </div>
                          <div style="
                              display: flex;
                              gap: 0.75rem;
                              font-size: 0.75rem;
                              color: #475569;
                            ">
                            <span>
                              <strong>Editor:</strong> {entry.assignedEditor}
                            </span>
                            <span>
                              <strong>Due:</strong> {entry.scheduledDate}
                            </span>
                            <span style={stageBadgeStyle}>
                              {stageLabels[entry.stage]}
                            </span>
                          </div>
                        </div>
                      </div>
                    </div>,
                  );
                }
                return elements;
              })(queue)}
            </div>
          </ct-card>

          <ct-card>
            <div slot="header">
              <h3 style="margin: 0; font-size: 1rem; color: #0f172a;">
                Draft Actions
              </h3>
            </div>
            <div
              slot="content"
              style="
                display: flex;
                flex-direction: column;
                gap: 1rem;
              "
            >
              <div>
                <label style="display: block; font-size: 0.75rem; color: #475569; margin-bottom: 0.25rem;">
                  Draft ID
                </label>
                <ct-input
                  $value={selectedDraftId}
                  placeholder="Enter draft ID..."
                  style="width: 100%; max-width: 20rem;"
                />
              </div>
              <div>
                <ct-button onClick={advanceStageHandler}>
                  Advance Stage
                </ct-button>
              </div>
            </div>
          </ct-card>

          <ct-card>
            <div slot="header">
              <h3 style="margin: 0; font-size: 1rem; color: #0f172a;">
                Activity Log
              </h3>
            </div>
            <div
              slot="content"
              style="
                display: flex;
                flex-direction: column;
                gap: 0.5rem;
              "
            >
              {lift((log: string[]) => {
                const elements = [];
                const reversed = log.slice().reverse();
                for (let idx = 0; idx < reversed.length; idx++) {
                  elements.push(
                    <div
                      key={idx}
                      style="
                        padding: 0.5rem 0.75rem;
                        background: #f8fafc;
                        border-radius: 0.375rem;
                        font-size: 0.85rem;
                        color: #475569;
                      "
                    >
                      {reversed[idx]}
                    </div>,
                  );
                }
                return elements;
              })(activityLog)}
            </div>
          </ct-card>

          <ct-card>
            <div slot="header">
              <h3 style="margin: 0; font-size: 1rem; color: #0f172a;">
                Stage Distribution
              </h3>
            </div>
            <div
              slot="content"
              style="
                display: grid;
                grid-template-columns: repeat(3, 1fr);
                gap: 1rem;
              "
            >
              {lift((totals: Record<DraftStage, number>) => {
                const elements = [];
                for (const stage of stageOrder) {
                  const count = totals[stage];
                  const color = stageColors[stage];
                  const cardStyle = "border: 2px solid " +
                    color +
                    "; border-radius: 0.5rem; padding: 1rem; text-align: center;";
                  const countStyle =
                    "font-size: 2rem; font-weight: 700; color: " +
                    color +
                    ";";

                  elements.push(
                    <div key={stage} style={cardStyle}>
                      <div style="
                          font-size: 0.7rem;
                          color: #64748b;
                          text-transform: uppercase;
                          letter-spacing: 0.05em;
                          margin-bottom: 0.5rem;
                        ">
                        {stageLabels[stage]}
                      </div>
                      <div style={countStyle}>
                        {String(count)}
                      </div>
                    </div>,
                  );
                }
                return elements;
              })(stageTotals)}
            </div>
          </ct-card>
        </div>
      ),
    };
  },
);
