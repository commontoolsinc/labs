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

type RiskTier = "low" | "medium" | "high";

interface VendorResponseInput {
  topic?: string;
  rating?: number;
  weight?: number;
}

interface VendorInput {
  id?: string;
  name?: string;
  category?: string;
  responses?: VendorResponseInput[];
}

interface ResponseRecord {
  topic: string;
  rating: number;
  weight: number;
}

interface VendorRecord {
  id: string;
  name: string;
  category: string;
  responses: ResponseRecord[];
}

interface ThresholdState {
  medium: number;
  high: number;
}

interface ResponseBreakdown extends ResponseRecord {
  contribution: number;
}

interface VendorRiskSummary {
  id: string;
  name: string;
  category: string;
  total: number;
  tier: RiskTier;
  breakdown: ResponseBreakdown[];
}

interface TierCounts {
  high: number;
  medium: number;
  low: number;
}

interface TierEntry {
  tier: RiskTier;
  vendors: {
    id: string;
    name: string;
    score: number;
  }[];
}

interface ResponseAdjustmentEvent {
  vendorId?: string;
  topic?: string;
  rating?: number;
  weight?: number;
  category?: string;
  name?: string;
}

interface VendorRiskAssessmentArgs {
  vendors: Default<VendorInput[], typeof defaultVendors>;
}

const baselineThresholds: ThresholdState = {
  medium: 50,
  high: 80,
};

const defaultVendors: VendorRecord[] = [
  {
    id: "vendor-apex-cloud",
    name: "Apex Cloud",
    category: "Infrastructure",
    responses: [
      { topic: "compliance", rating: 15, weight: 1 },
      { topic: "financial", rating: 12, weight: 1 },
      { topic: "security", rating: 30, weight: 2 },
    ],
  },
  {
    id: "vendor-data-harbor",
    name: "Data Harbor",
    category: "Analytics",
    responses: [
      { topic: "compliance", rating: 22, weight: 1 },
      { topic: "financial", rating: 10, weight: 1 },
      { topic: "security", rating: 18, weight: 1 },
    ],
  },
  {
    id: "vendor-orbita-supplies",
    name: "Orbita Supplies",
    category: "Hardware",
    responses: [
      { topic: "compliance", rating: 8, weight: 1 },
      { topic: "financial", rating: 6, weight: 1 },
      { topic: "security", rating: 10, weight: 1 },
    ],
  },
];

const tierOrder: readonly RiskTier[] = ["high", "medium", "low"];

const tierWeight: Record<RiskTier, number> = {
  high: 0,
  medium: 1,
  low: 2,
};

const roundOne = (value: number): number => Math.round(value * 10) / 10;

const slugify = (value: string): string =>
  value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

const formatNumber = (value: number): string => {
  const rounded = roundOne(value);
  return Number.isInteger(rounded) ? `${rounded}` : rounded.toFixed(1);
};

const sanitizeVendorId = (value: unknown, fallback: string): string => {
  if (typeof value !== "string") {
    return fallback;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return fallback;
  }
  const slug = slugify(trimmed);
  return slug.length > 0 ? slug : fallback;
};

const sanitizeVendorName = (value: unknown, fallbackId: string): string => {
  if (typeof value !== "string") {
    return `Vendor ${fallbackId}`;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : `Vendor ${fallbackId}`;
};

const sanitizeCategory = (value: unknown): string => {
  if (typeof value !== "string") {
    return "General";
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : "General";
};

const sanitizeTopic = (value: unknown, fallback: string): string => {
  if (typeof value !== "string") {
    return fallback;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return fallback;
  }
  const slug = slugify(trimmed);
  return slug.length > 0 ? slug : fallback;
};

const sanitizeRating = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }
  const clamped = Math.min(Math.max(value, 0), 100);
  return roundOne(clamped);
};

const sanitizeWeight = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 1;
  }
  const clamped = Math.min(Math.max(value, 0.1), 5);
  return roundOne(clamped);
};

const cloneResponses = (
  responses: readonly ResponseRecord[],
): ResponseRecord[] => responses.map((response) => ({ ...response }));

const cloneDefaultVendors = (): VendorRecord[] =>
  defaultVendors.map((vendor) => ({
    id: vendor.id,
    name: vendor.name,
    category: vendor.category,
    responses: cloneResponses(vendor.responses),
  }));

