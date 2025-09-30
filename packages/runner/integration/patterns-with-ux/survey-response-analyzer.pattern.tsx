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

interface SurveyResponseArgs {
  responses: Default<SurveyResponseInput[], []>;
  questions: Default<string[], []>;
}

interface SurveyResponseInput {
  respondent?: string;
  demographic?: string;
  answers?: Record<string, unknown>;
}

interface SurveyResponse {
  respondent: string;
  demographic: string;
  answers: Record<string, number>;
}

interface QuestionSummary {
  question: string;
  total: number;
  answered: number;
  average: number;
}

interface DemographicSummary {
  demographic: string;
  responseCount: number;
  questionAverages: Record<string, number>;
  overallAverage: number;
}

interface RecordResponseEvent {
  respondent?: string;
  demographic?: string;
  answers?: Record<string, unknown>;
}

const defaultDemographic = "general";

const roundAverage = (value: number): number => {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 100) / 100;
};

const normalizeName = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const ensureUnique = (candidate: string, used: Set<string>): string => {
  if (!used.has(candidate)) {
    used.add(candidate);
    return candidate;
  }
  let index = 2;
  let next = `${candidate}-${index}`;
  while (used.has(next)) {
    index += 1;
    next = `${candidate}-${index}`;
  }
  used.add(next);
  return next;
};

const sanitizeScore = (value: unknown): number => {
  if (typeof value !== "number" || Number.isNaN(value)) return 0;
  const clamped = Math.min(5, Math.max(0, value));
  return roundAverage(clamped);
};

const sanitizeAnswerMap = (
  value: Record<string, unknown> | undefined,
): Record<string, number> => {
  if (!value || typeof value !== "object") return {};
  const entries: [string, number][] = [];
  for (const [key, raw] of Object.entries(value)) {
    const question = normalizeName(key);
    if (!question) continue;
    const score = sanitizeScore(raw);
    entries.push([question, score]);
  }
  entries.sort((left, right) => left[0].localeCompare(right[0]));
  const record: Record<string, number> = {};
  for (const [question, score] of entries) {
    record[question] = score;
  }
  return record;
};

const sanitizeResponseEntry = (
  value: SurveyResponseInput | undefined,
  fallbackIndex: number,
  used: Set<string>,
): SurveyResponse => {
  const fallbackRespondent = `respondent-${Math.max(1, fallbackIndex)}`;
  const respondentName = normalizeName(value?.respondent) ?? fallbackRespondent;
  const uniqueRespondent = ensureUnique(respondentName, used);
  const demographic = normalizeName(value?.demographic) ?? defaultDemographic;
  const answers = sanitizeAnswerMap(
    value?.answers as Record<string, unknown> | undefined,
  );
  return {
    respondent: uniqueRespondent,
    demographic,
    answers,
  };
};

const sanitizeResponses = (value: unknown): SurveyResponse[] => {
  if (!Array.isArray(value)) return [];
  const used = new Set<string>();
  const sanitized: SurveyResponse[] = [];
  for (let index = 0; index < value.length; index++) {
    const input = value[index] as SurveyResponseInput | undefined;
    sanitized.push(sanitizeResponseEntry(input, index + 1, used));
  }
  sanitized.sort((left, right) =>
    left.respondent.localeCompare(right.respondent)
  );
  return sanitized;
};

const sanitizeQuestionList = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  const set = new Set<string>();
  for (const entry of value) {
    const name = normalizeName(entry);
    if (!name) continue;
    set.add(name);
  }
  const list = Array.from(set);
  list.sort((left, right) => left.localeCompare(right));
  return list;
};

const cloneResponse = (response: SurveyResponse): SurveyResponse => ({
  respondent: response.respondent,
  demographic: response.demographic,
  answers: { ...response.answers },
});

