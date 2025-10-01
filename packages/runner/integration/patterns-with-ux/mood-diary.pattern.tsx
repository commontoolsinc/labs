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

const MOOD_SCORE_TABLE = {
  radiant: 2,
  uplifted: 1,
  neutral: 0,
  pressed: -1,
  depleted: -2,
} as const;

type MoodLevel = keyof typeof MOOD_SCORE_TABLE;

const MOOD_DISPLAY = {
  radiant: { emoji: "✨", label: "Radiant", color: "#FFD700" },
  uplifted: { emoji: "😊", label: "Uplifted", color: "#90EE90" },
  neutral: { emoji: "😐", label: "Neutral", color: "#D3D3D3" },
  pressed: { emoji: "😔", label: "Pressed", color: "#FFA07A" },
  depleted: { emoji: "😞", label: "Depleted", color: "#FF6B6B" },
} as const;

const TIME_BUCKETS = [
  "overnight",
  "morning",
  "afternoon",
  "evening",
] as const;

type TimeBucket = typeof TIME_BUCKETS[number];

const TIME_DISPLAY = {
  overnight: { emoji: "🌙", label: "Overnight" },
  morning: { emoji: "🌅", label: "Morning" },
  afternoon: { emoji: "☀️", label: "Afternoon" },
  evening: { emoji: "🌆", label: "Evening" },
} as const;

interface MoodEntrySeed {
  id?: string;
  timestamp?: string;
  mood?: string;
  note?: string;
  tags?: unknown;
}

interface MoodEntry {
  id: string;
  timestamp: string;
  date: string;
  timeBucket: TimeBucket;
  mood: MoodLevel;
  score: number;
  note: string;
  tags: string[];
}

interface TagSentiment {
  tag: string;
  averageScore: number;
  entryCount: number;
  positiveShare: number;
}

interface TimeBucketSentiment {
  bucket: TimeBucket;
  averageScore: number;
  entryCount: number;
  positiveShare: number;
}

interface MoodMetrics {
  entryCount: number;
  averageScore: number;
  positiveCount: number;
  negativeCount: number;
  positiveShare: number;
}

interface MoodDiaryArgs {
  entries: Default<MoodEntrySeed[], []>;
}

const roundScore = (value: number): number => {
  return Math.round(value * 100) / 100;
};

const sanitizeTags = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const tag of value) {
    if (typeof tag !== "string") continue;
    const trimmed = tag.trim().toLowerCase();
    if (trimmed.length === 0) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    tags.push(trimmed);
  }
  return tags.sort((a, b) => a.localeCompare(b));
};

const sanitizeNote = (value: unknown): string => {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim().slice(0, 160);
};

const sanitizeMood = (value: unknown): MoodLevel => {
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized in MOOD_SCORE_TABLE) {
      return normalized as MoodLevel;
    }
  }
  return "neutral";
};

const parseTimestamp = (value: unknown): string => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      const parsed = new Date(trimmed);
      if (!Number.isNaN(parsed.getTime())) {
        return parsed.toISOString();
      }
    }
  }
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString();
  }
  return "1970-01-01T00:00:00.000Z";
};

const bucketForTimestamp = (iso: string): TimeBucket => {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) {
    return "overnight";
  }
  const hour = parsed.getUTCHours();
  if (hour >= 5 && hour < 12) return "morning";
  if (hour >= 12 && hour < 17) return "afternoon";
  if (hour >= 17 && hour < 22) return "evening";
  return "overnight";
};

const sanitizeId = (
  raw: unknown,
  iso: string,
  mood: MoodLevel,
  tags: readonly string[],
  fallback: string,
): string => {
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }
  const tagHint = tags[0] ?? "untagged";
  return `${iso}-${mood}-${tagHint}-${fallback}`;
};

const sortEntries = (left: MoodEntry, right: MoodEntry): number => {
  const timestampCompare = left.timestamp.localeCompare(right.timestamp);
  if (timestampCompare !== 0) {
    return timestampCompare;
  }
  return left.id.localeCompare(right.id);
};

