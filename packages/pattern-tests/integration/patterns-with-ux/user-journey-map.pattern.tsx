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

type MilestoneStatus = "planned" | "in_progress" | "completed";

interface JourneyMilestone {
  id: string;
  title: string;
  description: string;
  status: MilestoneStatus;
  dayOffset: number;
  durationDays: number;
}

interface JourneyTimelineEntry {
  id: string;
  title: string;
  status: MilestoneStatus;
  startDay: number;
  endDay: number;
  durationDays: number;
}

interface JourneyMapArgs {
  milestones: Default<JourneyMilestone[], typeof defaultMilestones>;
  anchorDay: Default<number, 0>;
}

interface JourneyUpdateEvent {
  id?: string;
  title?: string;
  description?: string;
  status?: MilestoneStatus | string;
  dayOffset?: number;
  durationDays?: number;
}

interface JourneyUpdateResult {
  list: JourneyMilestone[];
  updated: JourneyMilestone;
  index: number;
}

type StatusCounts = Record<MilestoneStatus, number>;

interface SummaryComputationInput {
  meta: { count: number; start: number; end: number };
  progress: number;
}

const defaultMilestones: JourneyMilestone[] = [
  {
    id: "discover",
    title: "Discovery",
    description: "User becomes aware of the product.",
    status: "completed",
    dayOffset: 0,
    durationDays: 1,
  },
  {
    id: "activate",
    title: "Activation",
    description: "User signs up and begins onboarding.",
    status: "in_progress",
    dayOffset: 1,
    durationDays: 2,
  },
  {
    id: "adopt",
    title: "Adoption",
    description: "User adopts core features into workflow.",
    status: "planned",
    dayOffset: 3,
    durationDays: 3,
  },
];

const sanitizeText = (value: unknown, fallback: string): string => {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  if (trimmed.length === 0) return fallback;
  return trimmed.replace(/\s+/g, " ");
};

const titleFromId = (id: string): string => {
  const normalized = id.replace(/[-_]+/g, " ");
  return normalized.replace(/\b\w/g, (char) => char.toUpperCase());
};

const sanitizeId = (value: unknown, fallback: string): string => {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim().toLowerCase();
  if (trimmed.length === 0) return fallback;
  const cleaned = trimmed.replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-");
  return cleaned.length > 0 ? cleaned : fallback;
};

const parseStatus = (value: unknown): MilestoneStatus | null => {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase().replace(/\s+/g, "_");
  if (
    normalized === "planned" || normalized === "in_progress" ||
    normalized === "completed"
  ) {
    return normalized as MilestoneStatus;
  }
  return null;
};

const sanitizeStatus = (value: unknown): MilestoneStatus => {
  return parseStatus(value) ?? "planned";
};

const sanitizeOptionalStatus = (
  value: unknown,
): MilestoneStatus | undefined => {
  return parseStatus(value) ?? undefined;
};

const sanitizeDayOffset = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  const rounded = Math.floor(value);
  return rounded < 0 ? 0 : rounded;
};

const sanitizeOptionalDayOffset = (value: unknown): number | undefined => {
  if (value === undefined) return undefined;
  return sanitizeDayOffset(value);
};

const sanitizeDuration = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) return 1;
  const rounded = Math.max(1, Math.floor(value));
  return rounded;
};

const sanitizeOptionalDuration = (value: unknown): number | undefined => {
  if (value === undefined) return undefined;
  return sanitizeDuration(value);
};

const sanitizeOptionalTitle = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.replace(/\s+/g, " ");
};

const sanitizeOptionalDescription = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  return value.trim();
};

const ensureUniqueId = (
  candidate: string,
  existing: readonly JourneyMilestone[],
): string => {
  if (!existing.some((entry) => entry.id === candidate)) {
    return candidate;
  }
  let index = 2;
  while (existing.some((entry) => entry.id === `${candidate}-${index}`)) {
    index += 1;
  }
  return `${candidate}-${index}`;
};

