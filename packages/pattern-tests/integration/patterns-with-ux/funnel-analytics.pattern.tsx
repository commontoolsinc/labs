/// <cts-enable />
import {
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
import type { Cell } from "commontools";

interface FunnelStageInput {
  id?: string;
  label?: string;
  count?: number;
}

interface FunnelAnalyticsArgs {
  stages: Default<FunnelStageInput[], typeof defaultStageSeeds>;
}

interface FunnelStage extends FunnelStageInput {
  id: string;
  label: string;
  count: number;
}

interface StageMetric extends FunnelStage {
  dropOffRate: number;
  conversionRate: number;
  dropOffPercent: string;
  conversionPercent: string;
}

interface FunnelDropOffDetail {
  fromId: string;
  toId: string;
  fromStage: string;
  toStage: string;
  lost: number;
  dropOffRate: number;
  dropOffPercent: string;
}

interface StageUpdateEvent {
  stageId?: string;
  delta?: number;
  value?: number;
}

interface StageUpdateEntry {
  stageId: string;
  label: string;
  count: number;
  mode: "delta" | "value";
}

const defaultStageSeeds: FunnelStageInput[] = [
  { id: "awareness", label: "Awareness", count: 1200 },
  { id: "interest", label: "Interest", count: 720 },
  { id: "evaluation", label: "Evaluation", count: 320 },
  { id: "purchase", label: "Purchase", count: 96 },
];

const normalizeSlug = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

const sanitizeId = (value: unknown, fallback: string): string => {
  if (typeof value === "string" && value.trim().length > 0) {
    const normalized = normalizeSlug(value);
    if (normalized.length > 0) return normalized;
  }
  const fallbackNormalized = normalizeSlug(fallback);
  return fallbackNormalized.length > 0 ? fallbackNormalized : "stage";
};

const sanitizeLabel = (value: unknown, fallback: string): string => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return fallback;
};

const sanitizeCount = (value: unknown, fallback: number): number => {
  const base = Number.isFinite(fallback) ? Math.round(fallback) : 0;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return base < 0 ? 0 : base;
  }
  const rounded = Math.round(value);
  return rounded < 0 ? 0 : rounded;
};

const fallbackStageAt = (index: number): FunnelStage => {
  const seed = defaultStageSeeds[index];
  const fallbackLabel = sanitizeLabel(seed?.label, `Stage ${index + 1}`);
  const idSource = seed?.id ?? fallbackLabel;
  const id = sanitizeId(idSource, `stage-${index + 1}`);
  const count = sanitizeCount(seed?.count, seed?.count ?? 0);
  return { id, label: fallbackLabel, count };
};

const cloneDefaultStages = (): FunnelStage[] =>
  defaultStageSeeds.map((_, index) => ({ ...fallbackStageAt(index) }));

const sanitizeStage = (
  value: FunnelStageInput | undefined,
  index: number,
): FunnelStage => {
  const fallback = fallbackStageAt(index);
  const id = sanitizeId(value?.id ?? value?.label, fallback.id);
  const label = sanitizeLabel(value?.label, fallback.label);
  const count = sanitizeCount(value?.count, fallback.count);
  return { id, label, count };
};

const sanitizeStages = (value: unknown): FunnelStage[] => {
  if (!Array.isArray(value)) return cloneDefaultStages();
  const seen = new Set<string>();
  const sanitized: FunnelStage[] = [];
  for (let index = 0; index < value.length; index++) {
    const entry = sanitizeStage(
      value[index] as FunnelStageInput | undefined,
      index,
    );
    if (seen.has(entry.id)) continue;
    sanitized.push(entry);
    seen.add(entry.id);
  }
  if (sanitized.length < 2) return cloneDefaultStages();
  return sanitized;
};

const sanitizeStageId = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const normalized = normalizeSlug(value);
  return normalized.length > 0 ? normalized : null;
};

const sanitizeDelta = (value: unknown): number | null => {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.round(value);
};

const sanitizeValue = (value: unknown): number | null => {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const rounded = Math.round(value);
  return rounded < 0 ? 0 : rounded;
};