const normalizeEntries = (entries: readonly MoodEntry[]): MoodEntry[] => {
  const deduped = new Map<string, MoodEntry>();
  for (const entry of entries) {
    deduped.set(entry.id, entry);
  }
  return Array.from(deduped.values()).sort(sortEntries);
};

const toMoodEntry = (
  seed: MoodEntrySeed | undefined,
  fallback: string,
): MoodEntry => {
  const timestamp = parseTimestamp(seed?.timestamp);
  const mood = sanitizeMood(seed?.mood);
  const tags = sanitizeTags(seed?.tags);
  const note = sanitizeNote(seed?.note);
  const id = sanitizeId(seed?.id, timestamp, mood, tags, fallback);
  const timeBucket = bucketForTimestamp(timestamp);
  return {
    id,
    timestamp,
    date: timestamp.slice(0, 10),
    timeBucket,
    mood,
    score: MOOD_SCORE_TABLE[mood],
    note,
    tags,
  };
};

const sanitizeEntryList = (
  entries: readonly MoodEntrySeed[] | undefined,
): MoodEntry[] => {
  if (!Array.isArray(entries)) {
    return [];
  }
  const sanitized = entries.map((entry, index) =>
    toMoodEntry(entry, `seed-${index + 1}`)
  );
  return normalizeEntries(sanitized);
};

const computeMetrics = (entries: readonly MoodEntry[]): MoodMetrics => {
  let total = 0;
  let positive = 0;
  let negative = 0;
  for (const entry of entries) {
    total += entry.score;
    if (entry.score > 0) positive += 1;
    if (entry.score < 0) negative += 1;
  }
  const entryCount = entries.length;
  const averageScore = entryCount === 0 ? 0 : roundScore(total / entryCount);
  const positiveShare = entryCount === 0
    ? 0
    : roundScore(positive / entryCount);
  return {
    entryCount,
    averageScore,
    positiveCount: positive,
    negativeCount: negative,
    positiveShare,
  };
};

const computeTagBreakdown = (
  entries: readonly MoodEntry[],
): TagSentiment[] => {
  const buckets = new Map<string, {
    total: number;
    count: number;
    positive: number;
  }>();
  for (const entry of entries) {
    for (const tag of entry.tags) {
      const bucket = buckets.get(tag) ?? {
        total: 0,
        count: 0,
        positive: 0,
      };
      bucket.total += entry.score;
      bucket.count += 1;
      if (entry.score > 0) {
        bucket.positive += 1;
      }
      buckets.set(tag, bucket);
    }
  }
  return Array.from(buckets.entries())
    .map(([tag, bucket]) => ({
      tag,
      averageScore: bucket.count === 0
        ? 0
        : roundScore(bucket.total / bucket.count),
      entryCount: bucket.count,
      positiveShare: bucket.count === 0
        ? 0
        : roundScore(bucket.positive / bucket.count),
    }))
    .sort((left, right) => left.tag.localeCompare(right.tag));
};

const computeTimeBreakdown = (
  entries: readonly MoodEntry[],
): TimeBucketSentiment[] => {
  const buckets = new Map<TimeBucket, {
    total: number;
    count: number;
    positive: number;
  }>();
  for (const bucket of TIME_BUCKETS) {
    buckets.set(bucket, { total: 0, count: 0, positive: 0 });
  }
  for (const entry of entries) {
    const bucket = buckets.get(entry.timeBucket);
    if (!bucket) continue;
    bucket.total += entry.score;
    bucket.count += 1;
    if (entry.score > 0) bucket.positive += 1;
  }
  const summaries: TimeBucketSentiment[] = [];
  for (const key of TIME_BUCKETS) {
    const bucket = buckets.get(key);
    if (!bucket || bucket.count === 0) continue;
    summaries.push({
      bucket: key,
      averageScore: roundScore(bucket.total / bucket.count),
      entryCount: bucket.count,
      positiveShare: roundScore(bucket.positive / bucket.count),
    });
  }
  return summaries;
};