const buildQuestionCatalog = (input: {
  provided: readonly string[] | undefined;
  responses: readonly SurveyResponse[] | undefined;
}): string[] => {
  const set = new Set<string>();
  if (Array.isArray(input.provided)) {
    for (const question of input.provided) {
      if (question.length > 0) set.add(question);
    }
  }
  if (Array.isArray(input.responses)) {
    for (const response of input.responses) {
      for (const question of Object.keys(response.answers)) {
        if (question.length > 0) set.add(question);
      }
    }
  }
  const list = Array.from(set);
  list.sort((left, right) => left.localeCompare(right));
  return list;
};

const buildDemographicCatalog = (
  responses: readonly SurveyResponse[],
): string[] => {
  const set = new Set<string>();
  for (const response of responses) {
    if (response.demographic.length > 0) {
      set.add(response.demographic);
    }
  }
  if (set.size === 0) set.add(defaultDemographic);
  const list = Array.from(set);
  list.sort((left, right) => left.localeCompare(right));
  return list;
};

const computeQuestionSummaries = (input: {
  questions: readonly string[];
  responses: readonly SurveyResponse[];
}): QuestionSummary[] => {
  const questions = Array.isArray(input.questions) ? input.questions : [];
  const responses = Array.isArray(input.responses) ? input.responses : [];
  const summaries: QuestionSummary[] = [];
  for (const question of questions) {
    let total = 0;
    let answered = 0;
    for (const response of responses) {
      const value = response.answers[question];
      if (typeof value === "number") {
        total += value;
        answered += 1;
      }
    }
    const average = answered > 0 ? roundAverage(total / answered) : 0;
    summaries.push({ question, total, answered, average });
  }
  summaries.sort((left, right) => left.question.localeCompare(right.question));
  return summaries;
};

const cloneQuestionSummary = (summary: QuestionSummary): QuestionSummary => ({
  question: summary.question,
  total: summary.total,
  answered: summary.answered,
  average: summary.average,
});

const computeDemographicSummaries = (input: {
  demographics: readonly string[];
  questions: readonly string[];
  responses: readonly SurveyResponse[];
}): DemographicSummary[] => {
  const demographics = Array.isArray(input.demographics)
    ? input.demographics
    : [];
  const questions = Array.isArray(input.questions) ? input.questions : [];
  const responses = Array.isArray(input.responses) ? input.responses : [];
  const summaries: DemographicSummary[] = [];
  for (const demographic of demographics) {
    const matching = responses.filter((entry) =>
      entry.demographic === demographic
    );
    const questionTotals: Record<string, { total: number; answered: number }> =
      {};
    for (const question of questions) {
      questionTotals[question] = { total: 0, answered: 0 };
    }
    for (const response of matching) {
      for (const question of questions) {
        const value = response.answers[question];
        if (typeof value === "number") {
          const bucket = questionTotals[question];
          bucket.total += value;
          bucket.answered += 1;
        }
      }
    }
    const questionAverages: Record<string, number> = {};
    let overallTotal = 0;
    let overallAnswered = 0;
    for (const question of questions) {
      const bucket = questionTotals[question];
      if (bucket.answered > 0) {
        const average = roundAverage(bucket.total / bucket.answered);
        questionAverages[question] = average;
        overallTotal += bucket.total;
        overallAnswered += bucket.answered;
      } else {
        questionAverages[question] = 0;
      }
    }
    const overallAverage = overallAnswered > 0
      ? roundAverage(overallTotal / overallAnswered)
      : 0;
    summaries.push({
      demographic,
      responseCount: matching.length,
      questionAverages,
      overallAverage,
    });
  }
  summaries.sort((left, right) =>
    left.demographic.localeCompare(right.demographic)
  );
  return summaries;
};

const cloneDemographicSummary = (
  summary: DemographicSummary,
): DemographicSummary => ({
  demographic: summary.demographic,
  responseCount: summary.responseCount,
  questionAverages: { ...summary.questionAverages },
  overallAverage: summary.overallAverage,
});

const buildQuestionAverageMap = (
  summaries: readonly QuestionSummary[],
): Record<string, number> => {
  const record: Record<string, number> = {};
  for (const summary of summaries) {
    record[summary.question] = summary.average;
  }
  return record;
};

