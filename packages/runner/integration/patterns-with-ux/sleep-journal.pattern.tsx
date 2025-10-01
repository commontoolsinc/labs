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

const WEEKDAY_LABELS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

type Weekday = typeof WEEKDAY_LABELS[number];

interface SleepSessionSeed {
  id?: string;
  date?: string;
  hours?: number;
  tags?: string[];
  weekday?: Weekday;
}

interface SleepSessionEntry {
  id: string;
  date: string;
  hours: number;
  tags: string[];
  weekday: Weekday;
}

interface TagAverage {
  tag: string;
  averageHours: number;
  sessionCount: number;
}

interface WeekdayAverage {
  weekday: Weekday;
  averageHours: number;
  sessionCount: number;
}

interface SleepMetrics {
  sessionCount: number;
  totalHours: number;
  averageHours: number;
}

interface SleepJournalArgs {
  sessions: Default<SleepSessionSeed[], []>;
}

const roundHours = (value: number): number => {
  return Math.round(value * 100) / 100;
};

const toFiniteHours = (value: unknown): number => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return roundHours(Math.max(0, value));
  }
  const parsed = typeof value === "string" ? Number(value) : 0;
  if (Number.isFinite(parsed)) {
    return roundHours(Math.max(0, parsed));
  }
  return 0;
};

const isoDatePattern = /^\d{4}-\d{2}-\d{2}$/;

const toIsoDate = (value: unknown): string => {
  if (typeof value === "string" && isoDatePattern.test(value)) {
    return value;
  }
  if (typeof value === "string") {
    const attempt = new Date(value);
    if (!Number.isNaN(attempt.getTime())) {
      return attempt.toISOString().slice(0, 10);
    }
  }
  return "1970-01-01";
};

const weekdayFromDate = (date: string): Weekday => {
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) {
    return "Sunday";
  }
  const index = parsed.getUTCDay();
  return WEEKDAY_LABELS[index] ?? "Sunday";
};

const sanitizeTags = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const tag of value) {
    if (typeof tag !== "string") continue;
    const trimmed = tag.trim();
    if (trimmed.length === 0) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    tags.push(trimmed);
  }
  return tags;
};

const sanitizeId = (
  id: unknown,
  fallback: string,
  date: string,
  hours: number,
  tags: string[],
): string => {
  if (typeof id === "string") {
    const trimmed = id.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }
  const tagHint = tags[0] ?? "untagged";
  return `${date}-${tagHint}-${hours.toFixed(2)}-${fallback}`;
};

const toSessionEntry = (
  seed: SleepSessionSeed | undefined,
  fallback: string,
): SleepSessionEntry => {
  const isoDate = toIsoDate(seed?.date);
  const hours = toFiniteHours(seed?.hours);
  const tags = sanitizeTags(seed?.tags);
  const weekday = WEEKDAY_LABELS.includes(seed?.weekday as Weekday)
    ? seed?.weekday as Weekday
    : weekdayFromDate(isoDate);
  const id = sanitizeId(seed?.id, fallback, isoDate, hours, tags);
  return { id, date: isoDate, hours, tags, weekday };
};

const sanitizeSessionList = (
  entries: readonly SleepSessionSeed[] | undefined,
): SleepSessionEntry[] => {
  if (!Array.isArray(entries)) {
    return [];
  }
  return Array.from(
    entries,
    (entry, index) => toSessionEntry(entry, `seed-${index + 1}`),
  );
};

const computeTagSummaries = (
  entries: readonly SleepSessionEntry[],
): TagAverage[] => {
  const buckets = new Map<string, { total: number; count: number }>();
  for (const entry of entries) {
    for (const tag of entry.tags) {
      const bucket = buckets.get(tag) ?? { total: 0, count: 0 };
      bucket.total += entry.hours;
      bucket.count += 1;
      buckets.set(tag, bucket);
    }
  }
  return Array.from(buckets.entries())
    .map(([tag, bucket]) => ({
      tag,
      averageHours: roundHours(
        bucket.count === 0 ? 0 : bucket.total / bucket.count,
      ),
      sessionCount: bucket.count,
    }))
    .sort((a, b) => a.tag.localeCompare(b.tag));
};