const formatTime = (iso: string): string => {
  const date = new Date(iso);
  return date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
};

const formatDate = (iso: string): string => {
  const date = new Date(iso);
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
};

const logMoodEntry = handler(
  (
    event: MoodEntrySeed | undefined,
    context: {
      entries: Cell<MoodEntrySeed[]>;
      runtimeSeed: Cell<number>;
    },
  ) => {
    const existing = sanitizeEntryList(context.entries.get());
    const priorSeed = context.runtimeSeed.get() ?? existing.length;
    const entry = toMoodEntry(event, `runtime-${priorSeed + 1}`);
    const nextEntries = normalizeEntries([...existing, entry]);
    context.entries.set(nextEntries);
    context.runtimeSeed.set(priorSeed + 1);
  },
);

const addMoodHandler = handler(
  (
    _event: unknown,
    context: {
      moodField: Cell<string>;
      noteField: Cell<string>;
      tagsField: Cell<string>;
      entries: Cell<MoodEntrySeed[]>;
      runtimeSeed: Cell<number>;
    },
  ) => {
    const mood = sanitizeMood(context.moodField.get());
    const note = sanitizeNote(context.noteField.get());
    const tagsText = context.tagsField.get() ?? "";
    const tags = sanitizeTags(
      tagsText.split(",").map((t) => t.trim()).filter((t) => t.length > 0),
    );

    const existing = sanitizeEntryList(context.entries.get());
    const priorSeed = context.runtimeSeed.get() ?? existing.length;
    const entry = toMoodEntry(
      {
        timestamp: new Date().toISOString(),
        mood,
        note,
        tags,
      },
      `runtime-${priorSeed + 1}`,
    );
    const nextEntries = normalizeEntries([...existing, entry]);
    context.entries.set(nextEntries);
    context.runtimeSeed.set(priorSeed + 1);

    // Clear form
    context.moodField.set("neutral");
    context.noteField.set("");
    context.tagsField.set("");
  },
);