const sanitizeMilestone = (
  input: unknown,
  fallbackIndex: number,
): JourneyMilestone => {
  const record = typeof input === "object" && input !== null
    ? input as Record<string, unknown>
    : {};
  const fallbackId = `milestone-${fallbackIndex}`;
  const id = sanitizeId(record["id"], fallbackId);
  const title = sanitizeText(record["title"], titleFromId(id));
  const description = sanitizeText(
    record["description"],
    "Milestone description",
  );
  const status = sanitizeStatus(record["status"]);
  const dayOffset = sanitizeDayOffset(record["dayOffset"]);
  const durationDays = sanitizeDuration(record["durationDays"]);
  return { id, title, description, status, dayOffset, durationDays };
};

const sanitizeMilestoneList = (
  input: unknown,
): JourneyMilestone[] => {
  if (!Array.isArray(input) || input.length === 0) {
    return structuredClone(defaultMilestones);
  }
  const sanitized: JourneyMilestone[] = [];
  let index = 1;
  for (const entry of input) {
    const cleaned = sanitizeMilestone(entry, index);
    const uniqueId = ensureUniqueId(cleaned.id, sanitized);
    sanitized.push(
      uniqueId === cleaned.id ? cleaned : { ...cleaned, id: uniqueId },
    );
    index += 1;
  }
  sanitized.sort((left, right) => {
    if (left.dayOffset === right.dayOffset) {
      return left.id.localeCompare(right.id);
    }
    return left.dayOffset - right.dayOffset;
  });
  return sanitized;
};

const buildTimeline = (
  entries: readonly JourneyMilestone[],
  anchorDay: number,
): JourneyTimelineEntry[] => {
  const result: JourneyTimelineEntry[] = [];
  const base = Math.max(0, Math.floor(anchorDay));
  let cursor = base;
  for (const entry of entries) {
    const plannedStart = base + entry.dayOffset;
    const start = plannedStart > cursor ? plannedStart : cursor;
    const duration = Math.max(1, entry.durationDays);
    const end = start + duration;
    result.push({
      id: entry.id,
      title: entry.title,
      status: entry.status,
      startDay: start,
      endDay: end,
      durationDays: duration,
    });
    cursor = end;
  }
  return result;
};

const applyJourneyUpdate = (
  list: JourneyMilestone[],
  event: JourneyUpdateEvent | undefined,
): JourneyUpdateResult => {
  const entries = [...list];
  if (!event) {
    const fallback = entries[entries.length - 1] ?? entries[0] ??
      structuredClone(defaultMilestones[0]);
    return { list: entries, updated: fallback, index: entries.length - 1 };
  }
  const fallbackId = `milestone-${entries.length + 1}`;
  const candidateId = sanitizeId(event.id, fallbackId);
  let id = candidateId;
  const existingIndex = entries.findIndex((entry) => entry.id === id);
  if (existingIndex === -1) {
    id = ensureUniqueId(id, entries);
  }

  const nextStatus = sanitizeOptionalStatus(event.status);
  const nextOffset = sanitizeOptionalDayOffset(
    Object.hasOwn(event, "dayOffset") ? event.dayOffset : undefined,
  );
  const nextDuration = sanitizeOptionalDuration(
    Object.hasOwn(event, "durationDays") ? event.durationDays : undefined,
  );
  const nextTitle = sanitizeOptionalTitle(
    Object.hasOwn(event, "title") ? event.title : undefined,
  );
  const nextDescription = sanitizeOptionalDescription(
    Object.hasOwn(event, "description") ? event.description : undefined,
  );

  if (existingIndex >= 0) {
    const current = entries[existingIndex];
    const updated: JourneyMilestone = {
      ...current,
      title: nextTitle ?? current.title,
      description: nextDescription ?? current.description,
      status: nextStatus ?? current.status,
      dayOffset: nextOffset ?? current.dayOffset,
      durationDays: nextDuration ?? current.durationDays,
    };
    entries[existingIndex] = updated;
  } else {
    const previous = entries[entries.length - 1];
    const defaultOffset = previous
      ? previous.dayOffset + previous.durationDays
      : 0;
    const newEntry: JourneyMilestone = {
      id,
      title: nextTitle ?? titleFromId(id),
      description: nextDescription ?? "",
      status: nextStatus ?? "planned",
      dayOffset: nextOffset ?? defaultOffset,
      durationDays: nextDuration ?? 1,
    };
    entries.push(newEntry);
  }

  entries.sort((left, right) => {
    if (left.dayOffset === right.dayOffset) {
      return left.id.localeCompare(right.id);
    }
    return left.dayOffset - right.dayOffset;
  });

  const index = entries.findIndex((entry) => entry.id === id);
  const updated = entries[index];
  return { list: entries, updated, index };
};

