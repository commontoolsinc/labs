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
  UI,
} from "commontools";

interface SearchResult {
  id: string;
  title: string;
  textScore: number;
  clickRate: number;
  freshness: number;
}

interface SearchWeights {
  text: number;
  clicks: number;
  freshness: number;
}

interface ScoreContributions {
  text: number;
  clicks: number;
  freshness: number;
}

const DEFAULT_WEIGHTS: SearchWeights = {
  text: 0.6,
  clicks: 0.3,
  freshness: 0.1,
};

type WeightDefaults = {
  text: 0.6;
  clicks: 0.3;
  freshness: 0.1;
};

interface SearchRelevanceArgs {
  results: Default<SearchResult[], []>;
  weights: Default<SearchWeights, WeightDefaults>;
}

interface WeightAdjustEvent {
  text?: number;
  clicks?: number;
  freshness?: number;
  textDelta?: number;
  clicksDelta?: number;
  freshnessDelta?: number;
  reset?: boolean;
}

interface ResultMetricEvent {
  id?: string;
  textScore?: number;
  clickRate?: number;
  freshness?: number;
  textDelta?: number;
  clickDelta?: number;
  freshnessDelta?: number;
}

interface ScoredResult {
  id: string;
  title: string;
  score: number;
  contributions: ScoreContributions;
}

const roundValue = (value: number, digits = 3): number => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

const sanitizeWeightValue = (
  value: unknown,
  fallback: number,
): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  if (value <= 0) return 0;
  return roundValue(value);
};

const sanitizeWeights = (input: SearchWeights | undefined): SearchWeights => {
  const source = input ?? DEFAULT_WEIGHTS;
  const text = sanitizeWeightValue(source.text, DEFAULT_WEIGHTS.text);
  const clicks = sanitizeWeightValue(source.clicks, DEFAULT_WEIGHTS.clicks);
  const freshness = sanitizeWeightValue(
    source.freshness,
    DEFAULT_WEIGHTS.freshness,
  );
  const total = text + clicks + freshness;
  if (!Number.isFinite(total) || total <= 0) {
    return { ...DEFAULT_WEIGHTS };
  }
  return { text, clicks, freshness };
};

const normalizeWeights = (weights: SearchWeights): SearchWeights => {
  const total = weights.text + weights.clicks + weights.freshness;
  if (!Number.isFinite(total) || total <= 0) {
    return { ...DEFAULT_WEIGHTS };
  }
  const textPortion = roundValue(weights.text / total);
  const clicksPortion = roundValue(weights.clicks / total);
  let freshnessPortion = roundValue(weights.freshness / total);
  const sum = roundValue(textPortion + clicksPortion + freshnessPortion);
  if (sum !== 1) {
    freshnessPortion = roundValue(1 - textPortion - clicksPortion);
  }
  return {
    text: Math.max(0, Math.min(1, textPortion)),
    clicks: Math.max(0, Math.min(1, clicksPortion)),
    freshness: Math.max(0, Math.min(1, freshnessPortion)),
  };
};

const clampFraction = (value: unknown, fallback: number): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  const bounded = Math.max(0, Math.min(1, value));
  return roundValue(bounded);
};

const sanitizeResultEntry = (
  entry: Partial<SearchResult> | undefined,
  index: number,
): SearchResult => {
  const safeId = typeof entry?.id === "string" && entry.id.trim()
    ? entry.id.trim()
    : `result-${index}`;
  const safeTitle = typeof entry?.title === "string" && entry.title.trim()
    ? entry.title.trim()
    : `Result ${index + 1}`;
  return {
    id: safeId,
    title: safeTitle,
    textScore: clampFraction(entry?.textScore, 0),
    clickRate: clampFraction(entry?.clickRate, 0),
    freshness: clampFraction(entry?.freshness, 0),
  };
};

const sanitizeResults = (
  entries: readonly SearchResult[] | undefined,
): SearchResult[] => {
  if (!Array.isArray(entries)) return [];
  return entries.map((entry, index) => sanitizeResultEntry(entry, index));
};