const ensureUniqueId = (id: string, used: Set<string>): string => {
  let candidate = id;
  let suffix = 2;
  while (used.has(candidate)) {
    candidate = `${id}-${suffix}`;
    suffix += 1;
  }
  used.add(candidate);
  return candidate;
};

const ensureUniqueTopic = (
  topic: string,
  used: Set<string>,
): string => {
  let candidate = topic;
  let suffix = 2;
  while (used.has(candidate)) {
    candidate = `${topic}-${suffix}`;
    suffix += 1;
  }
  used.add(candidate);
  return candidate;
};

const sanitizeResponseList = (
  value: unknown,
  vendorId: string,
): ResponseRecord[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  const used = new Set<string>();
  const sanitized: ResponseRecord[] = [];
  let fallbackIndex = 1;
  for (const entry of value) {
    const raw = typeof entry === "object" && entry !== null
      ? entry as Record<string, unknown>
      : {};
    const fallbackTopic = `${vendorId}-topic-${fallbackIndex}`;
    fallbackIndex += 1;
    const topic = ensureUniqueTopic(
      sanitizeTopic(raw["topic"], fallbackTopic),
      used,
    );
    sanitized.push({
      topic,
      rating: sanitizeRating(raw["rating"]),
      weight: sanitizeWeight(raw["weight"]),
    });
  }
  sanitized.sort((left, right) => left.topic.localeCompare(right.topic));
  return sanitized;
};

const sanitizeVendorList = (value: unknown): VendorRecord[] => {
  const list = Array.isArray(value) ? value : cloneDefaultVendors();
  const sanitized: VendorRecord[] = [];
  const used = new Set<string>();
  let fallbackIndex = 1;
  for (const entry of list) {
    const raw = typeof entry === "object" && entry !== null
      ? entry as Record<string, unknown>
      : {};
    const fallbackId = `vendor-${fallbackIndex}`;
    fallbackIndex += 1;
    const id = ensureUniqueId(
      sanitizeVendorId(raw["id"], fallbackId),
      used,
    );
    const name = sanitizeVendorName(raw["name"], id);
    const category = sanitizeCategory(raw["category"]);
    const responses = sanitizeResponseList(raw["responses"], id);
    sanitized.push({ id, name, category, responses });
  }
  sanitized.sort((left, right) => {
    const nameCompare = left.name.localeCompare(right.name);
    if (nameCompare !== 0) {
      return nameCompare;
    }
    return left.id.localeCompare(right.id);
  });
  return sanitized;
};

const calculateRiskScore = (
  responses: readonly ResponseRecord[],
): number => {
  let total = 0;
  for (const response of responses) {
    total += response.rating * response.weight;
  }
  return roundOne(total);
};

const assignTier = (
  score: number,
  thresholds: ThresholdState,
): RiskTier => {
  if (score >= thresholds.high) {
    return "high";
  }
  if (score >= thresholds.medium) {
    return "medium";
  }
  return "low";
};

const buildBreakdown = (
  responses: readonly ResponseRecord[],
): ResponseBreakdown[] =>
  responses.map((response) => ({
    topic: response.topic,
    rating: response.rating,
    weight: response.weight,
    contribution: roundOne(response.rating * response.weight),
  }));

const buildSummaries = (
  vendors: readonly VendorRecord[],
  thresholds: ThresholdState,
): VendorRiskSummary[] => {
  const summaries: VendorRiskSummary[] = [];
  for (const vendor of vendors) {
    const breakdown = buildBreakdown(vendor.responses);
    const total = roundOne(
      breakdown.reduce((sum, item) => sum + item.contribution, 0),
    );
    const tier = assignTier(total, thresholds);
    summaries.push({
      id: vendor.id,
      name: vendor.name,
      category: vendor.category,
      total,
      tier,
      breakdown,
    });
  }
  summaries.sort((left, right) => {
    const tierDiff = tierWeight[left.tier] - tierWeight[right.tier];
    if (tierDiff !== 0) {
      return tierDiff;
    }
    if (right.total !== left.total) {
      return right.total - left.total;
    }
    return left.name.localeCompare(right.name);
  });
  return summaries;
};