const computeWeekdaySummaries = (
  entries: readonly SleepSessionEntry[],
): WeekdayAverage[] => {
  const buckets = new Map<Weekday, { total: number; count: number }>();
  for (const entry of entries) {
    const bucket = buckets.get(entry.weekday) ?? { total: 0, count: 0 };
    bucket.total += entry.hours;
    bucket.count += 1;
    buckets.set(entry.weekday, bucket);
  }
  const summaries: WeekdayAverage[] = [];
  for (const weekday of WEEKDAY_LABELS) {
    const bucket = buckets.get(weekday);
    if (!bucket) continue;
    summaries.push({
      weekday,
      averageHours: roundHours(
        bucket.count === 0 ? 0 : bucket.total / bucket.count,
      ),
      sessionCount: bucket.count,
    });
  }
  return summaries;
};

const computeMetrics = (
  entries: readonly SleepSessionEntry[],
): SleepMetrics => {
  const sessionCount = entries.length;
  const totalHours = roundHours(
    entries.reduce((sum, entry) => sum + entry.hours, 0),
  );
  const averageHours = sessionCount === 0
    ? 0
    : roundHours(totalHours / sessionCount);
  return { sessionCount, totalHours, averageHours };
};

const logSleepSession = handler(
  (
    event: SleepSessionSeed | undefined,
    context: {
      sessions: Cell<SleepSessionSeed[]>;
      idSeed: Cell<number>;
    },
  ) => {
    const priorCount = context.idSeed.get() ?? 0;
    const existing = sanitizeSessionList(context.sessions.get());
    const nextIndex = Math.max(priorCount, existing.length) + 1;
    const entry = toSessionEntry(event, `runtime-${nextIndex}`);
    const nextSeeds = [...existing, entry];
    context.sessions.set(nextSeeds);
    context.idSeed.set(nextIndex);
  },
);