const scoreResult = (
  result: SearchResult,
  weights: SearchWeights,
): ScoredResult => {
  const text = roundValue(result.textScore * weights.text);
  const clicks = roundValue(result.clickRate * weights.clicks);
  const freshness = roundValue(result.freshness * weights.freshness);
  const score = roundValue(text + clicks + freshness);
  return {
    id: result.id,
    title: result.title,
    score,
    contributions: { text, clicks, freshness },
  };
};

const tuneWeightsHandler = handler(
  (
    event: WeightAdjustEvent | undefined,
    context: { weights: Cell<SearchWeights> },
  ) => {
    if (event?.reset) {
      context.weights.set({ ...DEFAULT_WEIGHTS });
      return;
    }

    const current = sanitizeWeights(context.weights.get());
    const next = { ...current };

    const applyAbsolute = (
      key: keyof SearchWeights,
      value: number | undefined,
    ) => {
      if (typeof value !== "number" || !Number.isFinite(value)) return;
      next[key] = sanitizeWeightValue(value, next[key]);
    };

    const applyDelta = (
      key: keyof SearchWeights,
      value: number | undefined,
    ) => {
      if (typeof value !== "number" || !Number.isFinite(value)) return;
      next[key] = sanitizeWeightValue(next[key] + value, next[key]);
    };

    applyAbsolute("text", event?.text);
    applyAbsolute("clicks", event?.clicks);
    applyAbsolute("freshness", event?.freshness);

    applyDelta("text", event?.textDelta);
    applyDelta("clicks", event?.clicksDelta);
    applyDelta("freshness", event?.freshnessDelta);

    context.weights.set(sanitizeWeights(next));
  },
);

const updateResultMetricsHandler = handler(
  (
    event: ResultMetricEvent | undefined,
    context: { results: Cell<SearchResult[]> },
  ) => {
    const list = sanitizeResults(context.results.get());
    if (list.length === 0) return;

    const fallbackId = list[0].id;
    const targetId = typeof event?.id === "string" && event.id.trim()
      ? event.id.trim()
      : fallbackId;
    const index = list.findIndex((entry) => entry.id === targetId);
    if (index < 0) return;

    const next = { ...list[index] };

    const applyAbsolute = (
      key: keyof Pick<SearchResult, "textScore" | "clickRate" | "freshness">,
      value: number | undefined,
    ) => {
      if (typeof value !== "number" || !Number.isFinite(value)) return;
      next[key] = clampFraction(value, next[key]);
    };

    const applyDelta = (
      key: keyof Pick<SearchResult, "textScore" | "clickRate" | "freshness">,
      value: number | undefined,
    ) => {
      if (typeof value !== "number" || !Number.isFinite(value)) return;
      next[key] = clampFraction(next[key] + value, next[key]);
    };

    applyAbsolute("textScore", event?.textScore);
    applyAbsolute("clickRate", event?.clickRate);
    applyAbsolute("freshness", event?.freshness);

    applyDelta("textScore", event?.textDelta);
    applyDelta("clickRate", event?.clickDelta);
    applyDelta("freshness", event?.freshnessDelta);

    const updated = list.map((entry, position) =>
      position === index ? next : entry
    );
    context.results.set(updated);
  },
);