const normalizeRatio = (value: number): number => {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return Math.round(value * 1000) / 1000;
};

const formatPercent = (ratio: number): string => `${(ratio * 100).toFixed(1)}%`;

const updateStageCount = handler(
  (
    event: StageUpdateEvent | undefined,
    context: {
      stages: Cell<FunnelStageInput[]>;
      history: Cell<StageUpdateEntry[]>;
    },
  ) => {
    const stageId = sanitizeStageId(event?.stageId);
    if (!stageId) return;

    const current = sanitizeStages(context.stages.get());
    const index = current.findIndex((entry) => entry.id === stageId);
    if (index === -1) return;

    const value = sanitizeValue(event?.value);
    const delta = sanitizeDelta(event?.delta);

    let nextCount = current[index].count;
    let mode: "delta" | "value" | null = null;

    if (value !== null) {
      nextCount = value;
      mode = "value";
    } else if (delta !== null) {
      nextCount = current[index].count + delta;
      if (nextCount < 0) nextCount = 0;
      mode = "delta";
    }

    if (mode === null || nextCount === current[index].count) return;

    const updated = current.map((stage, position) =>
      position === index ? { ...stage, count: nextCount } : stage
    );
    context.stages.set(updated);

    const historyValue = context.history.get();
    const historyList = Array.isArray(historyValue) ? historyValue : [];
    const trimmed = historyList.slice(-4);
    context.history.set([
      ...trimmed,
      {
        stageId: current[index].id,
        label: current[index].label,
        count: nextCount,
        mode,
      },
    ]);
  },
);

const loadStageSnapshot = handler(
  (
    event: { stages?: FunnelStageInput[] } | undefined,
    context: {
      stages: Cell<FunnelStageInput[]>;
      history: Cell<StageUpdateEntry[]>;
    },
  ) => {
    if (!event?.stages) return;
    const sanitized = sanitizeStages(event.stages);
    context.stages.set(sanitized);
    context.history.set([]);
  },
);

const uiUpdateStageCount = handler(
  (
    _event: unknown,
    context: {
      stages: Cell<FunnelStageInput[]>;
      history: Cell<StageUpdateEntry[]>;
      stageIdField: Cell<string>;
      deltaField: Cell<string>;
      valueField: Cell<string>;
    },
  ) => {
    const stageIdStr = context.stageIdField.get();
    const stageId = sanitizeStageId(stageIdStr);
    if (!stageId) return;

    const current = sanitizeStages(context.stages.get());
    const index = current.findIndex((entry) => entry.id === stageId);
    if (index === -1) return;

    const valueStr = context.valueField.get();
    const deltaStr = context.deltaField.get();

    const value = typeof valueStr === "string" && valueStr.trim() !== ""
      ? sanitizeValue(Number(valueStr))
      : null;
    const delta = typeof deltaStr === "string" && deltaStr.trim() !== ""
      ? sanitizeDelta(Number(deltaStr))
      : null;

    let nextCount = current[index].count;
    let mode: "delta" | "value" | null = null;

    if (value !== null) {
      nextCount = value;
      mode = "value";
    } else if (delta !== null) {
      nextCount = current[index].count + delta;
      if (nextCount < 0) nextCount = 0;
      mode = "delta";
    }

    if (mode === null || nextCount === current[index].count) return;

    const updated = current.map((stage, position) =>
      position === index ? { ...stage, count: nextCount } : stage
    );
    context.stages.set(updated);

    const historyValue = context.history.get();
    const historyList = Array.isArray(historyValue) ? historyValue : [];
    const trimmed = historyList.slice(-4);
    context.history.set([
      ...trimmed,
      {
        stageId: current[index].id,
        label: current[index].label,
        count: nextCount,
        mode,
      },
    ]);

    context.stageIdField.set("");
    context.deltaField.set("");
    context.valueField.set("");
  },
);

