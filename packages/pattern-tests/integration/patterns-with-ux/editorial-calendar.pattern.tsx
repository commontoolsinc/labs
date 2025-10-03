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
  UI,
} from "commontools";

type PublishInput = string | number | undefined;

interface EditorialEntrySeed {
  id?: string;
  title?: string;
  summary?: string;
  channel?: string;
  publishDate?: PublishInput;
}

interface EditorialEntry {
  id: string;
  title: string;
  summary: string;
  channel: string;
  publishDate: string;
}

interface EditorialCalendarArgs {
  entries: Default<EditorialEntrySeed[], typeof defaultEntries>;
  channels: Default<string[], typeof defaultChannels>;
}

interface PlanPublicationEvent {
  id?: string;
  title?: string;
  summary?: string;
  channel?: string;
  publishDate?: PublishInput;
}

interface ChannelScheduleEntry {
  id: string;
  title: string;
  publishDate: string;
}

interface ChannelSchedule {
  channel: string;
  entries: ChannelScheduleEntry[];
  upcomingLabel: string;
}

interface NextPublish {
  id: string;
  title: string;
  channel: string;
  publishDate: string;
}

const defaultChannels: string[] = ["Blog", "Newsletter", "Podcast"];

const defaultEntries: EditorialEntry[] = [
  {
    id: "blog-weekly-roundup-20240708",
    title: "Weekly Roundup",
    summary: "Highlights from the blog pipeline.",
    channel: "Blog",
    publishDate: "2024-07-08",
  },
  {
    id: "newsletter-product-update-20240710",
    title: "Product Update",
    summary: "Feature update for newsletter readers.",
    channel: "Newsletter",
    publishDate: "2024-07-10",
  },
  {
    id: "podcast-founder-interview-20240712",
    title: "Founder Interview",
    summary: "Conversation with the founders.",
    channel: "Podcast",
    publishDate: "2024-07-12",
  },
];

const safeText = (value: unknown): string => {
  if (typeof value !== "string") return "";
  const trimmed = value.trim().replace(/\s+/g, " ");
  return trimmed;
};

const capitalizeWord = (word: string): string => {
  if (word.length === 0) return word;
  return word[0].toUpperCase() + word.slice(1).toLowerCase();
};

const sanitizeChannelName = (value: unknown, fallback: string): string => {
  const base = safeText(value);
  if (base.length === 0) return fallback;
  const normalized = base
    .split(" ")
    .filter((part) => part.length > 0)
    .map(capitalizeWord)
    .join(" ");
  return normalized.length > 0 ? normalized : fallback;
};

const sanitizeChannelList = (value: unknown): string[] => {
  const list = Array.isArray(value) ? value : defaultChannels;
  const sanitized: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < list.length; index += 1) {
    const fallback = defaultChannels[index % defaultChannels.length];
    const name = sanitizeChannelName(list[index], fallback);
    const key = name.toLowerCase();
    if (key.length === 0 || seen.has(key)) continue;
    seen.add(key);
    sanitized.push(name);
  }
  if (sanitized.length === 0) {
    return [...defaultChannels];
  }
  return sanitized;
};

const sanitizeTitle = (value: unknown, fallback: string): string => {
  const base = safeText(value);
  if (base.length === 0) return fallback;
  return base[0].toUpperCase() + base.slice(1);
};

const sanitizeSummary = (value: unknown, fallback: string): string => {
  const base = safeText(value);
  return base.length > 0 ? base : fallback;
};

const suggestPublishDate = (sequence: number): string => {
  const baseDay = 8 + (sequence % 10) * 2;
  const day = ((baseDay - 1) % 28) + 1;
  return `2024-07-${day.toString().padStart(2, "0")}`;
};

const normalizeDateDigits = (value: string): string | null => {
  if (/^\d{8}$/.test(value)) {
    const year = value.slice(0, 4);
    const month = value.slice(4, 6);
    const day = value.slice(6, 8);
    return `${year}-${month}-${day}`;
  }
  return null;
};

const datePattern = /^\d{4}-\d{2}-\d{2}$/;

