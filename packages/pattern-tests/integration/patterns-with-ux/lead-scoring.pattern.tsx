/// <cts-enable />
// @ts-nocheck
import {
  type Cell,
  Default,
  h,
  handler,
  lift,
  NAME,
  recipe,
  str,
  UI,
} from "commontools";

interface LeadInput {
  id?: string;
  name?: string;
  base?: number;
  signals?: Record<string, number>;
}

interface SignalWeightInput {
  signal?: string;
  label?: string;
  weight?: number;
}

const defaultSignalWeights: SignalWeightInput[] = [
  { signal: "engagement", label: "Engagement", weight: 2 },
  { signal: "fit", label: "Product Fit", weight: 3 },
  { signal: "timing", label: "Timing", weight: 1 },
];

interface LeadScoringArgs {
  leads: Default<LeadInput[], []>;
  signalWeights: Default<
    SignalWeightInput[],
    typeof defaultSignalWeights
  >;
  defaultWeight: Default<number, 1>;
}

interface LeadState {
  id: string;
  name: string;
  base: number;
  signals: Record<string, number>;
}

interface SignalWeightState {
  signal: string;
  label: string;
  weight: number;
}

interface LeadSignalBreakdown {
  signal: string;
  label: string;
  count: number;
  weight: number;
  contribution: number;
}

interface LeadScoreSummary extends LeadState {
  score: number;
  signalBreakdown: LeadSignalBreakdown[];
}

interface SignalAggregate {
  signal: string;
  label: string;
  totalCount: number;
  weightedTotal: number;
}

interface SignalMutationEvent {
  leadId?: string;
  signal?: string;
  delta?: number;
  set?: number;
  weight?: number;
  label?: string;
}

const roundTwo = (value: number): number => {
  return Math.round(value * 100) / 100;
};

const sanitizeLabel = (value: unknown, fallback: string): string => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }
  return fallback;
};

const slugify = (value: string, fallback: string): string => {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : fallback;
};

const normalizeName = (value: unknown, fallback: string): string => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }
  return fallback;
};

const ensureUniqueId = (
  id: string,
  used: Set<string>,
  fallback: string,
): string => {
  let candidate = id.length > 0 ? id : fallback;
  let suffix = 2;
  while (used.has(candidate)) {
    candidate = `${id}-${suffix}`;
    suffix++;
  }
  used.add(candidate);
  return candidate;
};

const buildSignalLabel = (value: string): string => {
  return value.split("-").map((part) => {
    const head = part.charAt(0).toUpperCase();
    return `${head}${part.slice(1)}`;
  }).join(" ");
};

const sanitizeSignalKey = (value: unknown, fallback: string): string => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      return slugify(trimmed, fallback);
    }
  }
  return fallback;
};

const sanitizeWeightValue = (value: unknown, fallback: number): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return roundTwo(Math.max(fallback, 0));
  }
  return roundTwo(Math.max(value, 0));
};

const sanitizeCountValue = (value: unknown, fallback: number): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return roundTwo(Math.max(fallback, 0));
  }
  return roundTwo(Math.max(value, 0));
};

const sanitizeDeltaValue = (value: unknown, fallback: number): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return roundTwo(fallback);
  }
  return roundTwo(value);
};

const sanitizeSignalRecord = (
  input: Record<string, number> | undefined,
): Record<string, number> => {
  if (!input) return {};
  const sanitized: Record<string, number> = {};
  for (const [rawKey, rawValue] of Object.entries(input)) {
    const fallbackKey = rawKey.length > 0
      ? slugify(rawKey, "signal")
      : "signal";
    const signal = sanitizeSignalKey(rawKey, fallbackKey);
    if (signal.length === 0) continue;
    const value = sanitizeCountValue(rawValue, 0);
    if (value <= 0) continue;
    sanitized[signal] = value;
  }
  const sortedKeys = Object.keys(sanitized).sort();
  const result: Record<string, number> = {};
  for (const key of sortedKeys) {
    result[key] = sanitizeCountValue(sanitized[key], 0);
  }
  return result;
};