const buildDemographicAverageMap = (
  summaries: readonly DemographicSummary[],
): Record<string, Record<string, number>> => {
  const record: Record<string, Record<string, number>> = {};
  for (const summary of summaries) {
    record[summary.demographic] = { ...summary.questionAverages };
  }
  return record;
};

const appendSurveyResponse = handler(
  (
    event: RecordResponseEvent | undefined,
    context: {
      store: Cell<SurveyResponse[]>;
      base: Cell<SurveyResponse[]>;
      sequence: Cell<number>;
    },
  ) => {
    if (!event) return;
    const storeValue = context.store.get();
    const baseValue = context.base.get();
    const baseline = Array.isArray(storeValue) && storeValue.length > 0
      ? storeValue
      : Array.isArray(baseValue)
      ? baseValue
      : [];
    const used = new Set<string>();
    for (const entry of baseline) {
      used.add(entry.respondent);
    }
    const nextIndex = (context.sequence.get() ?? baseline.length) + 1;
    const sanitized = sanitizeResponseEntry(event, nextIndex, used);
    const next = baseline.map(cloneResponse);
    next.push(sanitized);
    next.sort((left, right) => left.respondent.localeCompare(right.respondent));
    context.store.set(next.map(cloneResponse));
    context.sequence.set(nextIndex);
  },
);

