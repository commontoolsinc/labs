/// <cts-enable />
// @ts-nocheck
import {
  type Cell,
  cell,
  Default,
  derive,
  h,
  handler,
  lift,
  NAME,
  recipe,
  str,
  UI,
} from "commontools";

interface FeatureUsageArgs {
  events: Default<FeatureUsageInput[], []>;
  defaultDelta: Default<number, 1>;
}

interface FeatureUsageInput {
  feature?: string;
  cohort?: string;
  count?: number;
}

interface FeatureUsageBucket {
  feature: string;
  cohort: string;
  count: number;
}

interface FeatureUsageEvent {
  feature?: string;
  cohort?: string;
  delta?: number;
  value?: number;
}

interface TopEntry {
  name: string;
  count: number;
}

interface MetricsData {
  featureTotals: Record<string, number>;
  cohortTotals: Record<string, number>;
  matrix: Record<string, Record<string, number>>;
  total: number;
  topFeature: TopEntry;
  topCohort: TopEntry;
  snapshot: UsageMetricsSnapshot;
}

interface UsageMetricsSnapshot {
  total: number;
  features: Record<string, number>;
  cohorts: Record<string, number>;
  featureCount: number;
  cohortCount: number;
  topFeature: string;
  topFeatureCount: number;
  topCohort: string;
  topCohortCount: number;
}

