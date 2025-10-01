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

type TrendDirection = "steady" | "rising" | "falling";

interface SatisfactionSampleInput {
  id?: string;
  date?: string;
  score?: number;
  responses?: number;
  channel?: string;
}

interface SatisfactionEntry extends SatisfactionSampleInput {
  id: string;
  date: string;
  score: number;
  responses: number;
  channel: string;
}

interface DailySummaryInternal {
  date: string;
  weightedSum: number;
  responseCount: number;
  average: number;
}

interface DailySummary {
  date: string;
  average: number;
  responseCount: number;
}

interface MovingAveragePoint {
  date: string;
  dailyAverage: number;
  trailing3: number;
  trailing7: number;
}

interface CustomerSatisfactionArgs {
  responses: Default<SatisfactionSampleInput[], typeof defaultResponses>;
}

const defaultResponses: SatisfactionSampleInput[] = [
  {
    id: "seed-1",
    date: "2024-05-01",
    score: 4.3,
    responses: 26,
    channel: "Email",
  },
  {
    id: "seed-2",
    date: "2024-05-02",
    score: 3.9,
    responses: 18,
    channel: "Chat",
  },
  {
    id: "seed-3",
    date: "2024-05-03",
    score: 4.6,
    responses: 22,
    channel: "In-App",
  },
];

const roundToTwo = (value: number): number => {
  return Math.round(value * 100) / 100;
};

const sanitizeDate = (value: unknown): string => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      const parsed = new Date(trimmed);
      if (!Number.isNaN(parsed.getTime())) {
        return parsed.toISOString().slice(0, 10);
      }
      if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
        return trimmed;
      }
    }
  }
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  return "1970-01-01";
};

const sanitizeScore = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 3;
  }
  const clamped = Math.min(5, Math.max(1, value));
  return roundToTwo(clamped);
};

const sanitizeResponses = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 1;
  }
  const rounded = Math.round(value);
  return Math.max(1, rounded);
};

const sanitizeChannel = (value: unknown): string => {
  if (typeof value !== "string") return "general";
  const trimmed = value.trim().toLowerCase();
  if (trimmed.length === 0) return "general";
  return trimmed.replace(/\s+/g, "-");
};

const sanitizeId = (
  value: unknown,
  fallback: string,
  date: string,
  channel: string,
): string => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length > 0) return trimmed;
  }
  const normalizedChannel = channel.length > 0 ? channel : "general";
  return `${date}-${normalizedChannel}-${fallback}`;
};

const sanitizeEntry = (
  seed: SatisfactionSampleInput | undefined,
  fallback: string,
): SatisfactionEntry => {
  const date = sanitizeDate(seed?.date);
  const channel = sanitizeChannel(seed?.channel);
  const score = sanitizeScore(seed?.score);
  const responses = sanitizeResponses(seed?.responses);
  const id = sanitizeId(seed?.id, fallback, date, channel);
  return {
    id,
    date,
    score,
    responses,
    channel,
  };
};

const sortEntries = (
  left: SatisfactionEntry,
  right: SatisfactionEntry,
): number => {
  if (left.date !== right.date) {
    return left.date.localeCompare(right.date);
  }
  return left.id.localeCompare(right.id);
};

const normalizeEntries = (
  entries: readonly SatisfactionEntry[],
): SatisfactionEntry[] => {
  const unique = new Map<string, SatisfactionEntry>();
  for (const entry of entries) {
    unique.set(entry.id, entry);
  }
  return Array.from(unique.values()).sort(sortEntries);
};

const sanitizeEntryList = (value: unknown): SatisfactionEntry[] => {
  if (!Array.isArray(value)) return [];
  const collected = value.map((raw, index) =>
    sanitizeEntry(
      raw as SatisfactionSampleInput | undefined,
      `seed-${index + 1}`,
    )
  );
  return normalizeEntries(collected);
};

const computeDailySummaries = (
  entries: readonly SatisfactionEntry[],
): DailySummaryInternal[] => {
  const totals = new Map<string, { weighted: number; responses: number }>();
  for (const entry of entries) {
    const bucket = totals.get(entry.date) ?? { weighted: 0, responses: 0 };
    bucket.weighted += entry.score * entry.responses;
    bucket.responses += entry.responses;
    totals.set(entry.date, bucket);
  }
  const summaries: DailySummaryInternal[] = [];
  for (const [date, bucket] of totals.entries()) {
    const average = bucket.responses === 0
      ? 0
      : bucket.weighted / bucket.responses;
    summaries.push({
      date,
      weightedSum: bucket.weighted,
      responseCount: bucket.responses,
      average: roundToTwo(average),
    });
  }
  summaries.sort((left, right) => left.date.localeCompare(right.date));
  return summaries;
};