const sanitizeLeadList = (
  input: readonly LeadInput[] | undefined,
): LeadState[] => {
  if (!Array.isArray(input)) return [];
  const sanitized: LeadState[] = [];
  const used = new Set<string>();
  for (let index = 0; index < input.length; index++) {
    const raw = input[index];
    const fallbackName = `Lead ${index + 1}`;
    const name = normalizeName(raw?.name, fallbackName);
    const fallbackId = slugify(fallbackName, `lead-${index + 1}`);
    const idSource = typeof raw?.id === "string" && raw.id.length > 0
      ? raw.id
      : name;
    const id = ensureUniqueId(
      slugify(idSource, fallbackId),
      used,
      fallbackId,
    );
    const base = sanitizeCountValue(raw?.base, 0);
    sanitized.push({
      id,
      name,
      base,
      signals: sanitizeSignalRecord(raw?.signals),
    });
  }
  sanitized.sort((left, right) => left.name.localeCompare(right.name));
  return sanitized;
};

const sanitizeSignalWeights = (
  input: readonly SignalWeightInput[] | undefined,
  fallbackWeight: number,
): SignalWeightState[] => {
  const source = Array.isArray(input) && input.length > 0
    ? input
    : defaultSignalWeights;
  const sanitized: SignalWeightState[] = [];
  const used = new Set<string>();
  for (let index = 0; index < source.length; index++) {
    const raw = source[index];
    const fallbackSignal = `signal-${index + 1}`;
    const candidate = raw?.signal ?? raw?.label ?? fallbackSignal;
    const signal = sanitizeSignalKey(candidate, fallbackSignal);
    if (signal.length === 0 || used.has(signal)) continue;
    used.add(signal);
    const label = sanitizeLabel(
      raw?.label,
      buildSignalLabel(signal),
    );
    const weight = sanitizeWeightValue(raw?.weight, fallbackWeight);
    sanitized.push({ signal, label, weight });
  }
  if (sanitized.length === 0) {
    return sanitizeSignalWeights(defaultSignalWeights, fallbackWeight);
  }
  sanitized.sort((left, right) => left.label.localeCompare(right.label));
  return sanitized;
};

const computeWeightRecord = (
  weights: readonly SignalWeightState[],
): Record<string, SignalWeightState> => {
  const record: Record<string, SignalWeightState> = {};
  for (const entry of weights) {
    record[entry.signal] = entry;
  }
  return record;
};

const computeLeadSummaries = (
  leads: readonly LeadState[],
  weights: Record<string, SignalWeightState>,
  fallbackWeight: number,
): LeadScoreSummary[] => {
  const known = new Set<string>();
  for (const entry of Object.keys(weights)) {
    known.add(entry);
  }
  for (const lead of leads) {
    for (const key of Object.keys(lead.signals)) {
      known.add(key);
    }
  }
  const orderedSignals = Array.from(known.values()).sort();
  const summaries: LeadScoreSummary[] = [];
  const sanitizedFallback = sanitizeWeightValue(fallbackWeight, 1);
  for (const lead of leads) {
    const breakdown: LeadSignalBreakdown[] = [];
    let score = sanitizeCountValue(lead.base, 0);
    for (const key of orderedSignals) {
      const count = sanitizeCountValue(lead.signals[key], 0);
      if (count <= 0) continue;
      const match = weights[key];
      const weight = match
        ? sanitizeWeightValue(match.weight, sanitizedFallback)
        : sanitizedFallback;
      const label = match
        ? sanitizeLabel(match.label, buildSignalLabel(key))
        : buildSignalLabel(key);
      const contribution = roundTwo(count * weight);
      breakdown.push({ signal: key, label, count, weight, contribution });
      score = roundTwo(score + contribution);
    }
    summaries.push({
      id: lead.id,
      name: lead.name,
      base: sanitizeCountValue(lead.base, 0),
      signals: { ...lead.signals },
      score,
      signalBreakdown: breakdown,
    });
  }
  summaries.sort((left, right) => {
    const delta = roundTwo(right.score - left.score);
    if (Math.abs(delta) > 0.001) return delta > 0 ? 1 : -1;
    return left.name.localeCompare(right.name);
  });
  return summaries;
};