const sanitizeLabel = (input: unknown, fallback: string): string => {
  if (typeof input === "string") {
    const trimmed = input.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return fallback;
};

const sanitizeCount = (input: unknown, fallback: number): number => {
  if (typeof input !== "number" || !Number.isFinite(input)) {
    return fallback;
  }
  const rounded = Math.round(input);
  return rounded < 0 ? 0 : rounded;
};

const sanitizeEvents = (value: unknown): FeatureUsageBucket[] => {
  if (!Array.isArray(value)) return [];
  const aggregated = new Map<string, FeatureUsageBucket>();
  for (let index = 0; index < value.length; index++) {
    const raw = value[index] as FeatureUsageInput | undefined;
    const fallbackFeature = `feature-${index + 1}`;
    const feature = sanitizeLabel(raw?.feature, fallbackFeature);
    const cohort = sanitizeLabel(raw?.cohort, "general");
    const count = sanitizeCount(raw?.count, 0);
    const key = `${feature}::${cohort}`;
    const existing = aggregated.get(key);
    if (existing) {
      aggregated.set(key, {
        feature,
        cohort,
        count: existing.count + count,
      });
    } else {
      aggregated.set(key, { feature, cohort, count });
    }
  }
  const buckets = Array.from(aggregated.values());
  buckets.sort((left, right) => {
    const featureOrder = left.feature.localeCompare(right.feature);
    if (featureOrder !== 0) return featureOrder;
    return left.cohort.localeCompare(right.cohort);
  });
  return buckets;
};

const computeFeatureTotals = (
  buckets: readonly FeatureUsageBucket[],
): Record<string, number> => {
  const totals: Record<string, number> = {};
  for (const bucket of buckets) {
    const { feature, count } = bucket;
    totals[feature] = (totals[feature] ?? 0) + count;
  }
  return totals;
};

const computeCohortTotals = (
  buckets: readonly FeatureUsageBucket[],
): Record<string, number> => {
  const totals: Record<string, number> = {};
  for (const bucket of buckets) {
    const { cohort, count } = bucket;
    totals[cohort] = (totals[cohort] ?? 0) + count;
  }
  return totals;
};

const computeMatrix = (
  buckets: readonly FeatureUsageBucket[],
): Record<string, Record<string, number>> => {
  const output: Record<string, Record<string, number>> = {};
  for (const bucket of buckets) {
    const featureEntry = output[bucket.feature] ?? {};
    featureEntry[bucket.cohort] = bucket.count;
    output[bucket.feature] = featureEntry;
  }
  return output;
};

const pickTopEntry = (totals: Record<string, number>): TopEntry => {
  const keys = Object.keys(totals);
  if (keys.length === 0) return { name: "none", count: 0 };
  let best = keys[0];
  for (let index = 1; index < keys.length; index++) {
    const candidate = keys[index];
    const value = totals[candidate] ?? 0;
    const bestValue = totals[best] ?? 0;
    if (value > bestValue) {
      best = candidate;
      continue;
    }
    if (value === bestValue && candidate.localeCompare(best) < 0) {
      best = candidate;
    }
  }
  return { name: best, count: totals[best] ?? 0 };
};

const buildMetricsSnapshot = (
  buckets: readonly FeatureUsageBucket[],
): UsageMetricsSnapshot => {
  const featureTotals = computeFeatureTotals(buckets);
  const cohortTotals = computeCohortTotals(buckets);
  const total = buckets.reduce((sum, entry) => sum + entry.count, 0);
  const topFeature = pickTopEntry(featureTotals);
  const topCohort = pickTopEntry(cohortTotals);
  return {
    total,
    features: featureTotals,
    cohorts: cohortTotals,
    featureCount: Object.keys(featureTotals).length,
    cohortCount: Object.keys(cohortTotals).length,
    topFeature: topFeature.name,
    topFeatureCount: topFeature.count,
    topCohort: topCohort.name,
    topCohortCount: topCohort.count,
  };
};

const recordFeatureUsage = handler(
  (
    event: FeatureUsageEvent | undefined,
    context: {
      events: Cell<FeatureUsageInput[]>;
      defaultDelta: Cell<number>;
      lastEvent: Cell<string>;
    },
  ) => {
    const buckets = sanitizeEvents(context.events.get());
    const fallbackFeature = `feature-${buckets.length + 1}`;
    const feature = sanitizeLabel(event?.feature, fallbackFeature);
    const cohort = sanitizeLabel(event?.cohort, "general");
    const defaultDelta = sanitizeCount(context.defaultDelta.get(), 1) || 1;
    const delta = sanitizeCount(event?.delta, defaultDelta) || defaultDelta;
    const hasOverride = typeof event?.value === "number" &&
      Number.isFinite(event.value);
    const override = hasOverride
      ? sanitizeCount(event?.value, delta)
      : undefined;

    const index = buckets.findIndex((entry) =>
      entry.feature === feature && entry.cohort === cohort
    );
    if (index >= 0) {
      const existing = buckets[index];
      const next = override ?? existing.count + delta;
      buckets[index] = { feature, cohort, count: next };
    } else {
      const initial = override ?? delta;
      buckets.push({ feature, cohort, count: initial });
    }

    buckets.sort((left, right) => {
      const featureOrder = left.feature.localeCompare(right.feature);
      if (featureOrder !== 0) return featureOrder;
      return left.cohort.localeCompare(right.cohort);
    });

    context.events.set(buckets.map((entry) => ({
      feature: entry.feature,
      cohort: entry.cohort,
      count: entry.count,
    })));

    const descriptor = override !== undefined ? `=${override}` : `+${delta}`;
    context.lastEvent.set(`${feature}>${cohort} ${descriptor}`);
  },
);

const trackFeature = handler(
  (_event: unknown, context: {
    events: Cell<FeatureUsageInput[]>;
    defaultDelta: Cell<number>;
    lastEvent: Cell<string>;
    featureField: Cell<string>;
    cohortField: Cell<string>;
  }) => {
    const featureValue = context.featureField.get() || "";
    const cohortValue = context.cohortField.get() || "";

    const buckets = sanitizeEvents(context.events.get());
    const fallbackFeature = `feature-${buckets.length + 1}`;
    const feature = sanitizeLabel(featureValue, fallbackFeature);
    const cohort = sanitizeLabel(cohortValue, "general");
    const defaultDelta = sanitizeCount(context.defaultDelta.get(), 1) || 1;

    const index = buckets.findIndex((entry) =>
      entry.feature === feature && entry.cohort === cohort
    );
    if (index >= 0) {
      const existing = buckets[index];
      buckets[index] = {
        feature,
        cohort,
        count: existing.count + defaultDelta,
      };
    } else {
      buckets.push({ feature, cohort, count: defaultDelta });
    }

    buckets.sort((left, right) => {
      const featureOrder = left.feature.localeCompare(right.feature);
      if (featureOrder !== 0) return featureOrder;
      return left.cohort.localeCompare(right.cohort);
    });

    context.events.set(buckets.map((entry) => ({
      feature: entry.feature,
      cohort: entry.cohort,
      count: entry.count,
    })));

    context.lastEvent.set(`${feature}>${cohort} +${defaultDelta}`);
    context.featureField.set("");
    context.cohortField.set("");
  },
);

export const featureUsageAnalyticsUx = recipe<FeatureUsageArgs>(
  "Feature Usage Analytics (UX)",
  ({ events, defaultDelta }) => {
    const lastEvent = cell("none");
    const featureField = cell<string>("");
    const cohortField = cell<string>("");

    const usageBuckets = lift((value: FeatureUsageInput[] | undefined) =>
      sanitizeEvents(value)
    )(events);

    const defaultDeltaValue = lift((value: number | undefined) => {
      const sanitized = sanitizeCount(value, 1);
      return sanitized === 0 ? 1 : sanitized;
    })(defaultDelta);

    const metricsData = lift((list: FeatureUsageBucket[] | undefined) => {
      const buckets = Array.isArray(list) ? list : [];
      const featureTotals = computeFeatureTotals(buckets);
      const cohortTotals = computeCohortTotals(buckets);
      const matrix = computeMatrix(buckets);
      const total = buckets.reduce((sum, entry) => sum + entry.count, 0);
      const topFeature = pickTopEntry(featureTotals);
      const topCohort = pickTopEntry(cohortTotals);
      const snapshot: UsageMetricsSnapshot = {
        total,
        features: featureTotals,
        cohorts: cohortTotals,
        featureCount: Object.keys(featureTotals).length,
        cohortCount: Object.keys(cohortTotals).length,
        topFeature: topFeature.name,
        topFeatureCount: topFeature.count,
        topCohort: topCohort.name,
        topCohortCount: topCohort.count,
      };
      return {
        featureTotals,
        cohortTotals,
        matrix,
        total,
        topFeature,
        topCohort,
        snapshot,
      } as MetricsData;
    })(usageBuckets);

    const totalCount = lift((data: MetricsData) => data.total)(metricsData);
    const topFeature = lift((data: MetricsData) => data.topFeature)(
      metricsData,
    );
    const topCohort = lift((data: MetricsData) => data.topCohort)(metricsData);

    const name = str`Analytics: ${totalCount} events`;

    const trackHandler = trackFeature({
      events,
      defaultDelta: defaultDeltaValue,
      lastEvent,
      featureField,
      cohortField,
    });

    const metricsDisplay = lift((data: MetricsData) => {
      const featureEntries = Object.entries(data.featureTotals).sort((a, b) =>
        b[1] - a[1]
      );
      const cohortEntries = Object.entries(data.cohortTotals).sort((a, b) =>
        b[1] - a[1]
      );

      if (featureEntries.length === 0) {
        return (
          <div style="
              text-align: center;
              padding: 2rem;
              color: #64748b;
              font-style: italic;
            ">
            No usage data yet. Track some features to get started.
          </div>
        );
      }

      const featureElements = [];
      for (let i = 0; i < featureEntries.length; i++) {
        const [feature, count] = featureEntries[i];
        const percent = data.total > 0
          ? Math.round((count / data.total) * 100)
          : 0;
        const isTop = feature === data.topFeature.name;

        featureElements.push(
          <div
            style={"background: " + (isTop ? "#ecfdf5" : "#f8fafc") +
              "; border-radius: 0.5rem; padding: 0.75rem; display: flex; gap: 1rem; align-items: center; border-left: " +
              (isTop ? "4px solid #10b981" : "4px solid transparent") + ";"}
          >
            <span style="flex: 1; font-weight: 500; color: #0f172a;">
              {feature}
            </span>
            <div style="display: flex; align-items: center; gap: 1rem;">
              <span style="
                  background: #dbeafe;
                  color: #1e40af;
                  padding: 0.25rem 0.75rem;
                  border-radius: 1rem;
                  font-size: 0.85rem;
                  font-weight: 600;
                  font-family: monospace;
                  min-width: 60px;
                  text-align: center;
                ">
                {String(count)}
              </span>
              <span style="
                  color: #64748b;
                  font-size: 0.875rem;
                  min-width: 50px;
                  text-align: right;
                ">
                {String(percent)}%
              </span>
            </div>
          </div>,
        );
      }

      const cohortElements = [];
      for (let i = 0; i < cohortEntries.length; i++) {
        const [cohort, count] = cohortEntries[i];
        const percent = data.total > 0
          ? Math.round((count / data.total) * 100)
          : 0;
        const isTop = cohort === data.topCohort.name;

        cohortElements.push(
          <div
            style={"background: " + (isTop ? "#fef3c7" : "#f8fafc") +
              "; border-radius: 0.5rem; padding: 0.75rem; display: flex; gap: 1rem; align-items: center; border-left: " +
              (isTop ? "4px solid #f59e0b" : "4px solid transparent") + ";"}
          >
            <span style="flex: 1; font-weight: 500; color: #0f172a;">
              {cohort}
            </span>
            <div style="display: flex; align-items: center; gap: 1rem;">
              <span style="
                  background: #fee2e2;
                  color: #991b1b;
                  padding: 0.25rem 0.75rem;
                  border-radius: 1rem;
                  font-size: 0.85rem;
                  font-weight: 600;
                  font-family: monospace;
                  min-width: 60px;
                  text-align: center;
                ">
                {String(count)}
              </span>
              <span style="
                  color: #64748b;
                  font-size: 0.875rem;
                  min-width: 50px;
                  text-align: right;
                ">
                {String(percent)}%
              </span>
            </div>
          </div>,
        );
      }

      return (
        <div style="display: flex; flex-direction: column; gap: 1.5rem;">
          <div>
            <h3 style="
                margin: 0 0 0.75rem 0;
                font-size: 1rem;
                color: #0f172a;
                font-weight: 600;
              ">
              Features by Usage
            </h3>
            <div style="
                display: flex;
                flex-direction: column;
                gap: 0.5rem;
              ">
              {featureElements}
            </div>
          </div>

          <div>
            <h3 style="
                margin: 0 0 0.75rem 0;
                font-size: 1rem;
                color: #0f172a;
                font-weight: 600;
              ">
              Cohorts by Usage
            </h3>
            <div style="
                display: flex;
                flex-direction: column;
                gap: 0.5rem;
              ">
              {cohortElements}
            </div>
          </div>
        </div>
      );
    })(metricsData);

    return {
      [NAME]: name,
      [UI]: (
        <div style="
            display: flex;
            flex-direction: column;
            gap: 1.5rem;
            max-width: 50rem;
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
                  Feature Usage Analytics
                </span>
                <h2 style="
                    margin: 0;
                    font-size: 1.3rem;
                    color: #0f172a;
                  ">
                  Track feature usage across cohorts
                </h2>
              </div>

              <div style="
                  background: linear-gradient(135deg, #f0f9ff, #dbeafe);
                  border-radius: 0.75rem;
                  padding: 1.5rem;
                ">
                <div style="
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    margin-bottom: 1rem;
                    flex-wrap: wrap;
                    gap: 1rem;
                  ">
                  <div>
                    <div style="
                        font-size: 0.875rem;
                        color: #0369a1;
                        font-weight: 500;
                        text-transform: uppercase;
                        letter-spacing: 0.05em;
                      ">
                      Total Events
                    </div>
                    <div style="
                        font-size: 2.5rem;
                        font-weight: 700;
                        color: #075985;
                        font-family: monospace;
                      ">
                      {totalCount}
                    </div>
                  </div>
                  <div style="
                      display: flex;
                      flex-direction: column;
                      gap: 0.5rem;
                      font-size: 0.875rem;
                    ">
                    <div style="
                        background: #ecfdf5;
                        color: #065f46;
                        padding: 0.5rem 1rem;
                        border-radius: 0.5rem;
                        font-weight: 500;
                      ">
                      Top Feature: <strong>{topFeature.name}</strong> ({String(
                        topFeature.count,
                      )})
                    </div>
                    <div style="
                        background: #fef3c7;
                        color: #78350f;
                        padding: 0.5rem 1rem;
                        border-radius: 0.5rem;
                        font-weight: 500;
                      ">
                      Top Cohort: <strong>{topCohort.name}</strong> ({String(
                        topCohort.count,
                      )})
                    </div>
                  </div>
                </div>

                <div style="
                    background: white;
                    border-radius: 0.5rem;
                    padding: 1rem;
                    display: flex;
                    gap: 0.75rem;
                    align-items: flex-end;
                  ">
                  <div style="flex: 1; display: flex; flex-direction: column; gap: 0.4rem;">
                    <label style="font-size: 0.875rem; font-weight: 500; color: #334155;">
                      Feature Name
                    </label>
                    <ct-input
                      type="text"
                      $value={featureField}
                      placeholder="e.g., export-pdf"
                      style="width: 100%;"
                      aria-label="Feature name"
                    />
                  </div>
                  <div style="flex: 1; display: flex; flex-direction: column; gap: 0.4rem;">
                    <label style="font-size: 0.875rem; font-weight: 500; color: #334155;">
                      Cohort
                    </label>
                    <ct-input
                      type="text"
                      $value={cohortField}
                      placeholder="e.g., enterprise"
                      style="width: 100%;"
                      aria-label="Cohort name"
                    />
                  </div>
                  <ct-button onClick={trackHandler} aria-label="Track Usage">
                    Track Usage
                  </ct-button>
                </div>
              </div>

              {metricsDisplay}

              <div style="
                  background: #f8fafc;
                  border-radius: 0.5rem;
                  padding: 1rem;
                  font-size: 0.85rem;
                  color: #475569;
                  line-height: 1.5;
                ">
                <strong>Pattern:</strong>{" "}
                Track feature usage across different user cohorts. The system
                aggregates events by feature and cohort, automatically computing
                totals, percentages, and identifying top performers. Use the
                form above to record usage events - leave fields empty for
                defaults.
              </div>
            </div>
          </ct-card>
        </div>
      ),
      events,
      usageBuckets,
      metricsData,
      totalCount,
      topFeature,
      topCohort,
    };
  },
);

export default featureUsageAnalyticsUx;