const projectDailySummaries = (
  summaries: readonly DailySummaryInternal[],
): DailySummary[] => {
  return summaries.map((summary) => ({
    date: summary.date,
    average: summary.average,
    responseCount: summary.responseCount,
  }));
};

const computeWindowAverage = (
  summaries: readonly DailySummaryInternal[],
  index: number,
  windowSize: number,
): number => {
  let weighted = 0;
  let responses = 0;
  for (let offset = 0; offset < windowSize; offset += 1) {
    const position = index - offset;
    if (position < 0) break;
    const summary = summaries[position];
    weighted += summary.weightedSum;
    responses += summary.responseCount;
  }
  if (responses === 0) return 0;
  return roundToTwo(weighted / responses);
};

const computeMovingSeries = (
  summaries: readonly DailySummaryInternal[],
): MovingAveragePoint[] => {
  return summaries.map((summary, index) => ({
    date: summary.date,
    dailyAverage: summary.average,
    trailing3: computeWindowAverage(summaries, index, 3),
    trailing7: computeWindowAverage(summaries, index, 7),
  }));
};

const computeOverallAverage = (
  summaries: readonly DailySummaryInternal[],
): number => {
  let weighted = 0;
  let responses = 0;
  for (const summary of summaries) {
    weighted += summary.weightedSum;
    responses += summary.responseCount;
  }
  if (responses === 0) return 0;
  return roundToTwo(weighted / responses);
};

const computeChannelAverages = (
  entries: readonly SatisfactionEntry[],
): Record<string, number> => {
  const totals = new Map<string, { weighted: number; responses: number }>();
  for (const entry of entries) {
    const bucket = totals.get(entry.channel) ?? { weighted: 0, responses: 0 };
    bucket.weighted += entry.score * entry.responses;
    bucket.responses += entry.responses;
    totals.set(entry.channel, bucket);
  }
  const sortedChannels = Array.from(totals.entries())
    .sort((left, right) => left[0].localeCompare(right[0]));
  const record: Record<string, number> = {};
  for (const [channel, bucket] of sortedChannels) {
    record[channel] = bucket.responses === 0
      ? 0
      : roundToTwo(bucket.weighted / bucket.responses);
  }
  return record;
};

const determineTrend = (
  series: readonly MovingAveragePoint[],
): TrendDirection => {
  if (series.length < 2) return "steady";
  const latest = series[series.length - 1];
  const previous = series[series.length - 2];
  const delta = latest.trailing3 - previous.trailing3;
  if (delta > 0.05) return "rising";
  if (delta < -0.05) return "falling";
  return "steady";
};

const logSurveyResponse = handler(
  (
    event: SatisfactionSampleInput | undefined,
    context: {
      responses: Cell<SatisfactionSampleInput[]>;
      runtimeSeed: Cell<number>;
    },
  ) => {
    const existing = sanitizeEntryList(context.responses.get());
    const currentSeed = context.runtimeSeed.get() ?? 0;
    const candidate = sanitizeEntry(event, `runtime-${currentSeed + 1}`);
    const updated = normalizeEntries([...existing, candidate]);
    context.responses.set(updated);
    context.runtimeSeed.set(currentSeed + 1);
  },
);