export const sleepJournalUx = recipe<SleepJournalArgs>(
  "Sleep Journal",
  ({ sessions }) => {
    const idSeed = cell(0);

    const sessionLog = lift((
      entries: readonly SleepSessionSeed[] | undefined,
    ) => sanitizeSessionList(entries))(sessions);
    const tagAverages = lift((entries: readonly SleepSessionEntry[]) =>
      computeTagSummaries(entries)
    )(sessionLog);
    const weekdayAverages = lift((entries: readonly SleepSessionEntry[]) =>
      computeWeekdaySummaries(entries)
    )(sessionLog);
    const metrics = lift((entries: readonly SleepSessionEntry[]) =>
      computeMetrics(entries)
    )(sessionLog);
    const sessionCount = lift((value: SleepMetrics) => value.sessionCount)(
      metrics,
    );
    const totalHours = lift((value: SleepMetrics) => value.totalHours)(metrics);
    const averageHours = lift((value: SleepMetrics) => value.averageHours)(
      metrics,
    );
    const summary =
      str`${sessionCount} sessions averaging ${averageHours} hours`;
    const totalsLabel = str`${totalHours} total hours slept`;

    const latestView = lift((entries: readonly SleepSessionEntry[]) =>
      entries.length === 0 ? null : entries[entries.length - 1]
    )(sessionLog);

    // UI-specific state
    const dateField = cell<string>("");
    const hoursField = cell<string>("");
    const tagsField = cell<string>("");

    // Sync dateField to today's date on first load
    compute(() => {
      const current = dateField.get();
      if (
        typeof current === "string" && current.trim() === ""
      ) {
        const today = new Date().toISOString().slice(0, 10);
        dateField.set(today);
      }
    });

    const addSession = handler<
      unknown,
      {
        dateInput: Cell<string>;
        hoursInput: Cell<string>;
        tagsInput: Cell<string>;
        sessions: Cell<SleepSessionSeed[]>;
        idSeed: Cell<number>;
      }
    >((_event, { dateInput, hoursInput, tagsInput, sessions, idSeed }) => {
      const dateStr = dateInput.get();
      const hoursStr = hoursInput.get();
      const tagsStr = tagsInput.get();

      if (
        typeof dateStr !== "string" || dateStr.trim() === "" ||
        typeof hoursStr !== "string" || hoursStr.trim() === ""
      ) {
        return;
      }

      const date = toIsoDate(dateStr.trim());
      const hours = toFiniteHours(Number(hoursStr.trim()));
      const tagsArray = typeof tagsStr === "string"
        ? tagsStr.split(",").map((t) => t.trim()).filter((t) => t.length > 0)
        : [];

      const priorCount = idSeed.get() ?? 0;
      const existing = sanitizeSessionList(sessions.get());
      const nextIndex = Math.max(priorCount, existing.length) + 1;
      const entry = toSessionEntry({
        date,
        hours,
        tags: tagsArray,
      }, `runtime-${nextIndex}`);
      const nextSeeds = [...existing, entry];
      sessions.set(nextSeeds);
      idSeed.set(nextIndex);

      // Clear form fields
      hoursField.set("");
      tagsField.set("");
      const today = new Date().toISOString().slice(0, 10);
      dateField.set(today);
    })({
      dateInput: dateField,
      hoursInput: hoursField,
      tagsInput: tagsField,
      sessions,
      idSeed,
    });

    const name = str`Sleep Journal`;

    const sessionsDisplay = lift((entries: readonly SleepSessionEntry[]) => {
      if (entries.length === 0) {
        return h(
          "div",
          {
            style:
              "padding: 2rem; text-align: center; color: #64748b; border: 2px dashed #cbd5e1; border-radius: 8px; margin-top: 1rem;",
          },
          "No sleep sessions logged yet. Add your first entry above!",
        );
      }

      const reversed = entries.slice().reverse();
      const items = [];
      for (const entry of reversed) {
        const tagBadges = [];
        for (const tag of entry.tags) {
          tagBadges.push(
            h(
              "span",
              {
                style:
                  "display: inline-block; padding: 0.125rem 0.5rem; background: #dbeafe; color: #1e40af; border-radius: 9999px; font-size: 0.75rem; margin-right: 0.25rem;",
              },
              tag,
            ),
          );
        }

        const hoursColor = entry.hours >= 7 && entry.hours <= 9
          ? "#10b981"
          : entry.hours >= 6 && entry.hours < 7
          ? "#f59e0b"
          : "#ef4444";

        items.push(
          h(
            "div",
            {
              style:
                "border: 1px solid #e5e7eb; border-radius: 8px; padding: 1rem; margin-bottom: 0.5rem; background: #ffffff;",
            },
            h(
              "div",
              {
                style:
                  "display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem;",
              },
              h(
                "div",
                { style: "font-weight: 600; color: #1f2937;" },
                entry.date + " (" + entry.weekday + ")",
              ),
              h(
                "div",
                {
                  style: "font-size: 1.25rem; font-weight: 700; color: " +
                    hoursColor + ";",
                },
                String(entry.hours) + "h",
              ),
            ),
            tagBadges.length > 0
              ? h(
                "div",
                { style: "margin-top: 0.5rem;" },
                ...tagBadges,
              )
              : null,
          ),
        );
      }
      return h("div", {}, ...items);
    })(sessionLog);

    const tagAveragesDisplay = lift((tags: readonly TagAverage[]) => {
      if (tags.length === 0) {
        return h(
          "div",
          {
            style:
              "padding: 1rem; text-align: center; color: #9ca3af; font-size: 0.875rem;",
          },
          "No tags tracked yet",
        );
      }

      const cards = [];
      for (const tag of tags) {
        cards.push(
          h(
            "div",
            {
              style:
                "border: 1px solid #e5e7eb; border-radius: 8px; padding: 0.75rem; background: #f9fafb;",
            },
            h(
              "div",
              {
                style:
                  "font-weight: 600; color: #6366f1; margin-bottom: 0.25rem;",
              },
              tag.tag,
            ),
            h(
              "div",
              {
                style: "font-size: 1.125rem; font-weight: 700; color: #1f2937;",
              },
              String(tag.averageHours) + "h avg",
            ),
            h(
              "div",
              {
                style:
                  "font-size: 0.75rem; color: #6b7280; margin-top: 0.25rem;",
              },
              String(tag.sessionCount) + " sessions",
            ),
          ),
        );
      }

      return h(
        "div",
        {
          style:
            "display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 0.75rem;",
        },
        ...cards,
      );
    })(tagAverages);

    const weekdayAveragesDisplay = lift((
      days: readonly WeekdayAverage[],
    ) => {
      if (days.length === 0) {
        return h(
          "div",
          {
            style:
              "padding: 1rem; text-align: center; color: #9ca3af; font-size: 0.875rem;",
          },
          "No weekday data yet",
        );
      }

      const bars = [];
      let maxHours = 0;
      for (const day of days) {
        if (day.averageHours > maxHours) maxHours = day.averageHours;
      }

      for (const day of days) {
        const heightPercent = maxHours > 0
          ? (day.averageHours / maxHours) * 100
          : 0;

        bars.push(
          h(
            "div",
            {
              style:
                "display: flex; flex-direction: column; align-items: center; min-width: 60px;",
            },
            h(
              "div",
              {
                style:
                  "font-size: 0.75rem; font-weight: 600; color: #4b5563; margin-bottom: 0.5rem;",
              },
              day.weekday.slice(0, 3),
            ),
            h(
              "div",
              {
                style:
                  "width: 40px; height: 120px; background: #f3f4f6; border-radius: 4px; position: relative; display: flex; align-items: flex-end; overflow: hidden;",
              },
              h("div", {
                style: "width: 100%; height: " + String(heightPercent) +
                  "%; background: linear-gradient(180deg, #8b5cf6 0%, #6366f1 100%); border-radius: 4px 4px 0 0;",
              }),
            ),
            h(
              "div",
              {
                style:
                  "font-size: 0.875rem; font-weight: 700; color: #1f2937; margin-top: 0.5rem;",
              },
              String(day.averageHours) + "h",
            ),
          ),
        );
      }

      return h(
        "div",
        {
          style:
            "display: flex; justify-content: space-around; align-items: flex-end; padding: 1rem; background: #ffffff; border-radius: 8px; border: 1px solid #e5e7eb;",
        },
        ...bars,
      );
    })(weekdayAverages);

    const ui = h(
      "div",
      {
        style:
          "max-width: 900px; margin: 0 auto; padding: 1.5rem; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); min-height: 100vh;",
      },
      h(
        "div",
        {
          style:
            "background: #ffffff; border-radius: 12px; padding: 2rem; box-shadow: 0 10px 25px rgba(0,0,0,0.1);",
        },
        h(
          "h1",
          {
            style:
              "margin: 0 0 0.5rem 0; font-size: 2rem; font-weight: 800; color: #1f2937; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); -webkit-background-clip: text; -webkit-text-fill-color: transparent;",
          },
          "\ud83c\udf19 Sleep Journal",
        ),
        h(
          "div",
          {
            style:
              "font-size: 1rem; color: #6b7280; margin-bottom: 2rem; padding-bottom: 1rem; border-bottom: 2px solid #e5e7eb;",
          },
          summary,
        ),
        h(
          "div",
          {
            style:
              "background: linear-gradient(135deg, #f0f9ff 0%, #e0e7ff 100%); border-radius: 8px; padding: 1.5rem; margin-bottom: 2rem; border: 2px solid #818cf8;",
          },
          h(
            "h2",
            {
              style:
                "margin: 0 0 1rem 0; font-size: 1.125rem; font-weight: 700; color: #4c1d95;",
            },
            "Log Sleep Session",
          ),
          h(
            "div",
            { style: "display: grid; gap: 0.75rem; margin-bottom: 1rem;" },
            h(
              "label",
              { style: "display: block;" },
              h(
                "span",
                {
                  style:
                    "display: block; font-size: 0.875rem; font-weight: 600; color: #4b5563; margin-bottom: 0.25rem;",
                },
                "Date",
              ),
              h("ct-input", {
                type: "date",
                $value: dateField,
                style:
                  "width: 100%; padding: 0.5rem; border: 1px solid #d1d5db; border-radius: 6px; font-size: 0.875rem;",
              }),
            ),
            h(
              "label",
              { style: "display: block;" },
              h(
                "span",
                {
                  style:
                    "display: block; font-size: 0.875rem; font-weight: 600; color: #4b5563; margin-bottom: 0.25rem;",
                },
                "Hours slept",
              ),
              h("ct-input", {
                type: "number",
                step: "0.5",
                min: "0",
                max: "24",
                placeholder: "e.g., 7.5",
                $value: hoursField,
                style:
                  "width: 100%; padding: 0.5rem; border: 1px solid #d1d5db; border-radius: 6px; font-size: 0.875rem;",
              }),
            ),
            h(
              "label",
              { style: "display: block;" },
              h(
                "span",
                {
                  style:
                    "display: block; font-size: 0.875rem; font-weight: 600; color: #4b5563; margin-bottom: 0.25rem;",
                },
                "Tags (comma-separated, optional)",
              ),
              h("ct-input", {
                type: "text",
                placeholder: "e.g., workout, caffeine, stress",
                $value: tagsField,
                style:
                  "width: 100%; padding: 0.5rem; border: 1px solid #d1d5db; border-radius: 6px; font-size: 0.875rem;",
              }),
            ),
          ),
          h("ct-button", {
            onClick: addSession,
            style:
              "width: 100%; padding: 0.75rem; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; border: none; border-radius: 6px; font-weight: 700; font-size: 1rem; cursor: pointer;",
          }, "Add Session"),
        ),
        h(
          "div",
          {
            style:
              "display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 1rem; margin-bottom: 2rem;",
          },
          h(
            "div",
            {
              style:
                "background: linear-gradient(135deg, #fef3c7 0%, #fde68a 100%); border-radius: 8px; padding: 1rem; border: 2px solid #fbbf24;",
            },
            h(
              "div",
              {
                style:
                  "font-size: 0.75rem; text-transform: uppercase; font-weight: 600; color: #92400e; margin-bottom: 0.5rem;",
              },
              "Total Sessions",
            ),
            h(
              "div",
              { style: "font-size: 2rem; font-weight: 800; color: #78350f;" },
              sessionCount,
            ),
          ),
          h(
            "div",
            {
              style:
                "background: linear-gradient(135deg, #dbeafe 0%, #bfdbfe 100%); border-radius: 8px; padding: 1rem; border: 2px solid #3b82f6;",
            },
            h(
              "div",
              {
                style:
                  "font-size: 0.75rem; text-transform: uppercase; font-weight: 600; color: #1e3a8a; margin-bottom: 0.5rem;",
              },
              "Total Hours",
            ),
            h(
              "div",
              { style: "font-size: 2rem; font-weight: 800; color: #1e40af;" },
              totalHours,
            ),
          ),
          h(
            "div",
            {
              style:
                "background: linear-gradient(135deg, #dcfce7 0%, #bbf7d0 100%); border-radius: 8px; padding: 1rem; border: 2px solid #22c55e;",
            },
            h(
              "div",
              {
                style:
                  "font-size: 0.75rem; text-transform: uppercase; font-weight: 600; color: #14532d; margin-bottom: 0.5rem;",
              },
              "Average Hours",
            ),
            h(
              "div",
              { style: "font-size: 2rem; font-weight: 800; color: #15803d;" },
              averageHours,
            ),
          ),
        ),
        h(
          "h2",
          {
            style:
              "margin: 2rem 0 1rem 0; font-size: 1.25rem; font-weight: 700; color: #1f2937;",
          },
          "Sleep by Weekday",
        ),
        weekdayAveragesDisplay,
        h(
          "h2",
          {
            style:
              "margin: 2rem 0 1rem 0; font-size: 1.25rem; font-weight: 700; color: #1f2937;",
          },
          "Sleep by Tag",
        ),
        tagAveragesDisplay,
        h(
          "h2",
          {
            style:
              "margin: 2rem 0 1rem 0; font-size: 1.25rem; font-weight: 700; color: #1f2937;",
          },
          "Recent Sessions",
        ),
        sessionsDisplay,
      ),
    );

    return {
      [NAME]: name,
      [UI]: ui,
      sessionLog,
      tagAverages,
      weekdayAverages,
      metrics,
      summary,
      totalsLabel,
      latestEntry: latestView,
      log: logSleepSession({ sessions, idSeed }),
    };
  },
);

export type { SleepSessionEntry };