const aggregateSignalTotals = (
  summaries: readonly LeadScoreSummary[],
): SignalAggregate[] => {
  const totals = new Map<string, SignalAggregate>();
  for (const summary of summaries) {
    for (const entry of summary.signalBreakdown) {
      const existing = totals.get(entry.signal);
      if (existing) {
        existing.totalCount = roundTwo(existing.totalCount + entry.count);
        existing.weightedTotal = roundTwo(
          existing.weightedTotal + entry.contribution,
        );
      } else {
        totals.set(entry.signal, {
          signal: entry.signal,
          label: entry.label,
          totalCount: entry.count,
          weightedTotal: entry.contribution,
        });
      }
    }
  }
  const list = Array.from(totals.values());
  list.sort((left, right) => left.label.localeCompare(right.label));
  return list;
};

const formatDecimal = (value: number): string => {
  return roundTwo(value).toFixed(2);
};

const applySignalMutation = handler(
  (
    event: SignalMutationEvent | undefined,
    context: {
      leads: Cell<LeadInput[]>;
      weights: Cell<SignalWeightInput[]>;
      defaultWeight: Cell<number>;
    },
  ) => {
    const fallbackWeight = sanitizeWeightValue(
      context.defaultWeight.get(),
      1,
    );
    const leads = sanitizeLeadList(context.leads.get());
    const weights = sanitizeSignalWeights(
      context.weights.get(),
      fallbackWeight,
    );

    const signalFallback = `signal-${weights.length + 1}`;
    const signalKey = sanitizeSignalKey(
      event?.signal,
      signalFallback,
    );
    if (signalKey.length === 0) {
      return;
    }

    const leadId = sanitizeSignalKey(event?.leadId, "");
    const targetIndex = leadId.length > 0
      ? leads.findIndex((lead) => lead.id === leadId)
      : -1;
    if (targetIndex < 0) {
      return;
    }

    const delta = sanitizeDeltaValue(event?.delta, 0);
    const hasOverride = typeof event?.set === "number" &&
      Number.isFinite(event.set);
    const override = hasOverride
      ? sanitizeCountValue(event?.set, 0)
      : undefined;
    const proposedWeight = typeof event?.weight === "number"
      ? sanitizeWeightValue(event.weight, fallbackWeight)
      : undefined;
    const hasLabelOverride = typeof event?.label === "string" &&
      event.label.trim().length > 0;
    const overrideLabel = hasLabelOverride
      ? sanitizeLabel(event?.label, buildSignalLabel(signalKey))
      : undefined;

    const nextLeads = leads.map((lead) => ({
      id: lead.id,
      name: lead.name,
      base: lead.base,
      signals: { ...lead.signals },
    }));
    const target = nextLeads[targetIndex];
    const currentCount = sanitizeCountValue(target.signals[signalKey], 0);
    let nextCount = currentCount;
    if (override !== undefined) {
      nextCount = override;
    } else if (delta !== 0) {
      nextCount = sanitizeCountValue(currentCount + delta, currentCount);
    }
    const sanitizedNext = sanitizeCountValue(nextCount, 0);
    let leadChanged = false;
    if (sanitizedNext <= 0) {
      if (signalKey in target.signals) {
        delete target.signals[signalKey];
        leadChanged = true;
      }
    } else if (Math.abs(sanitizedNext - currentCount) > 0.001) {
      target.signals[signalKey] = sanitizedNext;
      leadChanged = true;
    }

    const nextWeights = weights.map((entry) => ({ ...entry }));
    const weightIndex = nextWeights.findIndex((entry) =>
      entry.signal === signalKey
    );
    let weightsChanged = false;
    const resolvedWeight = proposedWeight ??
      nextWeights[weightIndex]?.weight ??
      fallbackWeight;
    if (weightIndex >= 0) {
      const existing = nextWeights[weightIndex];
      const nextWeight = sanitizeWeightValue(resolvedWeight, fallbackWeight);
      const nextLabel = hasLabelOverride
        ? overrideLabel ?? existing.label
        : existing.label;
      if (
        Math.abs(nextWeight - existing.weight) > 0.001 ||
        nextLabel !== existing.label
      ) {
        nextWeights[weightIndex] = {
          signal: signalKey,
          label: nextLabel,
          weight: nextWeight,
        };
        weightsChanged = true;
      }
    } else {
      nextWeights.push({
        signal: signalKey,
        label: overrideLabel ?? buildSignalLabel(signalKey),
        weight: sanitizeWeightValue(resolvedWeight, fallbackWeight),
      });
      weightsChanged = true;
    }

    if (!leadChanged && !weightsChanged) {
      return;
    }

    const leadPayload = nextLeads.map((lead) => ({
      id: lead.id,
      name: lead.name,
      base: lead.base,
      signals: { ...lead.signals },
    }));
    context.leads.set(leadPayload);

    nextWeights.sort((left, right) => left.label.localeCompare(right.label));
    context.weights.set(nextWeights.map((entry) => ({
      signal: entry.signal,
      label: entry.label,
      weight: entry.weight,
    })));
  },
);