export const funnelAnalytics = recipe<FunnelAnalyticsArgs>(
  "Funnel Analytics",
  ({ stages }) => {
    const updateHistory = cell<StageUpdateEntry[]>([]);

    const stageList = lift(sanitizeStages)(stages);
    const stageMetrics = lift((entries: FunnelStage[]) => {
      if (!Array.isArray(entries) || entries.length === 0) return [];
      const base = entries[0]?.count ?? 0;
      let previous = base;
      return entries.map((stage, index) => {
        const dropOffBase = index === 0 ? 0 : previous;
        const drop = dropOffBase === 0
          ? 0
          : normalizeRatio((dropOffBase - stage.count) / dropOffBase);
        const conversion = base === 0 ? 0 : normalizeRatio(stage.count / base);
        previous = stage.count;
        return {
          id: stage.id,
          label: stage.label,
          count: stage.count,
          dropOffRate: drop,
          conversionRate: conversion,
          dropOffPercent: formatPercent(drop),
          conversionPercent: formatPercent(conversion),
        };
      });
    })(stageList);

    const dropOffDetails = lift((metrics: StageMetric[]) => {
      if (!Array.isArray(metrics)) return [];
      const details: FunnelDropOffDetail[] = [];
      for (let index = 1; index < metrics.length; index++) {
        const current = metrics[index];
        const previous = metrics[index - 1];
        const lost = previous.count - current.count;
        details.push({
          fromId: previous.id,
          toId: current.id,
          fromStage: previous.label,
          toStage: current.label,
          lost: lost > 0 ? lost : 0,
          dropOffRate: current.dropOffRate,
          dropOffPercent: current.dropOffPercent,
        });
      }
      return details;
    })(stageMetrics);

    const stageOrder = lift((metrics: StageMetric[]) =>
      Array.isArray(metrics) ? metrics.map((stage) => stage.id) : []
    )(stageMetrics);

    const overallConversionRate = lift((metrics: StageMetric[]) => {
      if (!Array.isArray(metrics) || metrics.length === 0) return 0;
      const last = metrics[metrics.length - 1];
      return normalizeRatio(last.conversionRate);
    })(stageMetrics);

    const overallConversionPercent = lift((ratio: number) =>
      formatPercent(normalizeRatio(ratio))
    )(overallConversionRate);

    const overallConversionLabel =
      str`Overall conversion ${overallConversionPercent}`;

    const worstStage = lift((metrics: StageMetric[] | undefined) => {
      if (!Array.isArray(metrics) || metrics.length === 0) {
        return { label: "No stages", dropOffPercent: "0.0%" };
      }
      if (metrics.length === 1) {
        return {
          label: metrics[0].label,
          dropOffPercent: metrics[0].dropOffPercent,
        };
      }
      let worst = metrics[1];
      for (let index = 2; index < metrics.length; index++) {
        const candidate = metrics[index];
        if (candidate.dropOffRate > worst.dropOffRate) {
          worst = candidate;
          continue;
        }
        if (
          candidate.dropOffRate === worst.dropOffRate &&
          candidate.label.localeCompare(worst.label) < 0
        ) {
          worst = candidate;
        }
      }
      return { label: worst.label, dropOffPercent: worst.dropOffPercent };
    })(stageMetrics);

    const worstLabel = lift((entry: { label: string }) => entry.label)(
      worstStage,
    );
    const worstPercent = lift(
      (entry: { dropOffPercent: string }) => entry.dropOffPercent,
    )(worstStage);
    const dropOffSummary = str`${worstLabel} drop-off ${worstPercent}`;

    const historyView = lift((entries: StageUpdateEntry[] | undefined) =>
      Array.isArray(entries) ? entries : []
    )(updateHistory);

    const lastUpdate = lift((entries: StageUpdateEntry[]) => {
      if (!Array.isArray(entries) || entries.length === 0) {
        return { stageId: "none", label: "None", count: 0, mode: "delta" };
      }
      return entries[entries.length - 1];
    })(historyView);

    // UI-specific cells
    const stageIdField = cell<string>("");
    const deltaField = cell<string>("");
    const valueField = cell<string>("");

    const name = str`Funnel Analytics`;

    const funnelViz = lift((metrics: StageMetric[]) => {
      if (!Array.isArray(metrics) || metrics.length === 0) {
        return h(
          "div",
          {
            style:
              "padding: 2rem; text-align: center; color: #64748b; border: 2px dashed #e2e8f0; border-radius: 8px;",
          },
          "No funnel stages",
        );
      }

      const maxCount = Math.max(...metrics.map((m) => m.count), 1);
      const stageElements = [];

      for (let i = 0; i < metrics.length; i++) {
        const metric = metrics[i];
        const widthPercent = (metric.count / maxCount) * 100;
        const bgColor = i === 0
          ? "#3b82f6"
          : i === 1
          ? "#8b5cf6"
          : i === 2
          ? "#ec4899"
          : "#f59e0b";

        const dropOffSection = i > 0
          ? h(
            "div",
            {
              style:
                "margin-top: 0.5rem; padding: 0.5rem; background: #fef3c7; border-radius: 4px; font-size: 0.875rem;",
            },
            h(
              "span",
              { style: "color: #92400e; font-weight: 600;" },
              "Drop-off: " + metric.dropOffPercent,
            ),
          )
          : h("div", {});

        const stageCard = h(
          "div",
          {
            style: "background: white; border: 2px solid " + bgColor +
              "; border-radius: 8px; padding: 1rem; margin-bottom: 0.75rem;",
          },
          h(
            "div",
            {
              style:
                "display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem;",
            },
            h(
              "div",
              {},
              h(
                "div",
                {
                  style: "font-weight: 600; font-size: 1.1rem; color: #1e293b;",
                },
                metric.label,
              ),
              h(
                "div",
                {
                  style:
                    "font-size: 0.875rem; color: #64748b; font-family: monospace;",
                },
                "ID: " + metric.id,
              ),
            ),
            h(
              "div",
              { style: "text-align: right;" },
              h(
                "div",
                {
                  style:
                    "font-size: 1.5rem; font-weight: 700; font-family: monospace; color: " +
                    bgColor + ";",
                },
                String(metric.count),
              ),
              h(
                "div",
                { style: "font-size: 0.875rem; color: #64748b;" },
                metric.conversionPercent + " of top",
              ),
            ),
          ),
          h(
            "div",
            {
              style:
                "width: 100%; background: #f1f5f9; border-radius: 4px; height: 24px; overflow: hidden;",
            },
            h("div", {
              style: "height: 100%; background: " + bgColor +
                "; width: " + String(widthPercent) +
                "%; transition: width 0.3s ease;",
            }),
          ),
          dropOffSection,
        );

        stageElements.push(stageCard);
      }

      return h(
        "div",
        { style: "display: flex; flex-direction: column;" },
        ...stageElements,
      );
    })(stageMetrics);

    const dropOffViz = lift((details: FunnelDropOffDetail[]) => {
      if (!Array.isArray(details) || details.length === 0) {
        return h(
          "div",
          {
            style: "padding: 1rem; color: #64748b; text-align: center;",
          },
          "No drop-off data",
        );
      }

      const detailElements = [];
      for (const detail of details) {
        const detailCard = h(
          "div",
          {
            style:
              "background: white; border: 1px solid #e2e8f0; border-radius: 6px; padding: 1rem; margin-bottom: 0.75rem;",
          },
          h(
            "div",
            {
              style:
                "font-size: 0.875rem; color: #64748b; margin-bottom: 0.5rem;",
            },
            detail.fromStage + " → " + detail.toStage,
          ),
          h(
            "div",
            {
              style:
                "display: grid; grid-template-columns: 1fr 1fr; gap: 1rem;",
            },
            h(
              "div",
              {},
              h(
                "div",
                {
                  style:
                    "font-size: 0.75rem; color: #64748b; text-transform: uppercase;",
                },
                "Lost Users",
              ),
              h(
                "div",
                {
                  style:
                    "font-size: 1.25rem; font-weight: 700; font-family: monospace; color: #dc2626;",
                },
                String(detail.lost),
              ),
            ),
            h(
              "div",
              {},
              h(
                "div",
                {
                  style:
                    "font-size: 0.75rem; color: #64748b; text-transform: uppercase;",
                },
                "Drop-off Rate",
              ),
              h(
                "div",
                {
                  style:
                    "font-size: 1.25rem; font-weight: 700; font-family: monospace; color: #dc2626;",
                },
                detail.dropOffPercent,
              ),
            ),
          ),
        );
        detailElements.push(detailCard);
      }

      return h(
        "div",
        { style: "display: flex; flex-direction: column;" },
        ...detailElements,
      );
    })(dropOffDetails);

    const historyViz = lift((entries: StageUpdateEntry[]) => {
      if (!Array.isArray(entries) || entries.length === 0) {
        return h(
          "div",
          {
            style:
              "padding: 1rem; color: #64748b; text-align: center; font-style: italic;",
          },
          "No updates yet",
        );
      }

      const reversed = entries.slice().reverse();
      const historyElements = [];

      for (let i = 0; i < Math.min(reversed.length, 5); i++) {
        const entry = reversed[i];
        const bgColor = i % 2 === 0 ? "#ffffff" : "#f9fafb";
        const modeColor = entry.mode === "value" ? "#3b82f6" : "#8b5cf6";
        const modeLabel = entry.mode === "value" ? "SET" : "DELTA";

        const historyRow = h(
          "div",
          {
            style: "background: " + bgColor +
              "; padding: 0.75rem; border-left: 3px solid " + modeColor + ";",
          },
          h(
            "div",
            {
              style:
                "display: flex; justify-content: space-between; align-items: center;",
            },
            h(
              "div",
              {},
              h(
                "span",
                { style: "font-weight: 600; color: #1e293b;" },
                entry.label,
              ),
              h(
                "span",
                {
                  style:
                    "margin-left: 0.5rem; padding: 0.125rem 0.5rem; background: " +
                    modeColor +
                    "; color: white; border-radius: 4px; font-size: 0.75rem; font-weight: 600;",
                },
                modeLabel,
              ),
            ),
            h(
              "div",
              {
                style:
                  "font-family: monospace; font-weight: 700; font-size: 1.1rem; color: #1e293b;",
              },
              String(entry.count),
            ),
          ),
        );

        historyElements.push(historyRow);
      }

      return h(
        "div",
        {
          style:
            "border: 1px solid #e2e8f0; border-radius: 6px; overflow: hidden;",
        },
        ...historyElements,
      );
    })(historyView);

    const ui = (
      <div
        style={{
          maxWidth: "900px",
          margin: "0 auto",
          padding: "1.5rem",
          fontFamily: "system-ui, sans-serif",
          background: "linear-gradient(135deg, #667eea 0%, #764ba2 100%)",
          minHeight: "100vh",
        }}
      >
        <div
          style={{
            background: "white",
            borderRadius: "12px",
            padding: "2rem",
            boxShadow: "0 4px 6px rgba(0,0,0,0.1)",
          }}
        >
          <h1
            style={{
              margin: "0 0 1rem 0",
              fontSize: "2rem",
              fontWeight: "700",
              color: "#1e293b",
            }}
          >
            Funnel Analytics
          </h1>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: "1rem",
              marginBottom: "2rem",
            }}
          >
            <div
              style={{
                background: "linear-gradient(135deg, #667eea 0%, #764ba2 100%)",
                borderRadius: "8px",
                padding: "1.5rem",
                textAlign: "center",
                color: "white",
              }}
            >
              <div style={{ fontSize: "0.875rem", marginBottom: "0.5rem" }}>
                Overall Conversion
              </div>
              <div style={{ fontSize: "2.5rem", fontWeight: "700" }}>
                {overallConversionPercent}
              </div>
            </div>

            <div
              style={{
                background: "linear-gradient(135deg, #f59e0b 0%, #dc2626 100%)",
                borderRadius: "8px",
                padding: "1.5rem",
                textAlign: "center",
                color: "white",
              }}
            >
              <div style={{ fontSize: "0.875rem", marginBottom: "0.5rem" }}>
                Worst Drop-off
              </div>
              <div style={{ fontSize: "1.25rem", fontWeight: "600" }}>
                {worstLabel}
              </div>
              <div style={{ fontSize: "1.5rem", fontWeight: "700" }}>
                {worstPercent}
              </div>
            </div>
          </div>

          <h2
            style={{
              fontSize: "1.25rem",
              fontWeight: "600",
              color: "#1e293b",
              marginTop: "2rem",
              marginBottom: "1rem",
            }}
          >
            Funnel Stages
          </h2>
          {funnelViz}

          <h2
            style={{
              fontSize: "1.25rem",
              fontWeight: "600",
              color: "#1e293b",
              marginTop: "2rem",
              marginBottom: "1rem",
            }}
          >
            Drop-off Analysis
          </h2>
          {dropOffViz}

          <h2
            style={{
              fontSize: "1.25rem",
              fontWeight: "600",
              color: "#1e293b",
              marginTop: "2rem",
              marginBottom: "1rem",
            }}
          >
            Update Stage
          </h2>
          <div
            style={{
              background: "#f8fafc",
              borderRadius: "8px",
              padding: "1.5rem",
              marginBottom: "1.5rem",
            }}
          >
            <div style={{ marginBottom: "1rem" }}>
              <label
                style={{
                  display: "block",
                  fontSize: "0.875rem",
                  fontWeight: "600",
                  color: "#475569",
                  marginBottom: "0.5rem",
                }}
              >
                Stage ID
              </label>
              <ct-input
                type="text"
                $value={stageIdField}
                placeholder="e.g., awareness, interest"
                style="width: 100%;"
              />
            </div>

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: "1rem",
                marginBottom: "1rem",
              }}
            >
              <div>
                <label
                  style={{
                    display: "block",
                    fontSize: "0.875rem",
                    fontWeight: "600",
                    color: "#475569",
                    marginBottom: "0.5rem",
                  }}
                >
                  Delta (±)
                </label>
                <ct-input
                  type="number"
                  $value={deltaField}
                  placeholder="e.g., -50 or +100"
                  style="width: 100%;"
                />
              </div>

              <div>
                <label
                  style={{
                    display: "block",
                    fontSize: "0.875rem",
                    fontWeight: "600",
                    color: "#475569",
                    marginBottom: "0.5rem",
                  }}
                >
                  Set Value
                </label>
                <ct-input
                  type="number"
                  $value={valueField}
                  placeholder="e.g., 500"
                  style="width: 100%;"
                />
              </div>
            </div>

            <ct-button
              onClick={uiUpdateStageCount({
                stages,
                history: updateHistory,
                stageIdField,
                deltaField,
                valueField,
              })}
              style={{
                background: "#3b82f6",
                color: "white",
                padding: "0.75rem 1.5rem",
                borderRadius: "6px",
                fontWeight: "600",
                cursor: "pointer",
                border: "none",
                width: "100%",
              }}
            >
              Apply Update
            </ct-button>

            <div
              style={{
                marginTop: "1rem",
                padding: "0.75rem",
                background: "#e0e7ff",
                borderRadius: "4px",
                fontSize: "0.875rem",
                color: "#3730a3",
              }}
            >
              💡 Enter a stage ID and either a delta (relative change) or a
              value (absolute set). Leave one field empty to use the other.
            </div>
          </div>

          <h2
            style={{
              fontSize: "1.25rem",
              fontWeight: "600",
              color: "#1e293b",
              marginTop: "2rem",
              marginBottom: "1rem",
            }}
          >
            Recent Updates
          </h2>
          {historyViz}
        </div>
      </div>
    );

    return {
      [NAME]: name,
      [UI]: ui,
      stages,
      stageMetrics,
      dropOffDetails,
      stageOrder,
      overallConversionRate,
      overallConversionPercent,
      overallConversionLabel,
      dropOffSummary,
      updateHistory: historyView,
      lastUpdate,
      updateStage: updateStageCount({ stages, history: updateHistory }),
      loadSnapshot: loadStageSnapshot({ stages, history: updateHistory }),
    };
  },
);

export type {
  FunnelAnalyticsArgs,
  FunnelDropOffDetail,
  FunnelStage,
  StageMetric,
  StageUpdateEntry,
};