const buildTierCounts = (
  summaries: readonly VendorRiskSummary[],
): TierCounts => {
  const counts: TierCounts = { high: 0, medium: 0, low: 0 };
  for (const summary of summaries) {
    counts[summary.tier] += 1;
  }
  return counts;
};

const buildTierBreakdown = (
  summaries: readonly VendorRiskSummary[],
): TierEntry[] =>
  tierOrder.map((tier) => ({
    tier,
    vendors: summaries
      .filter((summary) => summary.tier === tier)
      .map((summary) => ({
        id: summary.id,
        name: summary.name,
        score: summary.total,
      })),
  }));

const formatTopVendor = (
  summary: VendorRiskSummary | null,
): string => {
  if (!summary) {
    return "No vendors";
  }
  return `${summary.name} (${formatNumber(summary.total)})`;
};

const formatAuditMessage = (
  vendor: VendorRecord,
  topic: string,
  response: ResponseRecord,
): string => {
  const total = calculateRiskScore(vendor.responses);
  return `Adjusted ${topic} for ${vendor.id} to ${
    formatNumber(response.rating)
  } ` +
    `@ ${formatNumber(response.weight)} (total ${formatNumber(total)})`;
};

const readAuditLog = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  const entries: string[] = [];
  for (const item of value) {
    if (typeof item === "string") {
      entries.push(item);
    }
  }
  return entries;
};

const adjustVendorResponse = handler(
  (
    event: ResponseAdjustmentEvent | undefined,
    context: {
      vendors: Cell<VendorInput[]>;
      audit: Cell<string[]>;
    },
  ) => {
    const vendorId = sanitizeVendorId(event?.vendorId, "");
    if (vendorId.length === 0) {
      return;
    }
    const topic = sanitizeTopic(event?.topic, "");
    if (topic.length === 0) {
      return;
    }
    const rawSource = context.vendors as unknown as {
      getRaw?: () => unknown;
    };
    const currentValue = typeof rawSource.getRaw === "function"
      ? rawSource.getRaw()
      : context.vendors.get();
    const current = sanitizeVendorList(currentValue);
    let mutated = false;
    let trackedTopic: string | null = null;
    const updated = current.map((vendor) => {
      if (vendor.id !== vendorId) {
        return vendor;
      }
      const existingResponses = cloneResponses(vendor.responses);
      const index = existingResponses.findIndex((entry) =>
        entry.topic === topic
      );
      let responseChanged = false;
      if (index >= 0) {
        const currentResponse = existingResponses[index];
        const nextRating = event?.rating === undefined
          ? currentResponse.rating
          : sanitizeRating(event.rating);
        const nextWeight = event?.weight === undefined
          ? currentResponse.weight
          : sanitizeWeight(event.weight);
        if (
          nextRating !== currentResponse.rating ||
          nextWeight !== currentResponse.weight
        ) {
          existingResponses[index] = {
            topic,
            rating: nextRating,
            weight: nextWeight,
          };
          responseChanged = true;
        }
      } else {
        if (event?.rating === undefined && event?.weight === undefined) {
          return vendor;
        }
        existingResponses.push({
          topic,
          rating: sanitizeRating(event?.rating),
          weight: sanitizeWeight(event?.weight),
        });
        responseChanged = true;
      }
      const sanitizedResponses = sanitizeResponseList(
        existingResponses,
        vendor.id,
      );
      const nextCategory = event?.category === undefined
        ? vendor.category
        : sanitizeCategory(event.category);
      const nextName = event?.name === undefined
        ? vendor.name
        : sanitizeVendorName(event.name, vendor.id);
      if (
        !responseChanged &&
        nextCategory === vendor.category &&
        nextName === vendor.name
      ) {
        return vendor;
      }
      mutated = true;
      if (responseChanged) {
        trackedTopic = topic;
      }
      return {
        id: vendor.id,
        name: nextName,
        category: nextCategory,
        responses: sanitizedResponses,
      };
    });
    if (!mutated) {
      return;
    }
    const normalized = sanitizeVendorList(updated);
    context.vendors.set(normalized);
    if (!trackedTopic) {
      return;
    }
    const targetVendor = normalized.find((vendor) => vendor.id === vendorId);
    if (!targetVendor) {
      return;
    }
    const response = targetVendor.responses.find((entry) =>
      entry.topic === trackedTopic
    );
    if (!response) {
      return;
    }
    const currentLog = readAuditLog(context.audit.get());
    const nextLog = [
      ...currentLog,
      formatAuditMessage(
        targetVendor,
        trackedTopic,
        response,
      ),
    ].slice(-10);
    context.audit.set(nextLog);
  },
);