export const searchRelevanceTuning = recipe<SearchRelevanceArgs>(
  "Search Relevance Tuning Pattern",
  ({ results, weights }) => {
    const sanitizedResults = lift(sanitizeResults)(results);
    const sanitizedWeights = lift(sanitizeWeights)(weights);
    const normalizedWeights = lift(normalizeWeights)(sanitizedWeights);

    const scoringInputs = {
      results: sanitizedResults,
      weights: normalizedWeights,
    };

    const rankedResults = lift((input: {
      results: SearchResult[];
      weights: SearchWeights;
    }): ScoredResult[] => {
      const scored = input.results.map((entry) =>
        scoreResult(entry, input.weights)
      );
      return scored.sort((a, b) => {
        if (b.score === a.score) return a.id.localeCompare(b.id);
        return b.score - a.score;
      });
    })(scoringInputs);

    const topResult = lift((entries: ScoredResult[]) => entries[0] ?? null)(
      rankedResults,
    );

    const tuneWeights = tuneWeightsHandler({ weights });
    const updateResult = updateResultMetricsHandler({ results });

    // UI state
    const textWeightField = cell<string>("");
    const clicksWeightField = cell<string>("");
    const freshnessWeightField = cell<string>("");

    // Sync UI fields with normalized weights
    compute(() => {
      const w = normalizedWeights.get();
      if (!w) return;
      const currentText = textWeightField.get();
      if (currentText === "") {
        textWeightField.set(w.text.toFixed(3));
      }
      const currentClicks = clicksWeightField.get();
      if (currentClicks === "") {
        clicksWeightField.set(w.clicks.toFixed(3));
      }
      const currentFreshness = freshnessWeightField.get();
      if (currentFreshness === "") {
        freshnessWeightField.set(w.freshness.toFixed(3));
      }
    });

    const updateWeightsFromFields = handler(
      (_event, context: {
        textField: Cell<string>;
        clicksField: Cell<string>;
        freshnessField: Cell<string>;
        weights: Cell<SearchWeights>;
      }) => {
        const textStr = context.textField.get();
        const clicksStr = context.clicksField.get();
        const freshnessStr = context.freshnessField.get();

        const text = typeof textStr === "string" && textStr.trim() !== ""
          ? Number(textStr)
          : undefined;
        const clicks = typeof clicksStr === "string" && clicksStr.trim() !== ""
          ? Number(clicksStr)
          : undefined;
        const freshness = typeof freshnessStr === "string" &&
            freshnessStr.trim() !== ""
          ? Number(freshnessStr)
          : undefined;

        if (
          text !== undefined || clicks !== undefined || freshness !== undefined
        ) {
          const current = sanitizeWeights(context.weights.get());
          const next = {
            text: text !== undefined && Number.isFinite(text)
              ? text
              : current.text,
            clicks: clicks !== undefined && Number.isFinite(clicks)
              ? clicks
              : current.clicks,
            freshness: freshness !== undefined && Number.isFinite(freshness)
              ? freshness
              : current.freshness,
          };
          context.weights.set(sanitizeWeights(next));

          context.textField.set("");
          context.clicksField.set("");
          context.freshnessField.set("");
        }
      },
    );

    const resetWeights = handler(
      (_event, context: { weights: Cell<SearchWeights> }) => {
        context.weights.set({ ...DEFAULT_WEIGHTS });
      },
    );

    const name = lift((top: ScoredResult | null) => {
      if (!top) return "Search Relevance Tuning";
      return "Search Tuning: " + top.title + " leads";
    })(topResult);

    const resultsDisplay = lift((ranked: ScoredResult[]) => {
      if (ranked.length === 0) {
        return h(
          "div",
          {
            style:
              "padding: 2rem; text-align: center; color: #94a3b8; border: 2px dashed #cbd5e1; border-radius: 8px; background: #f8fafc;",
          },
          "No search results to rank",
        );
      }

      const cards = [];
      for (let i = 0; i < ranked.length; i++) {
        const result = ranked[i];
        const rank = i + 1;
        const isTop = i === 0;

        const rankColor = isTop ? "#10b981" : "#64748b";
        const borderColor = isTop ? "#10b981" : "#e2e8f0";
        const bgColor = isTop ? "#f0fdf4" : "#ffffff";

        const textContrib = result.contributions.text.toFixed(3);
        const clicksContrib = result.contributions.clicks.toFixed(3);
        const freshnessContrib = result.contributions.freshness.toFixed(3);

        cards.push(
          h(
            "div",
            {
              style: "border: 2px solid " + borderColor +
                "; border-radius: 8px; padding: 1rem; background: " + bgColor +
                "; margin-bottom: 0.75rem;",
            },
            h(
              "div",
              {
                style:
                  "display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.5rem;",
              },
              h(
                "div",
                { style: "display: flex; align-items: center; gap: 0.75rem;" },
                h(
                  "span",
                  {
                    style: "font-weight: bold; color: " + rankColor +
                      "; font-size: 1.5rem; font-family: monospace; min-width: 2rem;",
                  },
                  "#" + String(rank),
                ),
                h(
                  "span",
                  { style: "font-weight: 600; font-size: 1.1rem;" },
                  result.title,
                ),
              ),
              h(
                "span",
                {
                  style: "font-weight: bold; font-size: 1.5rem; color: " +
                    rankColor + "; font-family: monospace;",
                },
                result.score.toFixed(3),
              ),
            ),
            h(
              "div",
              {
                style:
                  "display: grid; grid-template-columns: repeat(3, 1fr); gap: 0.5rem; padding-top: 0.5rem; border-top: 1px solid #e2e8f0;",
              },
              h(
                "div",
                { style: "text-align: center;" },
                h(
                  "div",
                  {
                    style:
                      "font-size: 0.75rem; color: #64748b; text-transform: uppercase;",
                  },
                  "Text",
                ),
                h(
                  "div",
                  {
                    style:
                      "font-weight: 600; font-family: monospace; color: #3b82f6;",
                  },
                  textContrib,
                ),
              ),
              h(
                "div",
                { style: "text-align: center;" },
                h(
                  "div",
                  {
                    style:
                      "font-size: 0.75rem; color: #64748b; text-transform: uppercase;",
                  },
                  "Clicks",
                ),
                h(
                  "div",
                  {
                    style:
                      "font-weight: 600; font-family: monospace; color: #8b5cf6;",
                  },
                  clicksContrib,
                ),
              ),
              h(
                "div",
                { style: "text-align: center;" },
                h(
                  "div",
                  {
                    style:
                      "font-size: 0.75rem; color: #64748b; text-transform: uppercase;",
                  },
                  "Fresh",
                ),
                h(
                  "div",
                  {
                    style:
                      "font-weight: 600; font-family: monospace; color: #ec4899;",
                  },
                  freshnessContrib,
                ),
              ),
            ),
          ),
        );
      }

      return h(
        "div",
        { style: "display: flex; flex-direction: column;" },
        ...cards,
      );
    })(rankedResults);

    const weightsDisplay = lift((w: SearchWeights) => {
      return h(
        "div",
        {
          style:
            "display: grid; grid-template-columns: repeat(3, 1fr); gap: 1rem;",
        },
        h(
          "div",
          {
            style:
              "background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%); color: white; padding: 1rem; border-radius: 8px; text-align: center;",
          },
          h(
            "div",
            {
              style:
                "font-size: 0.875rem; opacity: 0.9; margin-bottom: 0.5rem;",
            },
            "Text Weight",
          ),
          h(
            "div",
            {
              style:
                "font-size: 2rem; font-weight: bold; font-family: monospace;",
            },
            w.text.toFixed(3),
          ),
        ),
        h(
          "div",
          {
            style:
              "background: linear-gradient(135deg, #8b5cf6 0%, #7c3aed 100%); color: white; padding: 1rem; border-radius: 8px; text-align: center;",
          },
          h(
            "div",
            {
              style:
                "font-size: 0.875rem; opacity: 0.9; margin-bottom: 0.5rem;",
            },
            "Clicks Weight",
          ),
          h(
            "div",
            {
              style:
                "font-size: 2rem; font-weight: bold; font-family: monospace;",
            },
            w.clicks.toFixed(3),
          ),
        ),
        h(
          "div",
          {
            style:
              "background: linear-gradient(135deg, #ec4899 0%, #db2777 100%); color: white; padding: 1rem; border-radius: 8px; text-align: center;",
          },
          h(
            "div",
            {
              style:
                "font-size: 0.875rem; opacity: 0.9; margin-bottom: 0.5rem;",
            },
            "Freshness Weight",
          ),
          h(
            "div",
            {
              style:
                "font-size: 2rem; font-weight: bold; font-family: monospace;",
            },
            w.freshness.toFixed(3),
          ),
        ),
      );
    })(normalizedWeights);

    const ui = (
      <div
        style={{
          fontFamily: "system-ui, sans-serif",
          maxWidth: "900px",
          margin: "0 auto",
          padding: "1.5rem",
        }}
      >
        <div
          style={{
            background: "linear-gradient(135deg, #667eea 0%, #764ba2 100%)",
            color: "white",
            padding: "2rem",
            borderRadius: "12px",
            marginBottom: "2rem",
            textAlign: "center",
          }}
        >
          <h1 style={{ margin: "0 0 0.5rem 0", fontSize: "2rem" }}>
            Search Relevance Tuning
          </h1>
          <p style={{ margin: "0", opacity: "0.9", fontSize: "1rem" }}>
            Adjust ranking weights to optimize search results
          </p>
        </div>

        <div
          style={{
            background: "#f8fafc",
            padding: "1.5rem",
            borderRadius: "12px",
            marginBottom: "1.5rem",
            border: "1px solid #e2e8f0",
          }}
        >
          <h2
            style={{
              margin: "0 0 1rem 0",
              fontSize: "1.25rem",
              color: "#1e293b",
            }}
          >
            Current Weights
          </h2>
          {weightsDisplay}
        </div>

        <div
          style={{
            background: "white",
            padding: "1.5rem",
            borderRadius: "12px",
            marginBottom: "1.5rem",
            border: "1px solid #e2e8f0",
          }}
        >
          <h2
            style={{
              margin: "0 0 1rem 0",
              fontSize: "1.25rem",
              color: "#1e293b",
            }}
          >
            Tune Weights
          </h2>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(3, 1fr)",
              gap: "1rem",
              marginBottom: "1rem",
            }}
          >
            <div>
              <label
                style={{
                  display: "block",
                  fontSize: "0.875rem",
                  fontWeight: "500",
                  marginBottom: "0.5rem",
                  color: "#475569",
                }}
              >
                Text Weight
              </label>
              <ct-input
                $value={textWeightField}
                type="number"
                step="0.001"
                min="0"
                max="1"
                placeholder="0.600"
                style={{
                  width: "100%",
                  padding: "0.5rem",
                  border: "1px solid #cbd5e1",
                  borderRadius: "6px",
                  fontFamily: "monospace",
                }}
              />
            </div>
            <div>
              <label
                style={{
                  display: "block",
                  fontSize: "0.875rem",
                  fontWeight: "500",
                  marginBottom: "0.5rem",
                  color: "#475569",
                }}
              >
                Clicks Weight
              </label>
              <ct-input
                $value={clicksWeightField}
                type="number"
                step="0.001"
                min="0"
                max="1"
                placeholder="0.300"
                style={{
                  width: "100%",
                  padding: "0.5rem",
                  border: "1px solid #cbd5e1",
                  borderRadius: "6px",
                  fontFamily: "monospace",
                }}
              />
            </div>
            <div>
              <label
                style={{
                  display: "block",
                  fontSize: "0.875rem",
                  fontWeight: "500",
                  marginBottom: "0.5rem",
                  color: "#475569",
                }}
              >
                Freshness Weight
              </label>
              <ct-input
                $value={freshnessWeightField}
                type="number"
                step="0.001"
                min="0"
                max="1"
                placeholder="0.100"
                style={{
                  width: "100%",
                  padding: "0.5rem",
                  border: "1px solid #cbd5e1",
                  borderRadius: "6px",
                  fontFamily: "monospace",
                }}
              />
            </div>
          </div>
          <div style={{ display: "flex", gap: "0.75rem" }}>
            <ct-button
              onClick={updateWeightsFromFields({
                textField: textWeightField,
                clicksField: clicksWeightField,
                freshnessField: freshnessWeightField,
                weights,
              })}
              style={{
                flex: "1",
                padding: "0.75rem",
                background: "#3b82f6",
                color: "white",
                border: "none",
                borderRadius: "6px",
                fontWeight: "600",
                cursor: "pointer",
              }}
            >
              Apply Weights
            </ct-button>
            <ct-button
              onClick={resetWeights({ weights })}
              style={{
                padding: "0.75rem 1.5rem",
                background: "#64748b",
                color: "white",
                border: "none",
                borderRadius: "6px",
                fontWeight: "600",
                cursor: "pointer",
              }}
            >
              Reset to Defaults
            </ct-button>
          </div>
        </div>

        <div
          style={{
            background: "white",
            padding: "1.5rem",
            borderRadius: "12px",
            border: "1px solid #e2e8f0",
          }}
        >
          <h2
            style={{
              margin: "0 0 1rem 0",
              fontSize: "1.25rem",
              color: "#1e293b",
            }}
          >
            Ranked Results
          </h2>
          {resultsDisplay}
        </div>
      </div>
    );

    return {
      results,
      weights,
      sanitizedResults,
      sanitizedWeights,
      normalizedWeights,
      rankedResults,
      topResult,
      tuneWeights,
      updateResult,
      [NAME]: name,
      [UI]: ui,
    };
  },
);