const sanitizePublishDate = (
  value: PublishInput,
  fallback: string,
  sequence: number,
): string => {
  if (typeof value === "string") {
    const normalized = value.trim().replace(/\//g, "-");
    const digits = normalizeDateDigits(normalized);
    if (digits && datePattern.test(digits)) return digits;
    if (datePattern.test(normalized)) return normalized;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const day = Math.min(28, Math.max(1, Math.trunc(value)));
    return `2024-07-${day.toString().padStart(2, "0")}`;
  }
  if (datePattern.test(fallback)) return fallback;
  return suggestPublishDate(sequence);
};

const safeIdentifier = (value: string): string => {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
};

const sanitizeIdentifier = (
  value: unknown,
  title: string,
  channel: string,
  publishDate: string,
  fallback: string,
): string => {
  if (typeof value === "string") {
    const fromValue = safeIdentifier(value);
    if (fromValue.length > 0) return fromValue;
  }
  const channelSlug = safeIdentifier(channel);
  const titleSlug = safeIdentifier(title);
  const dateDigits = publishDate.replace(/[^0-9]/g, "");
  const candidate = [channelSlug, titleSlug, dateDigits]
    .filter((part) => part.length > 0)
    .join("-");
  if (candidate.length > 0) return candidate;
  const fallbackSlug = safeIdentifier(fallback);
  if (fallbackSlug.length > 0) return fallbackSlug;
  return "schedule-entry";
};

const ensureUniqueId = (
  candidate: string,
  used: Set<string>,
  fallback: string,
): string => {
  const base = candidate.length > 0 ? candidate : fallback;
  if (base.length === 0) {
    used.add("schedule-entry");
    return "schedule-entry";
  }
  let current = base;
  let suffix = 2;
  while (used.has(current)) {
    current = `${base}-${suffix}`;
    suffix += 1;
  }
  used.add(current);
  return current;
};

const normalizeChannel = (
  value: unknown,
  fallback: string,
  channels: readonly string[],
): string => {
  const candidate = sanitizeChannelName(value, fallback);
  const match = channels.find((item) =>
    item.toLowerCase() === candidate.toLowerCase()
  );
  if (match) return match;
  if (channels.length > 0) return channels[0];
  return fallback;
};

const sanitizeEntry = (
  seed: EditorialEntrySeed | undefined,
  fallback: EditorialEntry,
  sequence: number,
  channels: readonly string[],
  used: Set<string>,
): EditorialEntry => {
  const title = sanitizeTitle(seed?.title, fallback.title);
  const summary = sanitizeSummary(seed?.summary, fallback.summary);
  const channel = normalizeChannel(seed?.channel, fallback.channel, channels);
  const publishDate = sanitizePublishDate(
    seed?.publishDate,
    fallback.publishDate,
    sequence,
  );
  const candidateId = sanitizeIdentifier(
    seed?.id,
    title,
    channel,
    publishDate,
    fallback.id,
  );
  const id = ensureUniqueId(candidateId, used, fallback.id);
  return {
    id,
    title,
    summary,
    channel,
    publishDate,
  };
};

const buildFallbackEntry = (
  index: number,
  channels: readonly string[],
): EditorialEntry => {
  const reference = defaultEntries[index % defaultEntries.length];
  const fallbackChannel = channels[0] ?? reference.channel ?? "Blog";
  const channel = normalizeChannel(
    reference.channel,
    fallbackChannel,
    channels,
  );
  const title = sanitizeTitle(reference.title, `Untitled ${index + 1}`);
  const summary = sanitizeSummary(
    reference.summary,
    "Pending content summary.",
  );
  const publishDate = sanitizePublishDate(
    reference.publishDate,
    suggestPublishDate(index),
    index,
  );
  const id = sanitizeIdentifier(
    reference.id,
    title,
    channel,
    publishDate,
    reference.id,
  );
  return {
    id,
    title,
    summary,
    channel,
    publishDate,
  };
};

const compareDate = (a: string, b: string): number => {
  if (a === b) return 0;
  const [aYear, aMonth, aDay] = a.split("-").map((part) => Number(part));
  const [bYear, bMonth, bDay] = b.split("-").map((part) => Number(part));
  if (aYear !== bYear) return aYear - bYear;
  if (aMonth !== bMonth) return aMonth - bMonth;
  return aDay - bDay;
};

const sortEntries = (entries: readonly EditorialEntry[]): EditorialEntry[] => {
  return entries.slice().sort((left, right) => {
    const dateDiff = compareDate(left.publishDate, right.publishDate);
    if (dateDiff !== 0) return dateDiff;
    const channelDiff = left.channel.localeCompare(right.channel);
    if (channelDiff !== 0) return channelDiff;
    return left.title.localeCompare(right.title);
  });
};

const sanitizeEntryList = (
  value: readonly EditorialEntrySeed[] | undefined,
  channels: readonly string[],
): EditorialEntry[] => {
  const seeds = Array.isArray(value) && value.length > 0
    ? value
    : defaultEntries;
  const sanitized: EditorialEntry[] = [];
  const used = new Set<string>();
  for (let index = 0; index < seeds.length; index += 1) {
    const fallback = buildFallbackEntry(index, channels);
    const entry = sanitizeEntry(seeds[index], fallback, index, channels, used);
    sanitized.push(entry);
  }
  return sortEntries(sanitized);
};

const buildChannelSchedule = (
  entries: readonly EditorialEntry[],
  channels: readonly string[],
): ChannelSchedule[] => {
  const fallback = channels[0] ?? defaultChannels[0];
  const bucket = new Map<string, ChannelSchedule>();
  for (const channel of channels) {
    bucket.set(channel, {
      channel,
      entries: [],
      upcomingLabel: "No scheduled posts",
    });
  }
  if (!bucket.has(fallback)) {
    bucket.set(fallback, {
      channel: fallback,
      entries: [],
      upcomingLabel: "No scheduled posts",
    });
  }
  for (const entry of entries) {
    const target = bucket.get(entry.channel) ?? bucket.get(fallback)!;
    target.entries.push({
      id: entry.id,
      title: entry.title,
      publishDate: entry.publishDate,
    });
  }
  for (const schedule of bucket.values()) {
    schedule.entries.sort((left, right) =>
      compareDate(left.publishDate, right.publishDate)
    );
    if (schedule.entries.length > 0) {
      const head = schedule.entries[0];
      schedule.upcomingLabel = `${head.title} on ${head.publishDate}`;
    }
  }
  return channels.map((channel) => bucket.get(channel)!).map((item) => ({
    channel: item.channel,
    entries: item.entries.slice(),
    upcomingLabel: item.upcomingLabel,
  }));
};

const selectNextPublish = (
  entries: readonly EditorialEntry[],
): NextPublish | null => {
  if (entries.length === 0) return null;
  const [next] = sortEntries(entries);
  return {
    id: next.id,
    title: next.title,
    channel: next.channel,
    publishDate: next.publishDate,
  };
};

const buildSummary = (
  channels: readonly string[],
  entries: readonly EditorialEntry[],
  next: NextPublish | null,
): string => {
  const base = `${channels.length} channels, ${entries.length} scheduled`;
  if (!next) {
    return `${base}, no upcoming release`;
  }
  return `${base}, next ${next.title} (${next.channel}) on ${next.publishDate}`;
};

const trimHistory = (
  history: readonly string[] | undefined,
  entry: string,
): string[] => {
  const log = Array.isArray(history) ? history : [];
  const next = [...log, entry];
  return next.length > 8 ? next.slice(next.length - 8) : next;
};

const planPublication = handler(
  (
    event: PlanPublicationEvent | undefined,
    context: {
      entries: Cell<EditorialEntrySeed[]>;
      channels: Cell<string[]>;
      history: Cell<string[]>;
    },
  ) => {
    const normalizedChannels = sanitizeChannelList(context.channels.get());
    context.channels.set(normalizedChannels);
    const currentEntries = sanitizeEntryList(
      context.entries.get(),
      normalizedChannels,
    );
    const used = new Set(currentEntries.map((item) => item.id));
    const history = trimHistory(context.history.get(), "Calendar sanitized");
    context.history.set(history);

    if (!event) {
      context.entries.set(currentEntries);
      return;
    }

    const eventId = typeof event.id === "string"
      ? safeIdentifier(event.id)
      : "";
    const existingIndex = eventId.length > 0
      ? currentEntries.findIndex((item) => item.id === eventId)
      : -1;

    if (existingIndex >= 0) {
      used.delete(currentEntries[existingIndex].id);
      const fallback = currentEntries[existingIndex];
      const updated = sanitizeEntry(
        {
          id: fallback.id,
          title: event.title ?? fallback.title,
          summary: event.summary ?? fallback.summary,
          channel: event.channel ?? fallback.channel,
          publishDate: event.publishDate ?? fallback.publishDate,
        },
        fallback,
        existingIndex,
        normalizedChannels,
        used,
      );
      const nextEntries = [...currentEntries];
      nextEntries[existingIndex] = updated;
      const sorted = sortEntries(nextEntries);
      context.entries.set(sorted);
      const message =
        `Updated ${updated.title} to ${updated.channel} on ${updated.publishDate}`;
      context.history.set(trimHistory(context.history.get(), message));
      return;
    }

    const fallback = buildFallbackEntry(
      currentEntries.length,
      normalizedChannels,
    );
    const created = sanitizeEntry(
      {
        id: event.id,
        title: event.title,
        summary: event.summary,
        channel: event.channel,
        publishDate: event.publishDate,
      },
      fallback,
      currentEntries.length,
      normalizedChannels,
      used,
    );
    const nextEntries = sortEntries([...currentEntries, created]);
    context.entries.set(nextEntries);
    const message =
      `Scheduled ${created.title} in ${created.channel} for ${created.publishDate}`;
    context.history.set(trimHistory(context.history.get(), message));
  },
);

const defineChannel = handler(
  (
    event: { channel?: string } | undefined,
    context: { channels: Cell<string[]>; history: Cell<string[]> },
  ) => {
    const current = sanitizeChannelList(context.channels.get());
    const candidate = sanitizeChannelName(event?.channel, "");
    if (candidate.length === 0) {
      context.channels.set(current);
      return;
    }
    const exists = current.some((name) =>
      name.toLowerCase() === candidate.toLowerCase()
    );
    if (exists) {
      context.channels.set(current);
      return;
    }
    const next = [...current, candidate];
    context.channels.set(next);
    const message = `Added channel ${candidate}`;
    context.history.set(trimHistory(context.history.get(), message));
  },
);

export const editorialCalendarUx = recipe<EditorialCalendarArgs>(
  "Editorial Calendar",
  ({ entries, channels }) => {
    const history = cell<string[]>(["Calendar initialized"]);

    const channelList = lift(sanitizeChannelList)(channels);

    const entriesView = lift(
      (
        state: {
          entries: readonly EditorialEntrySeed[] | undefined;
          channels: readonly string[];
        },
      ) => sanitizeEntryList(state.entries, state.channels),
    )({
      entries,
      channels: channelList,
    });

    const channelSchedule = lift(
      (
        state: {
          entries: readonly EditorialEntry[];
          channels: readonly string[];
        },
      ) => buildChannelSchedule(state.entries, state.channels),
    )({
      entries: entriesView,
      channels: channelList,
    });

    const nextPublish = lift(selectNextPublish)(entriesView);

    const summaryLabel = lift(
      (
        state: {
          channels: readonly string[];
          entries: readonly EditorialEntry[];
          next: NextPublish | null;
        },
      ) => buildSummary(state.channels, state.entries, state.next),
    )({
      channels: channelList,
      entries: entriesView,
      next: nextPublish,
    });

    const historyView = lift((value: readonly string[] | undefined) =>
      Array.isArray(value) && value.length > 0
        ? value
        : ["Calendar initialized"]
    )(history);

    const latestActivity = lift((log: readonly string[]) =>
      log.length > 0 ? log[log.length - 1] : "Calendar initialized"
    )(historyView);

    // Form fields
    const titleField = cell<string>("");
    const summaryField = cell<string>("");
    const channelField = cell<string>("");
    const dateField = cell<string>("");
    const idField = cell<string>("");
    const newChannelField = cell<string>("");

    // UI handlers
    const schedulePost = handler(
      (
        _event: unknown,
        context: {
          titleField: Cell<string>;
          summaryField: Cell<string>;
          channelField: Cell<string>;
          dateField: Cell<string>;
          entries: Cell<EditorialEntrySeed[]>;
          channels: Cell<string[]>;
          history: Cell<string[]>;
        },
      ) => {
        const title = context.titleField.get();
        const summary = context.summaryField.get();
        const channel = context.channelField.get();
        const date = context.dateField.get();

        if (
          typeof title !== "string" || title.trim() === "" ||
          typeof summary !== "string" || summary.trim() === ""
        ) {
          return;
        }

        const normalizedChannels = sanitizeChannelList(context.channels.get());
        context.channels.set(normalizedChannels);
        const currentEntries = sanitizeEntryList(
          context.entries.get(),
          normalizedChannels,
        );
        const used = new Set(currentEntries.map((item) => item.id));

        const fallback = buildFallbackEntry(
          currentEntries.length,
          normalizedChannels,
        );
        const created = sanitizeEntry(
          {
            title: title.trim(),
            summary: summary.trim(),
            channel: channel || undefined,
            publishDate: date || undefined,
          },
          fallback,
          currentEntries.length,
          normalizedChannels,
          used,
        );

        const nextEntries = sortEntries([...currentEntries, created]);
        context.entries.set(nextEntries);
        const message =
          `Scheduled ${created.title} in ${created.channel} for ${created.publishDate}`;
        context.history.set(trimHistory(context.history.get(), message));

        context.titleField.set("");
        context.summaryField.set("");
        context.channelField.set("");
        context.dateField.set("");
      },
    )({
      titleField,
      summaryField,
      channelField,
      dateField,
      entries,
      channels,
      history,
    });

    const updatePost = handler(
      (
        _event: unknown,
        context: {
          idField: Cell<string>;
          titleField: Cell<string>;
          summaryField: Cell<string>;
          channelField: Cell<string>;
          dateField: Cell<string>;
          entries: Cell<EditorialEntrySeed[]>;
          channels: Cell<string[]>;
          history: Cell<string[]>;
        },
      ) => {
        const id = context.idField.get();
        if (typeof id !== "string" || id.trim() === "") {
          return;
        }

        const normalizedChannels = sanitizeChannelList(context.channels.get());
        context.channels.set(normalizedChannels);
        const currentEntries = sanitizeEntryList(
          context.entries.get(),
          normalizedChannels,
        );

        const eventId = safeIdentifier(id.trim());
        const existingIndex = currentEntries.findIndex((item) =>
          item.id === eventId
        );

        if (existingIndex < 0) {
          return;
        }

        const used = new Set(currentEntries.map((item) => item.id));
        used.delete(currentEntries[existingIndex].id);

        const fallback = currentEntries[existingIndex];
        const title = context.titleField.get();
        const summary = context.summaryField.get();
        const channel = context.channelField.get();
        const date = context.dateField.get();

        const updated = sanitizeEntry(
          {
            id: fallback.id,
            title: (typeof title === "string" && title.trim() !== "")
              ? title.trim()
              : fallback.title,
            summary: (typeof summary === "string" && summary.trim() !== "")
              ? summary.trim()
              : fallback.summary,
            channel: (typeof channel === "string" && channel.trim() !== "")
              ? channel.trim()
              : fallback.channel,
            publishDate: (typeof date === "string" && date.trim() !== "")
              ? date.trim()
              : fallback.publishDate,
          },
          fallback,
          existingIndex,
          normalizedChannels,
          used,
        );

        const nextEntries = [...currentEntries];
        nextEntries[existingIndex] = updated;
        const sorted = sortEntries(nextEntries);
        context.entries.set(sorted);
        const message =
          `Updated ${updated.title} to ${updated.channel} on ${updated.publishDate}`;
        context.history.set(trimHistory(context.history.get(), message));

        context.idField.set("");
        context.titleField.set("");
        context.summaryField.set("");
        context.channelField.set("");
        context.dateField.set("");
      },
    )({
      idField,
      titleField,
      summaryField,
      channelField,
      dateField,
      entries,
      channels,
      history,
    });

    const addChannel = handler(
      (
        _event: unknown,
        context: {
          newChannelField: Cell<string>;
          channels: Cell<string[]>;
          history: Cell<string[]>;
        },
      ) => {
        const channelName = context.newChannelField.get();
        const current = sanitizeChannelList(context.channels.get());
        const candidate = sanitizeChannelName(channelName, "");

        if (candidate.length === 0) {
          return;
        }

        const exists = current.some((name) =>
          name.toLowerCase() === candidate.toLowerCase()
        );
        if (exists) {
          return;
        }

        const next = [...current, candidate];
        context.channels.set(next);
        const message = `Added channel ${candidate}`;
        context.history.set(trimHistory(context.history.get(), message));

        context.newChannelField.set("");
      },
    )({ newChannelField, channels, history });

    const name = lift(
      (state: { next: NextPublish | null; count: number }) => {
        if (!state.next) {
          return `Editorial Calendar (${state.count} posts)`;
        }
        return `Editorial Calendar • Next: ${state.next.title}`;
      },
    )({
      next: nextPublish,
      count: lift((e: readonly EditorialEntry[]) => e.length)(entriesView),
    });

    const nextSection = lift(
      (next: NextPublish | null) => {
        if (!next) {
          return (
            <div style="background: #f3f4f6; padding: 1rem; border-radius: 8px; margin-bottom: 1rem; text-align: center; color: #6b7280;">
              No posts scheduled yet
            </div>
          );
        }
        return (
          <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 1rem; border-radius: 8px; margin-bottom: 1rem;">
            <div style="font-size: 0.75rem; opacity: 0.9; margin-bottom: 0.25rem;">
              NEXT TO PUBLISH
            </div>
            <div style="font-size: 1.25rem; font-weight: 600; margin-bottom: 0.5rem;">
              {next.title}
            </div>
            <div style="display: flex; gap: 1rem; font-size: 0.875rem;">
              <span style="background: rgba(255,255,255,0.2); padding: 0.25rem 0.5rem; border-radius: 4px;">
                {next.channel}
              </span>
              <span style="background: rgba(255,255,255,0.2); padding: 0.25rem 0.5rem; border-radius: 4px; font-family: monospace;">
                {next.publishDate}
              </span>
            </div>
          </div>
        );
      },
    )(nextPublish);

    const scheduleDisplay = lift(
      (schedule: readonly ChannelSchedule[]) => {
        const cards = [];
        for (const ch of schedule) {
          const channelColor = ch.channel === "Blog"
            ? "#3b82f6"
            : ch.channel === "Newsletter"
            ? "#8b5cf6"
            : "#ec4899";
          const cardStyle = "background: white; border: 2px solid " +
            channelColor +
            "; border-radius: 8px; padding: 1rem; margin-bottom: 0.75rem;";

          const entryElements = [];
          for (const entry of ch.entries) {
            entryElements.push(
              h(
                "div",
                {
                  style:
                    "display: flex; justify-content: space-between; padding: 0.5rem; background: #f9fafb; border-radius: 4px; margin-bottom: 0.25rem;",
                },
                h("span", { style: "font-size: 0.875rem;" }, entry.title),
                h(
                  "span",
                  {
                    style:
                      "font-size: 0.75rem; color: #6b7280; font-family: monospace;",
                  },
                  entry.publishDate,
                ),
              ),
            );
          }

          cards.push(
            h(
              "div",
              { style: cardStyle },
              h(
                "div",
                {
                  style:
                    "display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.75rem;",
                },
                h(
                  "div",
                  {
                    style: "font-weight: 600; font-size: 1rem; color: " +
                      channelColor + ";",
                  },
                  ch.channel,
                ),
                h(
                  "div",
                  {
                    style: "background: " + channelColor +
                      "; color: white; padding: 0.25rem 0.5rem; border-radius: 12px; font-size: 0.75rem; font-weight: 600;",
                  },
                  String(ch.entries.length),
                ),
              ),
              ch.entries.length > 0 ? h("div", {}, ...entryElements) : h(
                "div",
                {
                  style:
                    "text-align: center; color: #9ca3af; font-size: 0.875rem; padding: 0.5rem;",
                },
                "No scheduled posts",
              ),
            ),
          );
        }
        return h("div", {}, ...cards);
      },
    )(channelSchedule);

    const activityDisplay = lift(
      (history: readonly string[]) => {
        const recent = history.slice().reverse().slice(0, 5).join(" • ");
        return recent;
      },
    )(historyView);

    const ui = (
      <div style="font-family: system-ui, sans-serif; max-width: 900px; margin: 0 auto; padding: 1rem;">
        <div style="margin-bottom: 1.5rem;">
          <h1 style="font-size: 1.75rem; font-weight: 700; margin-bottom: 0.5rem; color: #1f2937;">
            Editorial Calendar
          </h1>
          <p style="color: #6b7280; font-size: 0.875rem;">{summaryLabel}</p>
        </div>
        {nextSection}
        <div style="margin-bottom: 1.5rem;">
          <h2 style="font-size: 1.25rem; font-weight: 600; margin-bottom: 0.75rem; color: #1f2937;">
            Channel Schedule
          </h2>
          {scheduleDisplay}
        </div>
        <ct-card style="margin-bottom: 1.5rem;">
          <h2 style="font-size: 1.125rem; font-weight: 600; margin-bottom: 1rem; color: #1f2937;">
            Schedule New Post
          </h2>
          <div style="display: flex; flex-direction: column; gap: 0.75rem;">
            <ct-input
              $value={titleField}
              placeholder="Post title"
              style="width: 100%;"
            />
            <ct-input
              $value={summaryField}
              placeholder="Summary"
              style="width: 100%;"
            />
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 0.75rem;">
              <ct-input
                $value={channelField}
                placeholder="Channel (optional)"
              />
              <ct-input
                $value={dateField}
                placeholder="Date YYYY-MM-DD (optional)"
              />
            </div>
            <ct-button onClick={schedulePost} variant="primary">
              Schedule Post
            </ct-button>
          </div>
        </ct-card>
        <ct-card style="margin-bottom: 1.5rem;">
          <h2 style="font-size: 1.125rem; font-weight: 600; margin-bottom: 1rem; color: #1f2937;">
            Update Existing Post
          </h2>
          <div style="display: flex; flex-direction: column; gap: 0.75rem;">
            <ct-input
              $value={idField}
              placeholder="Post ID"
              style="width: 100%;"
            />
            <ct-input
              $value={titleField}
              placeholder="New title (optional)"
              style="width: 100%;"
            />
            <ct-input
              $value={summaryField}
              placeholder="New summary (optional)"
              style="width: 100%;"
            />
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 0.75rem;">
              <ct-input
                $value={channelField}
                placeholder="New channel (optional)"
              />
              <ct-input $value={dateField} placeholder="New date (optional)" />
            </div>
            <ct-button onClick={updatePost} variant="secondary">
              Update Post
            </ct-button>
          </div>
        </ct-card>
        <ct-card style="margin-bottom: 1.5rem;">
          <h2 style="font-size: 1.125rem; font-weight: 600; margin-bottom: 1rem; color: #1f2937;">
            Add Channel
          </h2>
          <div style="display: flex; gap: 0.75rem;">
            <ct-input
              $value={newChannelField}
              placeholder="Channel name"
              style="flex: 1;"
            />
            <ct-button onClick={addChannel} variant="primary">
              Add Channel
            </ct-button>
          </div>
        </ct-card>
        <ct-card>
          <h2 style="font-size: 1.125rem; font-weight: 600; margin-bottom: 0.75rem; color: #1f2937;">
            Recent Activity
          </h2>
          <div style="font-size: 0.875rem; color: #6b7280;">
            {activityDisplay}
          </div>
        </ct-card>
      </div>
    );

    return {
      [NAME]: name,
      [UI]: ui,
      channels,
      entries,
      channelList,
      entriesView,
      channelSchedule,
      nextPublish,
      summaryLabel,
      history: historyView,
      latestActivity,
      planPublication: planPublication({ entries, channels, history }),
      defineChannel: defineChannel({ channels, history }),
    };
  },
);