export const surveyResponseAnalyzerUx = recipe<SurveyResponseArgs>(
  "Survey Response Analyzer",
  ({ responses, questions }) => {
    const sanitizedArgumentResponses = lift(sanitizeResponses)(responses);
    const sanitizedQuestionList = lift(sanitizeQuestionList)(questions);

    const responseStore = cell<SurveyResponse[]>([]);
    const responseSequence = cell(0);

    const normalizedResponses = lift((input: {
      store: SurveyResponse[];
      base: SurveyResponse[];
    }) => {
      const storeEntries = Array.isArray(input.store) ? input.store : [];
      if (storeEntries.length > 0) {
        return storeEntries.map(cloneResponse);
      }
      const baseEntries = Array.isArray(input.base) ? input.base : [];
      return baseEntries.map(cloneResponse);
    })({
      store: responseStore,
      base: sanitizedArgumentResponses,
    });

    const questionCatalog = lift((input: {
      provided: readonly string[];
      responses: readonly SurveyResponse[];
    }) => buildQuestionCatalog(input))({
      provided: sanitizedQuestionList,
      responses: normalizedResponses,
    });

    const questionSummaries = lift((input: {
      questions: readonly string[];
      responses: readonly SurveyResponse[];
    }) => computeQuestionSummaries(input))({
      questions: questionCatalog,
      responses: normalizedResponses,
    });

    const questionSummariesView = lift((summaries: QuestionSummary[]) =>
      summaries.map(cloneQuestionSummary)
    )(questionSummaries);

    const questionAverageMap = lift(buildQuestionAverageMap)(
      questionSummaries,
    );
    const questionAverageMapView = lift((record: Record<string, number>) => ({
      ...record,
    }))(questionAverageMap);

    const demographicCatalog = lift(buildDemographicCatalog)(
      normalizedResponses,
    );

    const demographicSummaries = lift((input: {
      demographics: readonly string[];
      questions: readonly string[];
      responses: readonly SurveyResponse[];
    }) => computeDemographicSummaries(input))({
      demographics: demographicCatalog,
      questions: questionCatalog,
      responses: normalizedResponses,
    });

    const demographicSummariesView = lift((summaries: DemographicSummary[]) =>
      summaries.map(cloneDemographicSummary)
    )(demographicSummaries);

    const demographicAverageMap = lift(buildDemographicAverageMap)(
      demographicSummaries,
    );
    const demographicAverageMapView = lift((
      record: Record<
        string,
        Record<
          string,
          number
        >
      >,
    ) => {
      const copy: Record<string, Record<string, number>> = {};
      for (const key of Object.keys(record)) {
        copy[key] = { ...record[key] };
      }
      return copy;
    })(demographicAverageMap);

    const overallAverage = lift((summaries: QuestionSummary[]) => {
      let total = 0;
      let answered = 0;
      for (const summary of summaries) {
        total += summary.total;
        answered += summary.answered;
      }
      return answered > 0 ? roundAverage(total / answered) : 0;
    })(questionSummaries);

    const overallAverageLabel = lift((value: number | undefined) => {
      if (typeof value !== "number" || Number.isNaN(value)) {
        return "0.00";
      }
      return value.toFixed(2);
    })(overallAverage);

    const responseCount = lift((entries: readonly SurveyResponse[]) =>
      entries.length
    )(normalizedResponses);
    const questionCount = lift((entries: readonly string[]) => entries.length)(
      questionCatalog,
    );
    const demographicCount = lift((entries: readonly string[]) =>
      entries.length
    )(demographicCatalog);

    const summaryHead =
      str`${responseCount} responses · ${questionCount} questions`;
    const summary =
      str`${summaryHead} · ${demographicCount} demographics · avg ${overallAverageLabel}`;

    const responsesView = lift((entries: SurveyResponse[]) =>
      entries.map(cloneResponse)
    )(normalizedResponses);

    const recordResponse = appendSurveyResponse({
      store: responseStore,
      base: sanitizedArgumentResponses,
      sequence: responseSequence,
    });

    // UI-specific cells
    const respondentField = cell("");
    const demographicField = cell("");
    const answersJsonField = cell("");

    // UI handler to add a response
    const addResponseHandler = handler(
      (
        _event: unknown,
        context: {
          respondentField: Cell<string>;
          demographicField: Cell<string>;
          answersJsonField: Cell<string>;
          store: Cell<SurveyResponse[]>;
          base: Cell<SurveyResponse[]>;
          sequence: Cell<number>;
        },
      ) => {
        const respondentText = context.respondentField.get();
        const demographicText = context.demographicField.get();
        const answersText = context.answersJsonField.get();

        if (
          typeof respondentText !== "string" ||
          respondentText.trim() === ""
        ) {
          return;
        }

        let answersObj: Record<string, unknown> = {};
        if (
          typeof answersText === "string" && answersText.trim() !== ""
        ) {
          try {
            answersObj = JSON.parse(answersText);
          } catch {
            return;
          }
        }

        const storeValue = context.store.get();
        const baseValue = context.base.get();
        const baseline = Array.isArray(storeValue) && storeValue.length > 0
          ? storeValue
          : Array.isArray(baseValue)
          ? baseValue
          : [];
        const used = new Set<string>();
        for (const entry of baseline) {
          used.add(entry.respondent);
        }
        const nextIndex = (context.sequence.get() ?? baseline.length) + 1;
        const sanitized = sanitizeResponseEntry(
          {
            respondent: respondentText,
            demographic: demographicText || undefined,
            answers: answersObj,
          },
          nextIndex,
          used,
        );
        const next = baseline.map(cloneResponse);
        next.push(sanitized);
        next.sort((left, right) =>
          left.respondent.localeCompare(right.respondent)
        );
        context.store.set(next.map(cloneResponse));
        context.sequence.set(nextIndex);

        context.respondentField.set("");
        context.demographicField.set("");
        context.answersJsonField.set("");
      },
    )({
      respondentField,
      demographicField,
      answersJsonField,
      store: responseStore,
      base: sanitizedArgumentResponses,
      sequence: responseSequence,
    });

    const name = str`Survey Analysis - ${responseCount} responses`;

    const questionSummaryUI = lift((summaries: QuestionSummary[]) => {
      if (!Array.isArray(summaries) || summaries.length === 0) {
        return h(
          "div",
          {
            style:
              "padding: 1.5rem; text-align: center; color: #64748b; border: 2px dashed #cbd5e1; border-radius: 8px; margin: 1rem 0;",
          },
          "No questions available",
        );
      }

      const cards = [];
      for (const summary of summaries) {
        const avgColor = summary.average >= 4
          ? "#10b981"
          : summary.average >= 3
          ? "#f59e0b"
          : "#ef4444";
        const cardStyle =
          "background: white; border: 1px solid #e2e8f0; border-left: 4px solid " +
          avgColor +
          "; border-radius: 8px; padding: 1rem; margin: 0.5rem 0;";

        cards.push(
          h(
            "div",
            { style: cardStyle },
            h(
              "div",
              {
                style:
                  "font-weight: 600; color: #1e293b; margin-bottom: 0.5rem;",
              },
              summary.question,
            ),
            h(
              "div",
              {
                style:
                  "display: grid; grid-template-columns: repeat(3, 1fr); gap: 0.5rem;",
              },
              h(
                "div",
                { style: "text-align: center;" },
                h(
                  "div",
                  {
                    style: "font-size: 1.5rem; font-weight: 700; color: " +
                      avgColor +
                      ";",
                  },
                  String(summary.average.toFixed(2)),
                ),
                h(
                  "div",
                  { style: "font-size: 0.75rem; color: #64748b;" },
                  "Average",
                ),
              ),
              h(
                "div",
                { style: "text-align: center;" },
                h(
                  "div",
                  {
                    style:
                      "font-size: 1.5rem; font-weight: 700; color: #475569;",
                  },
                  String(summary.answered),
                ),
                h(
                  "div",
                  { style: "font-size: 0.75rem; color: #64748b;" },
                  "Responses",
                ),
              ),
              h(
                "div",
                { style: "text-align: center;" },
                h(
                  "div",
                  {
                    style:
                      "font-size: 1.5rem; font-weight: 700; color: #475569;",
                  },
                  String(summary.total.toFixed(0)),
                ),
                h(
                  "div",
                  { style: "font-size: 0.75rem; color: #64748b;" },
                  "Total",
                ),
              ),
            ),
          ),
        );
      }

      return h("div", {}, ...cards);
    })(questionSummariesView);

    const demographicSummaryUI = lift((summaries: DemographicSummary[]) => {
      if (!Array.isArray(summaries) || summaries.length === 0) {
        return h(
          "div",
          {
            style:
              "padding: 1.5rem; text-align: center; color: #64748b; border: 2px dashed #cbd5e1; border-radius: 8px; margin: 1rem 0;",
          },
          "No demographics available",
        );
      }

      const cards = [];
      const colors = ["#3b82f6", "#8b5cf6", "#ec4899", "#10b981", "#f59e0b"];
      let colorIndex = 0;

      for (const summary of summaries) {
        const color = colors[colorIndex % colors.length];
        colorIndex += 1;

        const cardStyle =
          "background: white; border: 1px solid #e2e8f0; border-left: 4px solid " +
          color +
          "; border-radius: 8px; padding: 1rem; margin: 0.5rem 0;";

        const headerStyle =
          "display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.75rem;";

        const badgeStyle = "background: " +
          color +
          "; color: white; padding: 0.25rem 0.75rem; border-radius: 12px; font-size: 0.875rem; font-weight: 600;";

        cards.push(
          h(
            "div",
            { style: cardStyle },
            h(
              "div",
              { style: headerStyle },
              h(
                "span",
                { style: "font-weight: 600; color: #1e293b;" },
                summary.demographic,
              ),
              h(
                "span",
                { style: badgeStyle },
                String(summary.responseCount) + " responses",
              ),
            ),
            h(
              "div",
              {
                style: "background: linear-gradient(135deg, " +
                  color +
                  "15, " +
                  color +
                  "05); padding: 0.75rem; border-radius: 6px; text-align: center;",
              },
              h(
                "div",
                {
                  style: "font-size: 2rem; font-weight: 700; color: " + color +
                    ";",
                },
                String(summary.overallAverage.toFixed(2)),
              ),
              h(
                "div",
                {
                  style:
                    "font-size: 0.875rem; color: #64748b; margin-top: 0.25rem;",
                },
                "Overall Average",
              ),
            ),
          ),
        );
      }

      return h("div", {}, ...cards);
    })(demographicSummariesView);

    const ui = h(
      "div",
      {
        style:
          "font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 1200px; margin: 0 auto; padding: 1rem; background: #f8fafc;",
      },
      h(
        "div",
        {
          style:
            "background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 2rem; border-radius: 12px; margin-bottom: 1.5rem;",
        },
        h(
          "h1",
          { style: "margin: 0 0 0.5rem 0; font-size: 2rem; font-weight: 700;" },
          "📊 Survey Response Analyzer",
        ),
        h(
          "div",
          { style: "font-size: 1.125rem; opacity: 0.95;" },
          summary,
        ),
      ),
      h(
        "div",
        {
          style:
            "background: white; border-radius: 12px; padding: 1.5rem; margin-bottom: 1.5rem; box-shadow: 0 1px 3px rgba(0,0,0,0.1);",
        },
        h(
          "h2",
          {
            style:
              "margin: 0 0 1rem 0; font-size: 1.25rem; font-weight: 600; color: #1e293b;",
          },
          "Add New Response",
        ),
        h(
          "div",
          { style: "display: grid; gap: 0.75rem;" },
          h(
            "div",
            {},
            h(
              "label",
              {
                style:
                  "display: block; font-size: 0.875rem; font-weight: 500; color: #475569; margin-bottom: 0.25rem;",
              },
              "Respondent Name *",
            ),
            h("ct-input", {
              $value: respondentField,
              placeholder: "Enter respondent name",
              style: "width: 100%;",
            }),
          ),
          h(
            "div",
            {},
            h(
              "label",
              {
                style:
                  "display: block; font-size: 0.875rem; font-weight: 500; color: #475569; margin-bottom: 0.25rem;",
              },
              "Demographic (optional)",
            ),
            h("ct-input", {
              $value: demographicField,
              placeholder: "e.g., 18-25, Urban, etc.",
              style: "width: 100%;",
            }),
          ),
          h(
            "div",
            {},
            h(
              "label",
              {
                style:
                  "display: block; font-size: 0.875rem; font-weight: 500; color: #475569; margin-bottom: 0.25rem;",
              },
              "Answers (JSON format, scores 0-5)",
            ),
            h("ct-input", {
              $value: answersJsonField,
              placeholder: '{"Question 1": 4, "Question 2": 5}',
              style: "width: 100%;",
            }),
          ),
          h(
            "ct-button",
            { onClick: addResponseHandler, variant: "primary" },
            "Add Response",
          ),
        ),
      ),
      h(
        "div",
        {
          style:
            "background: white; border-radius: 12px; padding: 1.5rem; margin-bottom: 1.5rem; box-shadow: 0 1px 3px rgba(0,0,0,0.1);",
        },
        h(
          "h2",
          {
            style:
              "margin: 0 0 1rem 0; font-size: 1.25rem; font-weight: 600; color: #1e293b;",
          },
          "Question Insights",
        ),
        questionSummaryUI,
      ),
      h(
        "div",
        {
          style:
            "background: white; border-radius: 12px; padding: 1.5rem; box-shadow: 0 1px 3px rgba(0,0,0,0.1);",
        },
        h(
          "h2",
          {
            style:
              "margin: 0 0 1rem 0; font-size: 1.25rem; font-weight: 600; color: #1e293b;",
          },
          "Demographic Breakdown",
        ),
        demographicSummaryUI,
      ),
    );

    return {
      [NAME]: name,
      [UI]: ui,
      responses: responsesView,
      questionCatalog,
      demographicCatalog,
      questionSummaries: questionSummariesView,
      questionAverages: questionAverageMapView,
      demographicSummaries: demographicSummariesView,
      demographicAverages: demographicAverageMapView,
      overallAverage,
      overallAverageLabel,
      summary,
      responseCount,
      questionCount,
      demographicCount,
      recordResponse,
    };
  },
);