export const vendorRiskAssessment = recipe<VendorRiskAssessmentArgs>(
  "Vendor Risk Assessment",
  ({ vendors }) => {
    const auditLog = cell<string[]>([]);

    // UI form fields
    const vendorIdField = cell("");
    const topicField = cell("");
    const ratingField = cell("");
    const weightField = cell("");

    const vendorsView = lift(sanitizeVendorList)(vendors);
    const vendorRiskSummaries = lift((records: VendorRecord[]) =>
      buildSummaries(records, baselineThresholds)
    )(vendorsView);

    const tierCounts = lift(buildTierCounts)(vendorRiskSummaries);
    const tierBreakdown = lift(buildTierBreakdown)(vendorRiskSummaries);
    const highRiskCount = lift((counts: TierCounts) => counts.high)(
      tierCounts,
    );
    const mediumRiskCount = lift((counts: TierCounts) => counts.medium)(
      tierCounts,
    );
    const lowRiskCount = lift((counts: TierCounts) => counts.low)(
      tierCounts,
    );

    const riskOverview = lift((counts: TierCounts) =>
      `High: ${counts.high}, Medium: ${counts.medium}, Low: ${counts.low}`
    )(tierCounts);

    const highestRiskVendor = lift((summaries: VendorRiskSummary[]) =>
      summaries.length > 0 ? summaries[0] : null
    )(vendorRiskSummaries);

    const highestRiskLabel = lift(formatTopVendor)(highestRiskVendor);
    const auditTrail = lift((entries: string[]) => [...entries])(auditLog);

    // UI handler for adjusting vendor response
    const adjustResponseUI = handler(
      (
        _event: unknown,
        context: {
          vendors: Cell<VendorInput[]>;
          audit: Cell<string[]>;
          vendorIdField: Cell<string>;
          topicField: Cell<string>;
          ratingField: Cell<string>;
          weightField: Cell<string>;
        },
      ) => {
        const vendorId = context.vendorIdField.get();
        const topic = context.topicField.get();
        const ratingStr = context.ratingField.get();
        const weightStr = context.weightField.get();

        if (
          typeof vendorId !== "string" || vendorId.trim() === "" ||
          typeof topic !== "string" || topic.trim() === ""
        ) {
          return;
        }

        const rating = typeof ratingStr === "string" && ratingStr.trim() !== ""
          ? parseFloat(ratingStr)
          : undefined;
        const weight = typeof weightStr === "string" && weightStr.trim() !== ""
          ? parseFloat(weightStr)
          : undefined;

        const rawSource = context.vendors as unknown as {
          getRaw?: () => unknown;
        };
        const currentValue = typeof rawSource.getRaw === "function"
          ? rawSource.getRaw()
          : context.vendors.get();
        const current = sanitizeVendorList(currentValue);
        let mutated = false;
        let trackedTopic: string | null = null;
        const updated = current.map((vendor) => {
          if (vendor.id !== vendorId.trim()) {
            return vendor;
          }
          const existingResponses = cloneResponses(vendor.responses);
          const index = existingResponses.findIndex((entry) =>
            entry.topic === topic.trim()
          );
          let responseChanged = false;
          if (index >= 0) {
            const currentResponse = existingResponses[index];
            const nextRating = rating === undefined
              ? currentResponse.rating
              : sanitizeRating(rating);
            const nextWeight = weight === undefined
              ? currentResponse.weight
              : sanitizeWeight(weight);
            if (
              nextRating !== currentResponse.rating ||
              nextWeight !== currentResponse.weight
            ) {
              existingResponses[index] = {
                topic: topic.trim(),
                rating: nextRating,
                weight: nextWeight,
              };
              responseChanged = true;
            }
          } else {
            if (rating === undefined && weight === undefined) {
              return vendor;
            }
            existingResponses.push({
              topic: topic.trim(),
              rating: sanitizeRating(rating),
              weight: sanitizeWeight(weight),
            });
            responseChanged = true;
          }
          const sanitizedResponses = sanitizeResponseList(
            existingResponses,
            vendor.id,
          );
          if (responseChanged) {
            mutated = true;
            trackedTopic = topic.trim();
          }
          return {
            id: vendor.id,
            name: vendor.name,
            category: vendor.category,
            responses: sanitizedResponses,
          };
        });
        if (!mutated) {
          return;
        }
        const normalized = sanitizeVendorList(updated);
        context.vendors.set(normalized);
        if (!trackedTopic) {
          return;
        }
        const targetVendor = normalized.find((vendor) =>
          vendor.id === vendorId.trim()
        );
        if (!targetVendor) {
          return;
        }
        const response = targetVendor.responses.find((entry) =>
          entry.topic === trackedTopic
        );
        if (!response) {
          return;
        }
        const currentLog = readAuditLog(context.audit.get());
        const nextLog = [
          ...currentLog,
          formatAuditMessage(
            targetVendor,
            trackedTopic,
            response,
          ),
        ].slice(-10);
        context.audit.set(nextLog);

        // Clear form fields
        context.vendorIdField.set("");
        context.topicField.set("");
        context.ratingField.set("");
        context.weightField.set("");
      },
    );

    const name = lift(
      (counts: TierCounts) =>
        `Vendor Risk: ${counts.high} High, ${counts.medium} Med, ${counts.low} Low`,
    )(tierCounts);

    const vendorsSection = lift((summaries: VendorRiskSummary[]) => {
      if (summaries.length === 0) {
        return h(
          "div",
          {
            style:
              "padding: 2rem; text-align: center; color: #64748b; border: 2px dashed #e2e8f0; border-radius: 8px;",
          },
          "No vendors to assess",
        );
      }

      const vendorCards = [];
      for (const summary of summaries) {
        const tierColor = summary.tier === "high"
          ? "#ef4444"
          : summary.tier === "medium"
          ? "#f59e0b"
          : "#10b981";
        const tierBg = summary.tier === "high"
          ? "#fef2f2"
          : summary.tier === "medium"
          ? "#fffbeb"
          : "#f0fdf4";

        const breakdownItems = [];
        for (const item of summary.breakdown) {
          breakdownItems.push(
            h(
              "div",
              {
                style:
                  "display: flex; justify-content: space-between; padding: 0.5rem; background: #f8fafc; border-radius: 4px;",
              },
              h(
                "span",
                { style: "font-weight: 500; color: #475569;" },
                item.topic,
              ),
              h(
                "span",
                { style: "font-family: monospace; color: #64748b;" },
                formatNumber(item.rating) + " × " + formatNumber(item.weight) +
                  " = " + formatNumber(item.contribution),
              ),
            ),
          );
        }

        vendorCards.push(
          h(
            "div",
            {
              style: "background: white; border: 2px solid " + tierColor +
                "; border-radius: 8px; padding: 1rem; " +
                "box-shadow: 0 2px 4px rgba(0,0,0,0.05);",
            },
            h(
              "div",
              {
                style:
                  "display: flex; justify-content: space-between; margin-bottom: 0.75rem;",
              },
              h(
                "div",
                {},
                h(
                  "div",
                  {
                    style:
                      "font-size: 1.1rem; font-weight: 600; color: #1e293b;",
                  },
                  summary.name,
                ),
                h(
                  "div",
                  {
                    style:
                      "font-size: 0.875rem; color: #64748b; margin-top: 0.25rem;",
                  },
                  summary.category + " • " + summary.id,
                ),
              ),
              h(
                "div",
                { style: "text-align: right;" },
                h(
                  "div",
                  {
                    style: "font-size: 1.75rem; font-weight: 700; color: " +
                      tierColor + ";",
                  },
                  formatNumber(summary.total),
                ),
                h(
                  "div",
                  {
                    style:
                      "display: inline-block; padding: 0.25rem 0.75rem; background: " +
                      tierBg +
                      "; color: " + tierColor +
                      "; border-radius: 12px; font-size: 0.75rem; font-weight: 600; text-transform: uppercase; margin-top: 0.25rem;",
                  },
                  summary.tier + " RISK",
                ),
              ),
            ),
            h(
              "div",
              {
                style:
                  "margin-top: 0.75rem; padding-top: 0.75rem; border-top: 1px solid #e2e8f0;",
              },
              h(
                "div",
                {
                  style:
                    "font-size: 0.875rem; font-weight: 600; color: #475569; margin-bottom: 0.5rem;",
                },
                "Risk Breakdown",
              ),
              h(
                "div",
                {
                  style: "display: flex; flex-direction: column; gap: 0.5rem;",
                },
                ...breakdownItems,
              ),
            ),
          ),
        );
      }

      return h(
        "div",
        {
          style:
            "display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 1rem;",
        },
        ...vendorCards,
      );
    })(vendorRiskSummaries);

    const overviewSection = lift(
      (counts: TierCounts, highest: VendorRiskSummary | null) => {
        const totalVendors = counts.high + counts.medium + counts.low;
        const highestName = highest
          ? highest.name + " (" + formatNumber(highest.total) + ")"
          : "N/A";

        return h(
          "div",
          { style: "margin-bottom: 1.5rem;" },
          h(
            "div",
            {
              style:
                "background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 1.5rem; border-radius: 8px; margin-bottom: 1rem;",
            },
            h(
              "div",
              {
                style:
                  "font-size: 0.875rem; opacity: 0.9; margin-bottom: 0.5rem;",
              },
              "VENDOR RISK OVERVIEW",
            ),
            h(
              "div",
              {
                style:
                  "font-size: 2rem; font-weight: 700; margin-bottom: 0.25rem;",
              },
              String(totalVendors) + " Vendors",
            ),
            h(
              "div",
              { style: "font-size: 1rem; opacity: 0.9;" },
              "Highest Risk: " + highestName,
            ),
          ),
          h(
            "div",
            {
              style:
                "display: grid; grid-template-columns: repeat(3, 1fr); gap: 1rem;",
            },
            h(
              "div",
              {
                style:
                  "background: #fef2f2; border: 2px solid #ef4444; border-radius: 8px; padding: 1rem; text-align: center;",
              },
              h(
                "div",
                {
                  style:
                    "font-size: 2.5rem; font-weight: 700; color: #ef4444; margin-bottom: 0.25rem;",
                },
                String(counts.high),
              ),
              h(
                "div",
                {
                  style:
                    "font-size: 0.875rem; font-weight: 600; color: #dc2626; text-transform: uppercase;",
                },
                "High Risk",
              ),
            ),
            h(
              "div",
              {
                style:
                  "background: #fffbeb; border: 2px solid #f59e0b; border-radius: 8px; padding: 1rem; text-align: center;",
              },
              h(
                "div",
                {
                  style:
                    "font-size: 2.5rem; font-weight: 700; color: #f59e0b; margin-bottom: 0.25rem;",
                },
                String(counts.medium),
              ),
              h(
                "div",
                {
                  style:
                    "font-size: 0.875rem; font-weight: 600; color: #d97706; text-transform: uppercase;",
                },
                "Medium Risk",
              ),
            ),
            h(
              "div",
              {
                style:
                  "background: #f0fdf4; border: 2px solid #10b981; border-radius: 8px; padding: 1rem; text-align: center;",
              },
              h(
                "div",
                {
                  style:
                    "font-size: 2.5rem; font-weight: 700; color: #10b981; margin-bottom: 0.25rem;",
                },
                String(counts.low),
              ),
              h(
                "div",
                {
                  style:
                    "font-size: 0.875rem; font-weight: 600; color: #059669; text-transform: uppercase;",
                },
                "Low Risk",
              ),
            ),
          ),
        );
      },
    )(tierCounts, highestRiskVendor);

    const auditSection = lift((entries: string[]) => {
      if (entries.length === 0) {
        return h(
          "div",
          {
            style:
              "padding: 1rem; text-align: center; color: #64748b; background: #f8fafc; border-radius: 8px;",
          },
          "No audit trail entries yet",
        );
      }

      const items = [];
      const reversed = entries.slice().reverse();
      for (const entry of reversed) {
        items.push(
          h(
            "div",
            {
              style:
                "padding: 0.75rem; background: white; border-left: 3px solid #667eea; border-radius: 4px; font-size: 0.875rem; color: #475569;",
            },
            entry,
          ),
        );
      }

      return h(
        "div",
        { style: "display: flex; flex-direction: column; gap: 0.5rem;" },
        ...items,
      );
    })(auditTrail);

    const ui = (
      <div
        style={{
          maxWidth: "1200px",
          margin: "0 auto",
          padding: "1.5rem",
          fontFamily:
            "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
        }}
      >
        {overviewSection}

        <div style={{ marginBottom: "1.5rem" }}>
          <h3
            style={{
              fontSize: "1.25rem",
              fontWeight: "600",
              color: "#1e293b",
              marginBottom: "1rem",
            }}
          >
            Vendors by Risk Level
          </h3>
          {vendorsSection}
        </div>

        <div
          style={{
            background: "white",
            border: "1px solid #e2e8f0",
            borderRadius: "8px",
            padding: "1.5rem",
            marginBottom: "1.5rem",
          }}
        >
          <h3
            style={{
              fontSize: "1.25rem",
              fontWeight: "600",
              color: "#1e293b",
              marginBottom: "1rem",
            }}
          >
            Adjust Vendor Risk
          </h3>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(2, 1fr)",
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
                  color: "#475569",
                  marginBottom: "0.25rem",
                }}
              >
                Vendor ID
              </label>
              <ct-input
                $value={vendorIdField}
                placeholder="vendor-apex-cloud"
                style={{
                  width: "100%",
                  padding: "0.5rem",
                  border: "1px solid #cbd5e1",
                  borderRadius: "4px",
                }}
              />
            </div>
            <div>
              <label
                style={{
                  display: "block",
                  fontSize: "0.875rem",
                  fontWeight: "500",
                  color: "#475569",
                  marginBottom: "0.25rem",
                }}
              >
                Topic
              </label>
              <ct-input
                $value={topicField}
                placeholder="security"
                style={{
                  width: "100%",
                  padding: "0.5rem",
                  border: "1px solid #cbd5e1",
                  borderRadius: "4px",
                }}
              />
            </div>
            <div>
              <label
                style={{
                  display: "block",
                  fontSize: "0.875rem",
                  fontWeight: "500",
                  color: "#475569",
                  marginBottom: "0.25rem",
                }}
              >
                Rating (0-100)
              </label>
              <ct-input
                $value={ratingField}
                placeholder="25"
                style={{
                  width: "100%",
                  padding: "0.5rem",
                  border: "1px solid #cbd5e1",
                  borderRadius: "4px",
                }}
              />
            </div>
            <div>
              <label
                style={{
                  display: "block",
                  fontSize: "0.875rem",
                  fontWeight: "500",
                  color: "#475569",
                  marginBottom: "0.25rem",
                }}
              >
                Weight (0.1-5)
              </label>
              <ct-input
                $value={weightField}
                placeholder="2"
                style={{
                  width: "100%",
                  padding: "0.5rem",
                  border: "1px solid #cbd5e1",
                  borderRadius: "4px",
                }}
              />
            </div>
          </div>
          <ct-button
            onClick={adjustResponseUI({
              vendors,
              audit: auditLog,
              vendorIdField,
              topicField,
              ratingField,
              weightField,
            })}
            style={{
              padding: "0.75rem 1.5rem",
              background: "#667eea",
              color: "white",
              border: "none",
              borderRadius: "4px",
              fontWeight: "600",
              cursor: "pointer",
            }}
          >
            Update Risk Assessment
          </ct-button>
        </div>

        <div
          style={{
            background: "white",
            border: "1px solid #e2e8f0",
            borderRadius: "8px",
            padding: "1.5rem",
          }}
        >
          <h3
            style={{
              fontSize: "1.25rem",
              fontWeight: "600",
              color: "#1e293b",
              marginBottom: "1rem",
            }}
          >
            Audit Trail
          </h3>
          {auditSection}
        </div>
      </div>
    );

    return {
      [NAME]: name,
      [UI]: ui,
      vendors,
      vendorsView,
      vendorRiskSummaries,
      tierBreakdown,
      tierCounts,
      highRiskCount,
      mediumRiskCount,
      lowRiskCount,
      riskOverview,
      highestRiskVendor,
      highestRiskLabel,
      auditTrail,
      adjustResponse: adjustVendorResponse({
        vendors,
        audit: auditLog,
      }),
    };
  },
);

export type {
  ResponseAdjustmentEvent,
  TierCounts,
  TierEntry,
  VendorInput,
  VendorRecord,
  VendorResponseInput,
  VendorRiskAssessmentArgs,
  VendorRiskSummary,
};
export type { RiskTier };