export const moodDiaryUx = recipe<MoodDiaryArgs>(
  "Mood Diary (UX)",
  ({ entries }) => {
    const runtimeSeed = cell(0);

    const entryLog = lift((value: readonly MoodEntrySeed[] | undefined) =>
      sanitizeEntryList(value)
    )(entries);
    const metrics = lift((items: readonly MoodEntry[]) =>
      computeMetrics(items)
    )(entryLog);
    const tagSentiment = lift((items: readonly MoodEntry[]) =>
      computeTagBreakdown(items)
    )(entryLog);
    const timeSentiment = lift((items: readonly MoodEntry[]) =>
      computeTimeBreakdown(items)
    )(entryLog);
    const entryCount = lift((value: MoodMetrics) => value.entryCount)(
      metrics,
    );
    const averageScore = lift((value: MoodMetrics) => value.averageScore)(
      metrics,
    );
    const positivePercent = lift((value: MoodMetrics) =>
      Math.round(value.positiveShare * 100)
    )(metrics);
    const sentimentSummary =
      str`${entryCount} moods logged avg ${averageScore} ${positivePercent}% positive`;
    const latestEntry = lift((items: readonly MoodEntry[]) =>
      items.length === 0 ? null : items[items.length - 1]
    )(entryLog);

    // UI form state
    const moodField = cell<string>("neutral");
    const noteField = cell<string>("");
    const tagsField = cell<string>("");

    const addMood = addMoodHandler({
      moodField,
      noteField,
      tagsField,
      entries,
      runtimeSeed,
    });

    const nameView = lift((count: number) => {
      if (count === 0) return "Mood Diary (Empty)";
      return "Mood Diary (" + count + " entries)";
    })(entryCount);

    // Color helper for scores
    const getScoreColor = (score: number): string => {
      if (score >= 1.5) return "#FFD700";
      if (score >= 0.5) return "#90EE90";
      if (score > -0.5) return "#D3D3D3";
      if (score > -1.5) return "#FFA07A";
      return "#FF6B6B";
    };

    const entriesDisplay = lift((entries: readonly MoodEntry[]) => {
      return entries.slice().reverse().slice(0, 10).map((entry) => {
        const moodInfo = MOOD_DISPLAY[entry.mood];
        const timeInfo = TIME_DISPLAY[entry.timeBucket];
        return {
          ...entry,
          moodEmoji: moodInfo.emoji,
          moodLabel: moodInfo.label,
          moodColor: moodInfo.color,
          timeEmoji: timeInfo.emoji,
          formattedDate: formatDate(entry.timestamp),
          formattedTime: formatTime(entry.timestamp),
        };
      });
    })(entryLog);

    const timeDisplay = lift(
      (timeSentiment: readonly TimeBucketSentiment[]) => {
        return timeSentiment.map((time) => {
          const display = TIME_DISPLAY[time.bucket];
          return {
            ...time,
            emoji: display.emoji,
            label: display.label,
            color: getScoreColor(time.averageScore),
            width: Math.round(time.positiveShare * 100),
          };
        });
      },
    )(timeSentiment);

    const tagDisplay = lift((tagSentiment: readonly TagSentiment[]) => {
      return tagSentiment.map((tag) => ({
        ...tag,
        color: getScoreColor(tag.averageScore),
      }));
    })(tagSentiment);

    const hasEntries = lift((count: number) => count > 0)(entryCount);
    const avgScoreBorder = lift((score: number) => getScoreColor(score))(
      averageScore,
    );

    const metricsView = lift((m: MoodMetrics) => {
      const borderColor = getScoreColor(m.averageScore);
      return (
        <div style="margin-bottom: 24px;">
          <h2 style="margin: 0 0 16px 0; font-size: 18px; color: #2d3748;">
            Overview
          </h2>
          <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px;">
            <div style="background: #f7fafc; border-radius: 8px; padding: 16px; text-align: center;">
              <div style="font-size: 32px; font-weight: 700; color: #667eea;">
                {m.entryCount}
              </div>
              <div style="font-size: 12px; color: #718096; margin-top: 4px;">
                Total Entries
              </div>
            </div>
            <div
              style={"background: #f7fafc; border-radius: 8px; padding: 16px; text-align: center; border: 3px solid " +
                borderColor + ";"}
            >
              <div style="font-size: 32px; font-weight: 700; color: #2d3748;">
                {m.averageScore > 0 ? "+" : ""}
                {m.averageScore}
              </div>
              <div style="font-size: 12px; color: #718096; margin-top: 4px;">
                Avg Score
              </div>
            </div>
            <div style="background: #f7fafc; border-radius: 8px; padding: 16px; text-align: center;">
              <div style="font-size: 32px; font-weight: 700; color: #48bb78;">
                {Math.round(m.positiveShare * 100)}%
              </div>
              <div style="font-size: 12px; color: #718096; margin-top: 4px;">
                Positive
              </div>
            </div>
          </div>
        </div>
      );
    })(metrics);

    const timeView = lift(
      (
        times: ReturnType<
          typeof timeDisplay extends Cell<infer T> ? () => T : never
        >,
      ) => {
        if (times.length === 0) return null;
        const timeElements = [];
        for (const time of times) {
          timeElements.push(
            <div style="
              background: #f7fafc;
              border-radius: 8px;
              padding: 12px;
              display: flex;
              align-items: center;
              gap: 12px;
            ">
              <div style="font-size: 24px; flex-shrink: 0;">
                {time.emoji}
              </div>
              <div style="flex: 1; min-width: 0;">
                <div style="display: flex; justify-content: space-between; margin-bottom: 6px;">
                  <span style="font-weight: 600; color: #2d3748; font-size: 14px;">
                    {time.label}
                  </span>
                  <span style="color: #718096; font-size: 12px;">
                    {time.entryCount} entries · avg{" "}
                    {time.averageScore > 0 ? "+" : ""}
                    {time.averageScore}
                  </span>
                </div>
                <div style="
                  background: #e2e8f0;
                  height: 8px;
                  border-radius: 4px;
                  overflow: hidden;
                ">
                  <div
                    style={"height: 100%; background: " + time.color +
                      "; width: " + time.width + "%; transition: width 0.3s;"}
                  />
                </div>
              </div>
            </div>,
          );
        }
        return (
          <div style="margin-bottom: 24px;">
            <h2 style="margin: 0 0 16px 0; font-size: 18px; color: #2d3748;">
              Time of Day Patterns
            </h2>
            <div style="display: flex; flex-direction: column; gap: 8px;">
              {timeElements}
            </div>
          </div>
        );
      },
    )(timeDisplay);

    const tagsView = lift(
      (
        tags: ReturnType<
          typeof tagDisplay extends Cell<infer T> ? () => T : never
        >,
      ) => {
        if (tags.length === 0) return null;
        const tagElements = [];
        for (const tag of tags) {
          tagElements.push(
            <div
              style={"background: #f7fafc; border-radius: 8px; padding: 8px 12px; border-left: 4px solid " +
                tag.color + ";"}
            >
              <div style="font-weight: 600; color: #2d3748; font-size: 13px;">
                #{tag.tag}
              </div>
              <div style="font-size: 11px; color: #718096; margin-top: 2px;">
                {tag.entryCount} · {tag.averageScore > 0 ? "+" : ""}
                {tag.averageScore} avg
              </div>
            </div>,
          );
        }
        return (
          <div style="margin-bottom: 24px;">
            <h2 style="margin: 0 0 16px 0; font-size: 18px; color: #2d3748;">
              Tag Insights
            </h2>
            <div style="display: flex; flex-wrap: wrap; gap: 8px;">
              {tagElements}
            </div>
          </div>
        );
      },
    )(tagDisplay);

    const entriesView = lift(
      (
        displayEntries: ReturnType<
          typeof entriesDisplay extends Cell<infer T> ? () => T : never
        >,
      ) => {
        if (displayEntries.length === 0) {
          return (
            <div style="text-align: center; padding: 48px 24px; color: #718096;">
              <div style="font-size: 48px; margin-bottom: 16px;">📝</div>
              <p style="margin: 0; font-size: 16px;">
                No entries yet. Start tracking your mood!
              </p>
            </div>
          );
        }
        const entryElements = [];
        for (const entry of displayEntries) {
          const tagElements = [];
          for (const tag of entry.tags) {
            tagElements.push(
              <span style="
                background: white;
                color: #667eea;
                padding: 4px 8px;
                border-radius: 4px;
                font-size: 11px;
                font-weight: 600;
              ">
                #{tag}
              </span>,
            );
          }
          entryElements.push(
            <div
              style={"background: #f7fafc; border-radius: 8px; padding: 16px; border-left: 4px solid " +
                entry.moodColor + ";"}
            >
              <div style="display: flex; justify-content: space-between; align-items: start; margin-bottom: 8px;">
                <div style="display: flex; align-items: center; gap: 8px;">
                  <span style="font-size: 24px;">{entry.moodEmoji}</span>
                  <span style="font-weight: 600; color: #2d3748;">
                    {entry.moodLabel}
                  </span>
                </div>
                <div style="text-align: right; font-size: 12px; color: #718096;">
                  <div>{entry.formattedDate}</div>
                  <div>{entry.timeEmoji} {entry.formattedTime}</div>
                </div>
              </div>
              {entry.note
                ? (
                  <p style="margin: 0 0 8px 0; color: #4a5568; font-size: 14px; line-height: 1.5;">
                    {entry.note}
                  </p>
                )
                : null}
              {tagElements.length > 0
                ? (
                  <div style="display: flex; flex-wrap: wrap; gap: 6px;">
                    {tagElements}
                  </div>
                )
                : null}
            </div>,
          );
        }
        return (
          <div>
            <h2 style="margin: 0 0 16px 0; font-size: 18px; color: #2d3748;">
              Recent Entries
            </h2>
            <div style="display: flex; flex-direction: column; gap: 12px;">
              {entryElements}
            </div>
          </div>
        );
      },
    )(entriesDisplay);

    const showMetrics = lift((show: boolean) =>
      show ? "display: block;" : "display: none;"
    )(hasEntries);
    const showEmpty = lift((show: boolean) =>
      show ? "display: none;" : "display: block;"
    )(hasEntries);

    return {
      [NAME]: nameView,
      [UI]: (
        <div style="
            max-width: 800px;
            margin: 0 auto;
            padding: 20px;
            font-family: system-ui, -apple-system, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
          ">
          <div style="background: white; border-radius: 16px; padding: 24px; box-shadow: 0 8px 32px rgba(0,0,0,0.1);">
            <h1 style="margin: 0 0 8px 0; font-size: 28px; color: #2d3748;">
              🌈 Mood Diary
            </h1>
            <p style="margin: 0 0 24px 0; color: #718096; font-size: 14px;">
              Track your emotional journey
            </p>

            <div style="background: #f7fafc; border-radius: 12px; padding: 20px; margin-bottom: 24px;">
              <h2 style="margin: 0 0 16px 0; font-size: 18px; color: #2d3748;">
                How are you feeling?
              </h2>

              <div style="margin-bottom: 16px;">
                <label style="display: block; margin-bottom: 8px; font-weight: 600; color: #4a5568; font-size: 14px;">
                  Mood
                </label>
                <ct-select
                  $value={moodField}
                  style="width: 100%; padding: 10px; border: 2px solid #e2e8f0; border-radius: 8px; font-size: 14px;"
                >
                  <option value="radiant">✨ Radiant</option>
                  <option value="uplifted">😊 Uplifted</option>
                  <option value="neutral">😐 Neutral</option>
                  <option value="pressed">😔 Pressed</option>
                  <option value="depleted">😞 Depleted</option>
                </ct-select>
              </div>

              <div style="margin-bottom: 16px;">
                <label style="display: block; margin-bottom: 8px; font-weight: 600; color: #4a5568; font-size: 14px;">
                  Note (optional)
                </label>
                <ct-input
                  $value={noteField}
                  placeholder="What's on your mind?"
                  style="width: 100%; padding: 10px; border: 2px solid #e2e8f0; border-radius: 8px; font-size: 14px;"
                />
              </div>

              <div style="margin-bottom: 16px;">
                <label style="display: block; margin-bottom: 8px; font-weight: 600; color: #4a5568; font-size: 14px;">
                  Tags (comma-separated)
                </label>
                <ct-input
                  $value={tagsField}
                  placeholder="work, family, exercise"
                  style="width: 100%; padding: 10px; border: 2px solid #e2e8f0; border-radius: 8px; font-size: 14px;"
                />
              </div>

              <ct-button
                onClick={addMood}
                style="
                  width: 100%;
                  padding: 12px;
                  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                  color: white;
                  border: none;
                  border-radius: 8px;
                  font-weight: 600;
                  font-size: 16px;
                  cursor: pointer;
                "
              >
                Log Mood
              </ct-button>
            </div>

            <div style={showMetrics}>
              {metricsView}
              {timeView}
              {tagsView}
            </div>

            {entriesView}
          </div>
        </div>
      ),
      entryLog,
      metrics,
      tagSentiment,
      timeSentiment,
      sentimentSummary,
      latestEntry,
      logEntry: logMoodEntry({ entries, runtimeSeed }),
    };
  },
);

export type { MoodEntry, TagSentiment, TimeBucketSentiment };