const sanitizeAnchor = (value: number | undefined): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.floor(value));
};

export const userJourneyMapUx = recipe<JourneyMapArgs>(
  "User Journey Map",
  ({ milestones, anchorDay }) => {
    const changeLog = cell<string[]>([]);
    const sequence = cell<number>(0);

    const milestonesView = lift(sanitizeMilestoneList)(milestones);
    const anchorView = lift((value: number | undefined) =>
      sanitizeAnchor(value)
    )(anchorDay);

    const timeline = lift(
      (
        input: { entries: JourneyMilestone[]; anchor: number },
      ): JourneyTimelineEntry[] => {
        return buildTimeline(input.entries, input.anchor);
      },
    )({ entries: milestonesView, anchor: anchorView });

    const statusCounts = lift(
      (entries: JourneyTimelineEntry[]): StatusCounts => {
        const counts: StatusCounts = {
          planned: 0,
          in_progress: 0,
          completed: 0,
        };
        for (const entry of entries) {
          counts[entry.status] += 1;
        }
        return counts;
      },
    )(timeline);

    const progress = lift((counts: StatusCounts) => {
      const total = counts.planned + counts.in_progress + counts.completed;
      if (total === 0) return 0;
      return Math.round((counts.completed / total) * 100);
    })(statusCounts);

    const summaryMeta = lift((entries: JourneyTimelineEntry[]) => {
      if (entries.length === 0) {
        return { count: 0, start: 0, end: 0 };
      }
      const first = entries[0];
      const last = entries[entries.length - 1];
      return { count: entries.length, start: first.startDay, end: last.endDay };
    })(timeline);

    const summaryLabel = lift((input: SummaryComputationInput) => {
      if (input.meta.count === 0) {
        return "No milestones scheduled";
      }
      const { count, start, end } = input.meta;
      const span = `${count} milestones from day ${start}`;
      const completion = ` (${input.progress}% complete)`;
      return `${span} to day ${end}${completion}`;
    })({ meta: summaryMeta, progress });

    const changeLogView = lift((entries: string[] | undefined) =>
      Array.isArray(entries) ? entries : []
    )(changeLog);

    const updateJourney = handler(
      (
        event: JourneyUpdateEvent | undefined,
        context: {
          milestones: Cell<JourneyMilestone[]>;
          changeLog: Cell<string[]>;
          sequence: Cell<number>;
          anchor: Cell<number>;
        },
      ) => {
        const current = sanitizeMilestoneList(context.milestones.get());
        const result = applyJourneyUpdate(current, event);
        context.milestones.set(result.list);

        const anchorValue = sanitizeAnchor(context.anchor.get());
        const timelineEntries = buildTimeline(result.list, anchorValue);
        const entry = timelineEntries[result.index] ?? timelineEntries[0];

        const existingLog = context.changeLog.get();
        const log = Array.isArray(existingLog) ? existingLog : [];
        const label = `${entry.title}:${entry.startDay}-${entry.endDay}:` +
          `${entry.status}`;
        context.changeLog.set([...log, label]);

        const sequenceValue = (context.sequence.get() ?? 0) + 1;
        context.sequence.set(sequenceValue);
      },
    );

    // UI-specific cells for form inputs
    const milestoneIdField = cell<string>("");
    const milestoneTitleField = cell<string>("");
    const milestoneDescField = cell<string>("");
    const milestoneStatusField = cell<string>("planned");
    const milestoneDayField = cell<string>("");
    const milestoneDurationField = cell<string>("");

    // Handler for adding/updating milestones from UI
    const applyMilestoneUpdate = handler(
      (
        _event: unknown,
        context: {
          idField: Cell<string>;
          titleField: Cell<string>;
          descField: Cell<string>;
          statusField: Cell<string>;
          dayField: Cell<string>;
          durationField: Cell<string>;
          milestones: Cell<JourneyMilestone[]>;
          changeLog: Cell<string[]>;
          sequence: Cell<number>;
          anchor: Cell<number>;
        },
      ) => {
        const idInput = context.idField.get();
        if (typeof idInput !== "string" || idInput.trim() === "") {
          return;
        }

        const titleInput = context.titleField.get();
        const descInput = context.descField.get();
        const statusInput = context.statusField.get();
        const dayInput = context.dayField.get();
        const durationInput = context.durationField.get();

        const event: JourneyUpdateEvent = {
          id: idInput,
        };

        if (typeof titleInput === "string" && titleInput.trim() !== "") {
          event.title = titleInput;
        }
        if (typeof descInput === "string" && descInput.trim() !== "") {
          event.description = descInput;
        }
        if (typeof statusInput === "string" && statusInput.trim() !== "") {
          event.status = statusInput;
        }
        if (typeof dayInput === "string" && dayInput.trim() !== "") {
          const dayNum = Number(dayInput);
          if (Number.isFinite(dayNum)) {
            event.dayOffset = dayNum;
          }
        }
        if (
          typeof durationInput === "string" && durationInput.trim() !== ""
        ) {
          const durNum = Number(durationInput);
          if (Number.isFinite(durNum)) {
            event.durationDays = durNum;
          }
        }

        const current = sanitizeMilestoneList(context.milestones.get());
        const result = applyJourneyUpdate(current, event);
        context.milestones.set(result.list);

        const anchorValue = sanitizeAnchor(context.anchor.get());
        const timelineEntries = buildTimeline(result.list, anchorValue);
        const entry = timelineEntries[result.index] ?? timelineEntries[0];

        const existingLog = context.changeLog.get();
        const log = Array.isArray(existingLog) ? existingLog : [];
        const label = `${entry.title}:${entry.startDay}-${entry.endDay}:` +
          `${entry.status}`;
        context.changeLog.set([...log, label]);

        const sequenceValue = (context.sequence.get() ?? 0) + 1;
        context.sequence.set(sequenceValue);

        // Clear form fields after successful update
        context.idField.set("");
        context.titleField.set("");
        context.descField.set("");
        context.statusField.set("planned");
        context.dayField.set("");
        context.durationField.set("");
      },
    )({
      idField: milestoneIdField,
      titleField: milestoneTitleField,
      descField: milestoneDescField,
      statusField: milestoneStatusField,
      dayField: milestoneDayField,
      durationField: milestoneDurationField,
      milestones,
      changeLog,
      sequence,
      anchor: anchorDay,
    });

    // Render timeline entries
    const timelineDisplay = lift((entries: JourneyTimelineEntry[]) => {
      if (!entries || entries.length === 0) {
        return h(
          "div",
          {
            style: "padding: 2rem; text-align: center; color: #64748b; " +
              "background: #f1f5f9; border-radius: 0.5rem; margin: 1rem 0;",
          },
          "No milestones scheduled yet. Add one to get started!",
        );
      }

      const elements = [];
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        const statusColor = entry.status === "completed"
          ? "#10b981"
          : entry.status === "in_progress"
          ? "#3b82f6"
          : "#94a3b8";
        const bgColor = entry.status === "completed"
          ? "#d1fae5"
          : entry.status === "in_progress"
          ? "#dbeafe"
          : "#f1f5f9";
        const statusLabel = entry.status === "completed"
          ? "COMPLETED"
          : entry.status === "in_progress"
          ? "IN PROGRESS"
          : "PLANNED";

        const itemStyle = "background: " + bgColor +
          "; border-left: 4px solid " +
          statusColor + "; padding: 1rem; border-radius: 0.375rem; " +
          "margin-bottom: 0.75rem;";

        const headerStyle = "display: flex; justify-content: space-between; " +
          "align-items: center; margin-bottom: 0.5rem;";

        const badgeStyle = "background: " + statusColor + "; color: white; " +
          "padding: 0.25rem 0.5rem; border-radius: 0.25rem; font-size: 0.75rem; " +
          "font-weight: 600;";

        const timelineStyle = "font-size: 0.875rem; color: #475569; " +
          "margin-top: 0.5rem;";

        elements.push(
          h(
            "div",
            { style: itemStyle },
            h(
              "div",
              { style: headerStyle },
              h(
                "strong",
                { style: "color: #1e293b; font-size: 1rem;" },
                entry.title,
              ),
              h("span", { style: badgeStyle }, statusLabel),
            ),
            h(
              "div",
              { style: timelineStyle },
              "Day " + String(entry.startDay) + " - Day " +
                String(entry.endDay) +
                " (" + String(entry.durationDays) + " days)",
            ),
          ),
        );
      }

      return h("div", { style: "margin: 1rem 0;" }, ...elements);
    })(timeline);

    const progressBar = lift(
      (p: { progress: number; counts: StatusCounts }) => {
        const pct = String(p.progress);
        const barStyle = "width: " + pct + "%; height: 1.5rem; " +
          "background: linear-gradient(90deg, #10b981 0%, #34d399 100%); " +
          "border-radius: 0.5rem; transition: width 0.3s ease;";

        const statsStyle =
          "display: grid; grid-template-columns: repeat(3, 1fr); " +
          "gap: 1rem; margin-top: 1rem;";

        const statCardStyle = "text-align: center; padding: 1rem; " +
          "background: #f1f5f9; border-radius: 0.375rem;";

        return h(
          "div",
          {},
          h(
            "div",
            {
              style: "background: #e2e8f0; border-radius: 0.5rem; " +
                "overflow: hidden; margin-bottom: 1rem;",
            },
            h("div", { style: barStyle }),
          ),
          h(
            "div",
            {
              style: "text-align: center; font-size: 2rem; font-weight: 700; " +
                "color: #10b981; margin-bottom: 1rem;",
            },
            pct + "%",
          ),
          h(
            "div",
            { style: statsStyle },
            h(
              "div",
              { style: statCardStyle },
              h(
                "div",
                {
                  style: "font-size: 1.5rem; font-weight: 700; color: #10b981;",
                },
                String(p.counts.completed),
              ),
              h(
                "div",
                { style: "font-size: 0.875rem; color: #64748b;" },
                "Completed",
              ),
            ),
            h(
              "div",
              { style: statCardStyle },
              h(
                "div",
                {
                  style: "font-size: 1.5rem; font-weight: 700; color: #3b82f6;",
                },
                String(p.counts.in_progress),
              ),
              h(
                "div",
                { style: "font-size: 0.875rem; color: #64748b;" },
                "In Progress",
              ),
            ),
            h(
              "div",
              { style: statCardStyle },
              h(
                "div",
                {
                  style: "font-size: 1.5rem; font-weight: 700; color: #94a3b8;",
                },
                String(p.counts.planned),
              ),
              h(
                "div",
                { style: "font-size: 0.875rem; color: #64748b;" },
                "Planned",
              ),
            ),
          ),
        );
      },
    )({ progress, counts: statusCounts });

    const name = str`User Journey Map: ${summaryLabel}`;

    const ui = (
      <div style="max-width: 1000px; margin: 0 auto; padding: 1.5rem; font-family: system-ui, sans-serif; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); min-height: 100vh;">
        <div style="background: white; border-radius: 0.75rem; padding: 2rem; box-shadow: 0 10px 25px rgba(0,0,0,0.1);">
          <h1 style="margin: 0 0 0.5rem 0; color: #1e293b; font-size: 2rem;">
            🗺️ User Journey Map
          </h1>
          <p style="margin: 0 0 2rem 0; color: #64748b; font-size: 1rem;">
            Track and visualize user milestones through their journey
          </p>

          <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 1.5rem; border-radius: 0.5rem; margin-bottom: 2rem; color: white;">
            <h2 style="margin: 0 0 1rem 0; font-size: 1.25rem;">
              Journey Progress
            </h2>
            {progressBar}
          </div>

          <div style="margin-bottom: 2rem;">
            <h2 style="margin: 0 0 1rem 0; color: #1e293b; font-size: 1.5rem;">
              Timeline
            </h2>
            {timelineDisplay}
          </div>

          <div style="background: #f8fafc; padding: 1.5rem; border-radius: 0.5rem; border: 2px solid #e2e8f0;">
            <h2 style="margin: 0 0 1rem 0; color: #1e293b; font-size: 1.25rem;">
              Add / Update Milestone
            </h2>
            <div style="display: grid; gap: 1rem;">
              <div>
                <label style="display: block; margin-bottom: 0.25rem; color: #475569; font-size: 0.875rem; font-weight: 600;">
                  Milestone ID *
                </label>
                <ct-input
                  $value={milestoneIdField}
                  placeholder="e.g., onboard-complete"
                  style="width: 100%;"
                />
              </div>
              <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 1rem;">
                <div>
                  <label style="display: block; margin-bottom: 0.25rem; color: #475569; font-size: 0.875rem; font-weight: 600;">
                    Title
                  </label>
                  <ct-input
                    $value={milestoneTitleField}
                    placeholder="Milestone title"
                    style="width: 100%;"
                  />
                </div>
                <div>
                  <label style="display: block; margin-bottom: 0.25rem; color: #475569; font-size: 0.875rem; font-weight: 600;">
                    Status
                  </label>
                  <ct-input
                    $value={milestoneStatusField}
                    placeholder="planned, in_progress, completed"
                    style="width: 100%;"
                  />
                </div>
              </div>
              <div>
                <label style="display: block; margin-bottom: 0.25rem; color: #475569; font-size: 0.875rem; font-weight: 600;">
                  Description
                </label>
                <ct-input
                  $value={milestoneDescField}
                  placeholder="Brief description"
                  style="width: 100%;"
                />
              </div>
              <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 1rem;">
                <div>
                  <label style="display: block; margin-bottom: 0.25rem; color: #475569; font-size: 0.875rem; font-weight: 600;">
                    Day Offset
                  </label>
                  <ct-input
                    $value={milestoneDayField}
                    placeholder="0"
                    style="width: 100%;"
                  />
                </div>
                <div>
                  <label style="display: block; margin-bottom: 0.25rem; color: #475569; font-size: 0.875rem; font-weight: 600;">
                    Duration (days)
                  </label>
                  <ct-input
                    $value={milestoneDurationField}
                    placeholder="1"
                    style="width: 100%;"
                  />
                </div>
              </div>
              <ct-button
                onClick={applyMilestoneUpdate}
                style="margin-top: 0.5rem;"
              >
                💾 Save Milestone
              </ct-button>
            </div>
          </div>
        </div>
      </div>
    );

    return {
      [NAME]: name,
      [UI]: ui,
      anchorDay: anchorView,
      milestones: milestonesView,
      timeline,
      statusCounts,
      progress,
      label: str`Journey timeline: ${summaryLabel}`,
      changeLog: changeLogView,
      updateMilestone: updateJourney({
        milestones,
        changeLog,
        sequence,
        anchor: anchorDay,
      }),
    };
  },
);