export const customerSatisfactionTrackerUx = recipe<CustomerSatisfactionArgs>(
  "Customer Satisfaction Tracker (UX)",
  ({ responses }) => {
    const runtimeSeed = cell(0);

    const dateField = cell("");
    const scoreField = cell("");
    const responsesField = cell("");
    const channelField = cell("");

    const responseLog = lift((
      value: readonly SatisfactionSampleInput[] | undefined,
    ) => sanitizeEntryList(value))(responses);

    const dailySummaryInternal = lift((entries: readonly SatisfactionEntry[]) =>
      computeDailySummaries(entries)
    )(responseLog);

    const dailySummaries = lift((summaries: readonly DailySummaryInternal[]) =>
      projectDailySummaries(summaries)
    )(dailySummaryInternal);

    const movingAverages = lift((summaries: readonly DailySummaryInternal[]) =>
      computeMovingSeries(summaries)
    )(dailySummaryInternal);

    const overallAverage = lift((summaries: readonly DailySummaryInternal[]) =>
      computeOverallAverage(summaries)
    )(dailySummaryInternal);

    const overallAverageLabel = lift((value: number) => value.toFixed(2))(
      overallAverage,
    );

    const responseCount = lift((entries: readonly SatisfactionEntry[]) =>
      entries.reduce((sum, entry) => sum + entry.responses, 0)
    )(responseLog);

    const dayCount = lift((summaries: readonly DailySummaryInternal[]) =>
      summaries.length
    )(dailySummaryInternal);

    const trendDirection = lift((series: readonly MovingAveragePoint[]) =>
      determineTrend(series)
    )(movingAverages);

    const channelAverages = lift((entries: readonly SatisfactionEntry[]) =>
      computeChannelAverages(entries)
    )(responseLog);

    const summary =
      str`${responseCount} responses across ${dayCount} days avg ${overallAverageLabel} trend ${trendDirection}`;

    const trendIcon = lift((trend: TrendDirection) => {
      if (trend === "rising") return "↗";
      if (trend === "falling") return "↘";
      return "→";
    })(trendDirection);

    const logSurveyResponseUi = handler(
      (_event: unknown, context: {
        responses: Cell<SatisfactionSampleInput[]>;
        runtimeSeed: Cell<number>;
        dateField: Cell<string>;
        scoreField: Cell<string>;
        responsesField: Cell<string>;
        channelField: Cell<string>;
      }) => {
        const dateStr = context.dateField.get();
        const scoreStr = context.scoreField.get();
        const responsesStr = context.responsesField.get();
        const channelStr = context.channelField.get();

        if (
          typeof dateStr !== "string" || dateStr.trim() === "" ||
          typeof scoreStr !== "string" || scoreStr.trim() === "" ||
          typeof responsesStr !== "string" || responsesStr.trim() === ""
        ) {
          return;
        }

        const existing = sanitizeEntryList(context.responses.get());
        const currentSeed = context.runtimeSeed.get() ?? 0;

        const event: SatisfactionSampleInput = {
          date: dateStr,
          score: Number(scoreStr),
          responses: Number(responsesStr),
          channel: channelStr.trim() !== "" ? channelStr : undefined,
        };

        const candidate = sanitizeEntry(event, `runtime-${currentSeed + 1}`);
        const updated = normalizeEntries([...existing, candidate]);
        context.responses.set(updated);
        context.runtimeSeed.set(currentSeed + 1);

        context.dateField.set("");
        context.scoreField.set("");
        context.responsesField.set("");
        context.channelField.set("");
      },
    )({
      responses,
      runtimeSeed,
      dateField,
      scoreField,
      responsesField,
      channelField,
    });

    const name = str`Customer Satisfaction (${overallAverageLabel}/5.0)`;

    const channelCards = lift((channels: Record<string, number>) => {
      const entries = Object.entries(channels);
      const elements: any[] = [];
      for (const [channel, avg] of entries) {
        const channelColor = avg >= 4.5
          ? "#10b981"
          : avg >= 3.5
          ? "#f59e0b"
          : "#ef4444";
        const channelBg = avg >= 4.5
          ? "#d1fae5"
          : avg >= 3.5
          ? "#fef3c7"
          : "#fee2e2";

        elements.push(
          h(
            "div",
            {
              style:
                "padding: 0.875rem; border-radius: 0.5rem; border-left: 4px solid " +
                channelColor + "; background: " + channelBg + ";",
            },
            h(
              "div",
              {
                style:
                  "font-size: 0.75rem; font-weight: 600; margin-bottom: 0.25rem; text-transform: capitalize; color: #64748b;",
              },
              channel,
            ),
            h(
              "div",
              {
                style: "font-size: 1.5rem; font-weight: bold; color: " +
                  channelColor + ";",
              },
              String(avg.toFixed(2)) + " ⭐",
            ),
          ),
        );
      }
      return h("div", {
        style:
          "display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 0.75rem;",
      }, ...elements);
    })(channelAverages);

    const recentData = lift((summaries: readonly DailySummary[]) => {
      if (summaries.length === 0) {
        return h(
          "div",
          {
            style:
              "background: #f1f5f9; border-radius: 0.5rem; padding: 1rem; text-align: center; color: #64748b; font-size: 0.875rem;",
          },
          "No daily summaries yet",
        );
      }
      const recent = summaries.slice(-7);
      const dayCards = [];
      for (const day of recent) {
        const scoreColor = day.average >= 4.5
          ? "#10b981"
          : day.average >= 3.5
          ? "#f59e0b"
          : "#ef4444";
        const card = h(
          "div",
          {
            style:
              "background: #f8fafc; border-radius: 0.5rem; padding: 0.875rem; display: flex; justify-content: space-between; align-items: center;",
          },
          h(
            "div",
            {
              style: "display: flex; flex-direction: column; gap: 0.25rem;",
            },
            h(
              "span",
              {
                style: "font-size: 0.875rem; color: #334155; font-weight: 500;",
              },
              day.date,
            ),
            h(
              "span",
              { style: "font-size: 0.75rem; color: #64748b;" },
              String(day.responseCount) + " responses",
            ),
          ),
          h(
            "strong",
            {
              style: "font-size: 1.5rem; color: " + scoreColor +
                "; font-weight: 700;",
            },
            String(day.average.toFixed(2)) + " ⭐",
          ),
        );
        dayCards.push(card);
      }
      return h("div", {
        style: "display: flex; flex-direction: column; gap: 0.625rem;",
      }, ...dayCards);
    })(dailySummaries);

    return {
      [NAME]: name,
      [UI]: (
        <div style="
            display: flex;
            flex-direction: column;
            gap: 1.5rem;
            max-width: 56rem;
          ">
          <ct-card>
            <div
              slot="content"
              style="
                display: flex;
                flex-direction: column;
                gap: 1.5rem;
              "
            >
              <div style="
                  display: flex;
                  flex-direction: column;
                  gap: 0.375rem;
                ">
                <span style="
                    color: #64748b;
                    font-size: 0.75rem;
                    letter-spacing: 0.1em;
                    text-transform: uppercase;
                    font-weight: 600;
                  ">
                  Customer Satisfaction Dashboard
                </span>
                <h2 style="
                    margin: 0;
                    font-size: 1.5rem;
                    color: #0f172a;
                    font-weight: 700;
                  ">
                  Track satisfaction scores across channels
                </h2>
              </div>

              <div style="
                  background: linear-gradient(135deg, #0ea5e9 0%, #3b82f6 100%);
                  border-radius: 0.75rem;
                  padding: 1.75rem;
                  display: flex;
                  flex-direction: column;
                  gap: 1rem;
                  color: white;
                ">
                <div style="
                    display: flex;
                    justify-content: space-between;
                    align-items: flex-start;
                  ">
                  <div style="
                      display: flex;
                      flex-direction: column;
                      gap: 0.5rem;
                    ">
                    <span style="
                        font-size: 0.875rem;
                        opacity: 0.9;
                        text-transform: uppercase;
                        letter-spacing: 0.05em;
                      ">
                      Overall average
                    </span>
                    <strong style="
                        font-size: 3.5rem;
                        font-weight: 800;
                        letter-spacing: -0.02em;
                        line-height: 1;
                      ">
                      {overallAverageLabel}
                      <span style="font-size: 1.75rem; opacity: 0.7; font-weight: 600;">
                        /5.0
                      </span>
                    </strong>
                  </div>
                  <div style="background: rgba(255, 255, 255, 0.2); border-radius: 0.625rem; padding: 1rem 1.25rem; display: flex; flex-direction: column; align-items: center; gap: 0.375rem;">
                    <span style="font-size: 0.75rem; opacity: 0.9; text-transform: uppercase; letter-spacing: 0.05em;">
                      Trend
                    </span>
                    <div style="display: flex; align-items: center; gap: 0.625rem;">
                      <span style="font-size: 2rem;">
                        {trendIcon}
                      </span>
                      <span style="
                          font-size: 1.125rem;
                          font-weight: 700;
                          text-transform: uppercase;
                          letter-spacing: 0.05em;
                        ">
                        {trendDirection}
                      </span>
                    </div>
                  </div>
                </div>

                <div style="
                    display: grid;
                    grid-template-columns: repeat(2, 1fr);
                    gap: 1.25rem;
                  ">
                  <div style="
                      display: flex;
                      flex-direction: column;
                      gap: 0.375rem;
                    ">
                    <span style="
                        font-size: 0.875rem;
                        opacity: 0.85;
                      ">
                      Total responses
                    </span>
                    <strong style="
                        font-size: 2rem;
                        font-weight: 700;
                      ">
                      {responseCount}
                    </strong>
                  </div>
                  <div style="
                      display: flex;
                      flex-direction: column;
                      gap: 0.375rem;
                    ">
                    <span style="
                        font-size: 0.875rem;
                        opacity: 0.85;
                      ">
                      Days tracked
                    </span>
                    <strong style="
                        font-size: 2rem;
                        font-weight: 700;
                      ">
                      {dayCount}
                    </strong>
                  </div>
                </div>
              </div>

              <div style="
                  display: flex;
                  flex-direction: column;
                  gap: 0.875rem;
                ">
                <h3 style="
                    margin: 0;
                    font-size: 1.125rem;
                    color: #0f172a;
                    font-weight: 700;
                  ">
                  📊 By Channel
                </h3>
                {channelCards}
              </div>

              <div style="
                  display: flex;
                  flex-direction: column;
                  gap: 0.875rem;
                ">
                <h3 style="
                    margin: 0;
                    font-size: 1.125rem;
                    color: #0f172a;
                    font-weight: 700;
                  ">
                  📅 Recent Daily Averages (Last 7 Days)
                </h3>
                {recentData}
              </div>
            </div>
          </ct-card>

          <ct-card>
            <div
              slot="content"
              style="
                display: flex;
                flex-direction: column;
                gap: 1rem;
              "
            >
              <h3 style="
                  margin: 0;
                  font-size: 1.125rem;
                  color: #0f172a;
                  font-weight: 700;
                ">
                ➕ Log New Survey Response
              </h3>

              <div style="
                  display: grid;
                  grid-template-columns: repeat(2, 1fr);
                  gap: 0.875rem;
                ">
                <div style="
                    display: flex;
                    flex-direction: column;
                    gap: 0.5rem;
                  ">
                  <label style="
                      font-size: 0.875rem;
                      font-weight: 600;
                      color: #475569;
                    ">
                    Date (YYYY-MM-DD)
                  </label>
                  <ct-input
                    type="text"
                    placeholder="2024-05-04"
                    $value={dateField}
                  >
                  </ct-input>
                </div>

                <div style="
                    display: flex;
                    flex-direction: column;
                    gap: 0.5rem;
                  ">
                  <label style="
                      font-size: 0.875rem;
                      font-weight: 600;
                      color: #475569;
                    ">
                    Channel
                  </label>
                  <ct-input
                    type="text"
                    placeholder="Email, Chat, In-App"
                    $value={channelField}
                  >
                  </ct-input>
                </div>

                <div style="
                    display: flex;
                    flex-direction: column;
                    gap: 0.5rem;
                  ">
                  <label style="
                      font-size: 0.875rem;
                      font-weight: 600;
                      color: #475569;
                    ">
                    Score (1-5)
                  </label>
                  <ct-input
                    type="number"
                    placeholder="4.5"
                    $value={scoreField}
                  >
                  </ct-input>
                </div>

                <div style="
                    display: flex;
                    flex-direction: column;
                    gap: 0.5rem;
                  ">
                  <label style="
                      font-size: 0.875rem;
                      font-weight: 600;
                      color: #475569;
                    ">
                    # Responses
                  </label>
                  <ct-input
                    type="number"
                    placeholder="20"
                    $value={responsesField}
                  >
                  </ct-input>
                </div>
              </div>

              <ct-button onClick={logSurveyResponseUi}>
                Log response
              </ct-button>
            </div>
          </ct-card>
        </div>
      ),
      responseLog,
      dailySummaries,
      movingAverages,
      overallAverage,
      overallAverageLabel,
      responseCount,
      dayCount,
      trendDirection,
      channelAverages,
      summary,
      recordResponse: logSurveyResponse({ responses, runtimeSeed }),
    };
  },
);

export default customerSatisfactionTrackerUx;

export type {
  DailySummary,
  MovingAveragePoint,
  SatisfactionEntry,
  TrendDirection,
};