export const leadScoringUx = recipe<LeadScoringArgs>(
  "Lead Scoring (UX)",
  ({ leads, signalWeights, defaultWeight }) => {
    const sanitizedDefaultWeight = lift((value: number | undefined) =>
      sanitizeWeightValue(value, 1)
    )(defaultWeight);

    const sanitizedLeads = lift((value: LeadInput[] | undefined) =>
      sanitizeLeadList(value)
    )(leads);

    const sanitizedWeights = lift((
      input: {
        weights: SignalWeightInput[] | undefined;
        fallback: number;
      },
    ) => sanitizeSignalWeights(input.weights, input.fallback))({
      weights: signalWeights,
      fallback: sanitizedDefaultWeight,
    });

    const weightRecord = lift(
      (list: SignalWeightState[] | undefined) =>
        computeWeightRecord(Array.isArray(list) ? list : []),
    )(sanitizedWeights);

    const leadSummaries = lift((
      input: {
        leads: LeadState[] | undefined;
        weightMap: Record<string, SignalWeightState>;
        fallback: number;
      },
    ) => {
      const leadList = Array.isArray(input.leads) ? input.leads : [];
      return computeLeadSummaries(
        leadList,
        input.weightMap,
        input.fallback,
      );
    })({
      leads: sanitizedLeads,
      weightMap: weightRecord,
      fallback: sanitizedDefaultWeight,
    });

    const signalSummary = lift((list: LeadScoreSummary[] | undefined) =>
      aggregateSignalTotals(Array.isArray(list) ? list : [])
    )(leadSummaries);

    const totalScore = lift((list: LeadScoreSummary[] | undefined) => {
      let total = 0;
      for (const entry of list ?? []) {
        total = roundTwo(total + entry.score);
      }
      return total;
    })(leadSummaries);

    const leadCount = lift((list: LeadScoreSummary[] | undefined) =>
      Array.isArray(list) ? list.length : 0
    )(leadSummaries);

    const signalCount = lift((list: SignalAggregate[] | undefined) =>
      Array.isArray(list) ? list.length : 0
    )(signalSummary);

    const topLeadName = lift(
      (list: LeadScoreSummary[] | undefined) =>
        (list && list.length > 0) ? list[0].name : "none",
    )(leadSummaries);

    const topLeadScore = lift(
      (list: LeadScoreSummary[] | undefined) =>
        (list && list.length > 0) ? list[0].score : 0,
    )(leadSummaries);

    const name = str`Lead Scoring: ${leadCount} leads`;

    const applySignal = applySignalMutation({
      leads,
      weights: signalWeights,
      defaultWeight: sanitizedDefaultWeight,
    });

    const getRankBadge = (index: number): string => {
      if (index === 0) return "🥇";
      if (index === 1) return "🥈";
      if (index === 2) return "🥉";
      return `#${index + 1}`;
    };

    const getScoreColor = (score: number): string => {
      if (score >= 50) return "#10b981";
      if (score >= 30) return "#f59e0b";
      if (score >= 10) return "#ef4444";
      return "#64748b";
    };

    return {
      [NAME]: name,
      [UI]: (
        <div style="
            display: flex;
            flex-direction: column;
            gap: 1rem;
            max-width: 100%;
            padding: 0.5rem;
          ">
          <ct-card>
            <div
              slot="content"
              style="
                display: flex;
                flex-direction: column;
                gap: 1rem;
              "
            >
              <div style="
                  display: flex;
                  flex-direction: column;
                  gap: 0.25rem;
                ">
                <span style="
                    color: #64748b;
                    font-size: 0.7rem;
                    letter-spacing: 0.08em;
                    text-transform: uppercase;
                    font-weight: 600;
                  ">
                  Sales Intelligence
                </span>
                <h2 style="
                    margin: 0;
                    font-size: 1.4rem;
                    color: #0f172a;
                    font-weight: 700;
                  ">
                  Lead Scoring Dashboard
                </h2>
              </div>

              <div style="
                  display: grid;
                  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
                  gap: 0.75rem;
                ">
                <div style="
                    background: linear-gradient(135deg, #dbeafe, #bfdbfe);
                    border-radius: 0.5rem;
                    padding: 0.75rem;
                    display: flex;
                    flex-direction: column;
                    gap: 0.25rem;
                  ">
                  <span style="
                      font-size: 0.7rem;
                      color: #1e40af;
                      font-weight: 600;
                      text-transform: uppercase;
                    ">
                    Total Leads
                  </span>
                  <span style="
                      font-size: 1.75rem;
                      font-weight: 700;
                      color: #1e3a8a;
                      font-family: monospace;
                    ">
                    {leadCount}
                  </span>
                </div>

                <div style="
                    background: linear-gradient(135deg, #d1fae5, #a7f3d0);
                    border-radius: 0.5rem;
                    padding: 0.75rem;
                    display: flex;
                    flex-direction: column;
                    gap: 0.25rem;
                  ">
                  <span style="
                      font-size: 0.7rem;
                      color: #047857;
                      font-weight: 600;
                      text-transform: uppercase;
                    ">
                    Total Score
                  </span>
                  <span style="
                      font-size: 1.75rem;
                      font-weight: 700;
                      color: #065f46;
                      font-family: monospace;
                    ">
                    {lift((v: number) => v.toFixed(1))(totalScore)}
                  </span>
                </div>

                <div style="
                    background: linear-gradient(135deg, #fef3c7, #fde68a);
                    border-radius: 0.5rem;
                    padding: 0.75rem;
                    display: flex;
                    flex-direction: column;
                    gap: 0.25rem;
                  ">
                  <span style="
                      font-size: 0.7rem;
                      color: #92400e;
                      font-weight: 600;
                      text-transform: uppercase;
                    ">
                    Signals
                  </span>
                  <span style="
                      font-size: 1.75rem;
                      font-weight: 700;
                      color: #78350f;
                      font-family: monospace;
                    ">
                    {signalCount}
                  </span>
                </div>
              </div>

              <div style="
                  display: flex;
                  flex-direction: column;
                  gap: 0.5rem;
                ">
                <h3 style="
                    margin: 0;
                    font-size: 0.875rem;
                    color: #475569;
                    font-weight: 600;
                    text-transform: uppercase;
                    letter-spacing: 0.05em;
                  ">
                  Signal Weights
                </h3>
                <div style="
                    display: flex;
                    flex-wrap: wrap;
                    gap: 0.5rem;
                  ">
                  {lift((weights: SignalWeightState[]) => {
                    return weights.map((w) => (
                      <div style="
                          background: #f1f5f9;
                          border: 1px solid #cbd5e1;
                          border-radius: 0.375rem;
                          padding: 0.4rem 0.6rem;
                          display: flex;
                          align-items: center;
                          gap: 0.4rem;
                          font-size: 0.8rem;
                        ">
                        <span style="
                            color: #475569;
                            font-weight: 500;
                          ">
                          {w.label}
                        </span>
                        <span style="
                            background: #e2e8f0;
                            color: #1e293b;
                            padding: 0.1rem 0.4rem;
                            border-radius: 0.25rem;
                            font-weight: 700;
                            font-family: monospace;
                            font-size: 0.75rem;
                          ">
                          ×{w.weight.toFixed(1)}
                        </span>
                      </div>
                    ));
                  })(sanitizedWeights)}
                </div>
              </div>

              <div style="
                  display: flex;
                  flex-direction: column;
                  gap: 0.5rem;
                ">
                <h3 style="
                    margin: 0;
                    font-size: 0.875rem;
                    color: #475569;
                    font-weight: 600;
                    text-transform: uppercase;
                    letter-spacing: 0.05em;
                  ">
                  Leaderboard
                </h3>
                <div style="
                    display: flex;
                    flex-direction: column;
                    gap: 0.5rem;
                  ">
                  {lift((summaries: LeadScoreSummary[]) => {
                    return summaries.map((lead, index) => {
                      const scoreColor = getScoreColor(lead.score);
                      const rank = getRankBadge(index);
                      return (
                        <div style="
                            background: white;
                            border: 2px solid #e2e8f0;
                            border-radius: 0.5rem;
                            padding: 0.75rem;
                            display: flex;
                            flex-direction: column;
                            gap: 0.5rem;
                          ">
                          <div style="
                              display: flex;
                              justify-content: space-between;
                              align-items: center;
                              gap: 0.5rem;
                            ">
                            <div style="
                                display: flex;
                                align-items: center;
                                gap: 0.5rem;
                                flex: 1;
                                min-width: 0;
                              ">
                              <span style="
                                  font-size: 1.25rem;
                                  line-height: 1;
                                ">
                                {rank}
                              </span>
                              <span style="
                                  font-weight: 600;
                                  color: #0f172a;
                                  font-size: 0.95rem;
                                  white-space: nowrap;
                                  overflow: hidden;
                                  text-overflow: ellipsis;
                                ">
                                {lead.name}
                              </span>
                            </div>
                            <span
                              style={"font-size: 1.25rem; font-weight: 700; font-family: monospace; color: " +
                                scoreColor + ";"}
                            >
                              {lead.score.toFixed(1)}
                            </span>
                          </div>
                          {lead.signalBreakdown.length > 0 && (
                            <div style="
                                display: flex;
                                flex-wrap: wrap;
                                gap: 0.375rem;
                              ">
                              {lead.signalBreakdown.map((signal) => (
                                <div style="
                                    background: #f8fafc;
                                    border: 1px solid #e2e8f0;
                                    border-radius: 0.25rem;
                                    padding: 0.25rem 0.5rem;
                                    font-size: 0.7rem;
                                    display: flex;
                                    align-items: center;
                                    gap: 0.25rem;
                                  ">
                                  <span style="color: #64748b;">
                                    {signal.label}:
                                  </span>
                                  <span style="
                                      font-weight: 600;
                                      color: #1e293b;
                                      font-family: monospace;
                                    ">
                                    {signal.count.toFixed(1)}
                                  </span>
                                  <span style="color: #94a3b8;">
                                    ×{signal.weight.toFixed(1)}
                                  </span>
                                  <span style="
                                      color: #3b82f6;
                                      font-weight: 700;
                                      font-family: monospace;
                                    ">
                                    = {signal.contribution.toFixed(1)}
                                  </span>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    });
                  })(leadSummaries)}
                </div>
              </div>

              <div style="
                  background: #f8fafc;
                  border-radius: 0.5rem;
                  padding: 0.75rem;
                  font-size: 0.8rem;
                  color: #475569;
                  line-height: 1.5;
                ">
                <strong>Pattern:</strong>{" "}
                Lead scoring aggregates multiple behavioral signals (engagement,
                product fit, timing) with configurable weights to prioritize
                sales opportunities. Each lead's total score is computed from
                signal counts multiplied by their respective weights, enabling
                data-driven prioritization of the sales pipeline.
              </div>
            </div>
          </ct-card>
        </div>
      ),
      leaderboard: leadSummaries,
      totalScore,
      topLead: topLeadName,
      topScore: topLeadScore,
      controls: {
        applySignal,
      },
    };
  },
);

export default leadScoringUx;
