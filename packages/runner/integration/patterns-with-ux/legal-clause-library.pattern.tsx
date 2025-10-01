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

type ClauseStatus = "approved" | "draft" | "deprecated";
type RegionCode = "global" | "na" | "eu" | "apac";

interface ClauseInput {
  id?: string;
  title?: string;
  topic?: string;
  region?: string;
  status?: string;
  text?: string;
  lastReviewed?: string;
}

interface ClauseRecord {
  id: string;
  title: string;
  topicKey: string;
  topicLabel: string;
  region: RegionCode;
  status: ClauseStatus;
  text: string;
  excerpt: string;
  lastReviewed: string;
}

interface ClausePreview {
  id: string;
  title: string;
  topic: string;
  region: string;
  status: ClauseStatus;
  lastReviewed: string;
  excerpt: string;
}

interface TopicBreakdown {
  key: string;
  label: string;
  count: number;
}

interface TopicOption {
  key: string;
  label: string;
  count: number;
  active: boolean;
  regions: {
    region: RegionCode;
    label: string;
    count: number;
  }[];
}

interface RegionOption {
  key: RegionCode;
  label: string;
  count: number;
  active: boolean;
  topics: TopicBreakdown[];
}

interface StatusSummary {
  approved: number;
  draft: number;
  deprecated: number;
}

interface LegalClauseLibraryArgs {
  clauses: Default<ClauseInput[], typeof defaultClauses>;
}

interface SelectTopicEvent {
  topic?: string;
}

interface SelectRegionEvent {
  region?: string;
}

interface UpdateStatusEvent {
  id?: string;
  status?: string;
  reviewedOn?: string;
}

const regionLabels: Record<RegionCode, string> = {
  global: "Global",
  na: "North America",
  eu: "Europe",
  apac: "Asia Pacific",
};

const regionOrder: RegionCode[] = ["global", "na", "eu", "apac"];

const statusCatalog: ClauseStatus[] = [
  "approved",
  "draft",
  "deprecated",
];

const fallbackTopicKey = "compliance";

const defaultClauses: ClauseInput[] = [
  {
    id: "NDA Standard",
    title: "Standard NDA",
    topic: "Confidentiality",
    region: "NA",
    status: "approved",
    text: "Outlines confidentiality duties for mutual disclosures.",
    lastReviewed: "2023-09-12",
  },
  {
    id: "GDPR Data Addendum",
    title: "GDPR Data Addendum",
    topic: "DATA PROTECTION",
    region: "eu",
    status: "draft",
    text: "Captures controller-processor duties under EU GDPR.",
    lastReviewed: "2023-08-01",
  },
  {
    id: "CCPA Supplement",
    title: "California Privacy Supplement",
    topic: "data protection",
    region: "NA",
    status: "approved",
    text: "Extends privacy rights alignment for California residents.",
    lastReviewed: "2023-07-22",
  },
  {
    id: "Supplier Governance",
    title: "Supplier Governance Clause",
    topic: "Supplier Risk",
    region: "APAC",
    status: "deprecated",
    text: "Sets supplier reporting cadence and remediation timelines.",
    lastReviewed: "2023-05-10",
  },
];

const toSlug = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

const capitalizeWord = (value: string): string => {
  if (value.length === 0) return value;
  return value[0].toUpperCase() + value.slice(1);
};

const topicLabelFromKey = (key: string): string => {
  if (!key) return "General";
  return key
    .split("-")
    .filter((part) => part.length > 0)
    .map(capitalizeWord)
    .join(" ") || "General";
};

const sanitizeClauseId = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const slug = toSlug(value);
  return slug.length > 0 ? slug : null;
};

const sanitizeTitle = (value: unknown, id: string): string => {
  if (typeof value !== "string") {
    return topicLabelFromKey(id);
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : topicLabelFromKey(id);
};

const sanitizeTopicKey = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const slug = toSlug(value);
  return slug.length > 0 ? slug : null;
};

const sanitizeRegionKey = (value: unknown): RegionCode | null => {
  if (typeof value !== "string") return null;
  const slug = toSlug(value);
  if (slug.length === 0) return null;
  for (const code of regionOrder) {
    if (code === slug) return code;
    if (toSlug(regionLabels[code]) === slug) return code;
  }
  return null;
};

const sanitizeRegion = (value: unknown): RegionCode => {
  return sanitizeRegionKey(value) ?? "global";
};

const sanitizeStatus = (
  value: unknown,
  fallback: ClauseStatus,
): ClauseStatus => {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim().toLowerCase();
  for (const status of statusCatalog) {
    if (status === normalized) return status;
  }
  return fallback;
};

const parseStatus = (value: unknown): ClauseStatus | null => {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  for (const status of statusCatalog) {
    if (status === normalized) return status;
  }
  return null;
};

const sanitizeText = (value: unknown): string => {
  if (typeof value !== "string") return "Content pending review.";
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : "Content pending review.";
};

const sanitizeReviewDate = (value: unknown, fallback: string): string => {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? trimmed : fallback;
};

const buildExcerpt = (text: string): string => {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= 72) return normalized;
  return `${normalized.slice(0, 69)}...`;
};

const cloneClause = (entry: ClauseRecord): ClauseRecord => ({ ...entry });

const compareClauses = (left: ClauseRecord, right: ClauseRecord): number => {
  const topicCompare = left.topicLabel.localeCompare(right.topicLabel);
  if (topicCompare !== 0) return topicCompare;
  return left.title.localeCompare(right.title);
};

const sanitizeClause = (value: unknown): ClauseRecord | null => {
  if (typeof value !== "object" || value === null) return null;
  const input = value as ClauseInput;
  const id = sanitizeClauseId(input.id ?? input.title);
  if (!id) return null;
  const topicKey = sanitizeTopicKey(input.topic) ?? fallbackTopicKey;
  const topicLabel = topicLabelFromKey(topicKey);
  const region = sanitizeRegion(input.region);
  const status = sanitizeStatus(input.status, "draft");
  const text = sanitizeText(input.text);
  const lastReviewed = sanitizeReviewDate(
    input.lastReviewed,
    "2023-01-01",
  );
  return {
    id,
    title: sanitizeTitle(input.title, id),
    topicKey,
    topicLabel,
    region,
    status,
    text,
    excerpt: buildExcerpt(text),
    lastReviewed,
  };
};

const defaultClauseRecords: ClauseRecord[] = (() => {
  const dedup = new Map<string, ClauseRecord>();
  for (const entry of defaultClauses) {
    const clause = sanitizeClause(entry);
    if (!clause) continue;
    if (!dedup.has(clause.id)) {
      dedup.set(clause.id, clause);
    }
  }
  const list = Array.from(dedup.values());
  list.sort(compareClauses);
  return list;
})();

const cloneDefaultClauses = (): ClauseRecord[] =>
  defaultClauseRecords.map(cloneClause);

const sanitizeClauseList = (value: unknown): ClauseRecord[] => {
  if (!Array.isArray(value)) return cloneDefaultClauses();
  const dedup = new Map<string, ClauseRecord>();
  for (const raw of value) {
    const clause = sanitizeClause(raw);
    if (!clause) continue;
    if (!dedup.has(clause.id)) {
      dedup.set(clause.id, clause);
    }
  }
  if (dedup.size === 0) return cloneDefaultClauses();
  const list = Array.from(dedup.values());
  list.sort(compareClauses);
  return list.map(cloneClause);
};

const toClauseInputs = (entries: readonly ClauseRecord[]): ClauseInput[] =>
  entries.map((entry) => ({
    id: entry.id,
    title: entry.title,
    topic: entry.topicKey,
    region: entry.region,
    status: entry.status,
    text: entry.text,
    lastReviewed: entry.lastReviewed,
  }));

const buildTopicOptions = (
  clauses: readonly ClauseRecord[],
  activeKey: string | null,
): TopicOption[] => {
  const map = new Map<string, {
    label: string;
    count: number;
    regions: Map<RegionCode, number>;
  }>();
  for (const clause of clauses) {
    const bucket = map.get(clause.topicKey) ?? {
      label: clause.topicLabel,
      count: 0,
      regions: new Map<RegionCode, number>(),
    };
    bucket.count += 1;
    bucket.regions.set(
      clause.region,
      (bucket.regions.get(clause.region) ?? 0) + 1,
    );
    map.set(clause.topicKey, bucket);
  }
  const options: TopicOption[] = [];
  for (const [key, value] of map.entries()) {
    const regions = Array.from(value.regions.entries()).map((
      [region, count],
    ) => ({
      region,
      label: regionLabels[region],
      count,
    }));
    regions.sort((left, right) => left.label.localeCompare(right.label));
    options.push({
      key,
      label: value.label,
      count: value.count,
      active: activeKey === key,
      regions,
    });
  }
  options.sort((left, right) => left.label.localeCompare(right.label));
  return options;
};

const buildRegionOptions = (
  clauses: readonly ClauseRecord[],
  activeKey: RegionCode | null,
): RegionOption[] => {
  const buckets = new Map<RegionCode, {
    count: number;
    topics: Map<string, TopicBreakdown>;
  }>();
  for (const region of regionOrder) {
    buckets.set(region, { count: 0, topics: new Map() });
  }
  for (const clause of clauses) {
    const bucket = buckets.get(clause.region);
    if (!bucket) continue;
    bucket.count += 1;
    const topic = bucket.topics.get(clause.topicKey) ?? {
      key: clause.topicKey,
      label: clause.topicLabel,
      count: 0,
    };
    topic.count += 1;
    bucket.topics.set(clause.topicKey, topic);
  }
  const options: RegionOption[] = [];
  for (const region of regionOrder) {
    const bucket = buckets.get(region);
    if (!bucket) continue;
    const topics = Array.from(bucket.topics.values());
    topics.sort((left, right) => left.label.localeCompare(right.label));
    options.push({
      key: region,
      label: regionLabels[region],
      count: bucket.count,
      active: activeKey === region,
      topics,
    });
  }
  return options;
};

const resolveTopicLabel = (
  active: string | null,
  options: readonly TopicOption[],
): string => {
  if (!active) return "All Topics";
  const match = options.find((option) => option.key === active);
  return match ? match.label : "All Topics";
};

const resolveRegionLabel = (
  active: RegionCode | null,
  options: readonly RegionOption[],
): string => {
  if (!active) return "All Regions";
  const match = options.find((option) => option.key === active);
  return match ? match.label : "All Regions";
};

const buildFilteredClauses = (
  clauses: readonly ClauseRecord[],
  topic: string | null,
  region: RegionCode | null,
): ClausePreview[] => {
  const list: ClausePreview[] = [];
  for (const clause of clauses) {
    if (topic && clause.topicKey !== topic) continue;
    if (region && clause.region !== region) continue;
    list.push({
      id: clause.id,
      title: clause.title,
      topic: clause.topicLabel,
      region: regionLabels[clause.region],
      status: clause.status,
      lastReviewed: clause.lastReviewed,
      excerpt: clause.excerpt,
    });
  }
  return list;
};

const summarizeStatus = (clauses: readonly ClauseRecord[]): StatusSummary => {
  const summary: StatusSummary = { approved: 0, draft: 0, deprecated: 0 };
  for (const clause of clauses) {
    summary[clause.status] += 1;
  }
  return summary;
};

const buildSummaryLine = (input: {
  filtered: number;
  total: number;
  topic: string;
  region: string;
}): string => {
  return `Showing ${input.filtered} of ${input.total} clauses for ${input.topic} in ${input.region}`;
};

const selectTopic = handler(
  (
    event: SelectTopicEvent | undefined,
    context: {
      clauses: Cell<ClauseInput[]>;
      topicFilter: Cell<string | null>;
    },
  ) => {
    const available = sanitizeClauseList(context.clauses.get());
    if (available.length === 0) {
      context.topicFilter.set(null);
      return;
    }
    const requested = sanitizeTopicKey(event?.topic);
    if (!requested) {
      context.topicFilter.set(null);
      return;
    }
    for (const clause of available) {
      if (clause.topicKey === requested) {
        context.topicFilter.set(requested);
        return;
      }
    }
    context.topicFilter.set(null);
  },
);

const selectRegion = handler(
  (
    event: SelectRegionEvent | undefined,
    context: {
      regionFilter: Cell<RegionCode | null>;
    },
  ) => {
    const resolved = sanitizeRegionKey(event?.region);
    context.regionFilter.set(resolved);
  },
);

const clearFilters = handler(
  (
    _event: unknown,
    context: {
      topicFilter: Cell<string | null>;
      regionFilter: Cell<RegionCode | null>;
    },
  ) => {
    context.topicFilter.set(null);
    context.regionFilter.set(null);
  },
);

const updateClauseStatus = handler(
  (
    event: UpdateStatusEvent | undefined,
    context: { clauses: Cell<ClauseInput[]> },
  ) => {
    const id = sanitizeClauseId(event?.id);
    const status = parseStatus(event?.status);
    if (!id || !status) return;
    const current = sanitizeClauseList(context.clauses.get());
    let changed = false;
    const updated = current.map((clause) => {
      if (clause.id !== id) return clause;
      changed = true;
      const nextDate = sanitizeReviewDate(
        event?.reviewedOn,
        clause.lastReviewed,
      );
      return {
        ...clause,
        status,
        lastReviewed: nextDate,
      };
    });
    if (!changed) return;
    updated.sort(compareClauses);
    context.clauses.set(toClauseInputs(updated));
  },
);

export const legalClauseLibraryUx = recipe<LegalClauseLibraryArgs>(
  "Legal Clause Library",
  ({ clauses }) => {
    const topicFilter = cell<string | null>(null);
    const regionFilter = cell<RegionCode | null>(null);

    const clauseCatalog = lift(sanitizeClauseList)(clauses);

    const topicOptions = lift((input: {
      clauses: ClauseRecord[];
      active: string | null;
    }) => buildTopicOptions(input.clauses, input.active))({
      clauses: clauseCatalog,
      active: topicFilter,
    });

    const regionOptions = lift((input: {
      clauses: ClauseRecord[];
      active: RegionCode | null;
    }) => buildRegionOptions(input.clauses, input.active))({
      clauses: clauseCatalog,
      active: regionFilter,
    });

    const totalCount = lift((entries: ClauseRecord[]) => entries.length)(
      clauseCatalog,
    );

    const filteredClauses = lift((input: {
      clauses: ClauseRecord[];
      topic: string | null;
      region: RegionCode | null;
    }) => buildFilteredClauses(input.clauses, input.topic, input.region))({
      clauses: clauseCatalog,
      topic: topicFilter,
      region: regionFilter,
    });

    const filteredCount = lift((entries: ClausePreview[]) => entries.length)(
      filteredClauses,
    );

    const activeTopicLabel = lift((input: {
      active: string | null;
      options: TopicOption[];
    }) => resolveTopicLabel(input.active, input.options))({
      active: topicFilter,
      options: topicOptions,
    });

    const activeRegionLabel = lift((input: {
      active: RegionCode | null;
      options: RegionOption[];
    }) => resolveRegionLabel(input.active, input.options))({
      active: regionFilter,
      options: regionOptions,
    });

    const statusSummary = lift((entries: ClauseRecord[]) =>
      summarizeStatus(entries)
    )(clauseCatalog);

    const selectedTopic = lift((value: string | null) => value ?? "all")(
      topicFilter,
    );

    const selectedRegion = lift((value: RegionCode | null) => value ?? "all")(
      regionFilter,
    );

    const summaryLine = lift(buildSummaryLine)({
      filtered: filteredCount,
      total: totalCount,
      topic: activeTopicLabel,
      region: activeRegionLabel,
    });

    // UI-specific handlers
    const topicInputField = cell<string>("");
    const regionInputField = cell<string>("");
    const clauseIdField = cell<string>("");
    const statusField = cell<string>("");

    const applyTopicFilter = handler(
      (
        _event: unknown,
        context: {
          input: Cell<string>;
          clauses: Cell<ClauseInput[]>;
          topicFilter: Cell<string | null>;
        },
      ) => {
        const available = sanitizeClauseList(context.clauses.get());
        if (available.length === 0) {
          context.topicFilter.set(null);
          return;
        }
        const inputStr = context.input.get();
        const requested = sanitizeTopicKey(inputStr);
        if (!requested) {
          context.topicFilter.set(null);
          return;
        }
        for (const clause of available) {
          if (clause.topicKey === requested) {
            context.topicFilter.set(requested);
            return;
          }
        }
        context.topicFilter.set(null);
      },
    );

    const applyRegionFilter = handler(
      (
        _event: unknown,
        context: {
          input: Cell<string>;
          regionFilter: Cell<RegionCode | null>;
        },
      ) => {
        const inputStr = context.input.get();
        const resolved = sanitizeRegionKey(inputStr);
        context.regionFilter.set(resolved);
      },
    );

    const clearAllFilters = handler(
      (
        _event: unknown,
        context: {
          topicFilter: Cell<string | null>;
          regionFilter: Cell<RegionCode | null>;
          topicInput: Cell<string>;
          regionInput: Cell<string>;
        },
      ) => {
        context.topicFilter.set(null);
        context.regionFilter.set(null);
        context.topicInput.set("");
        context.regionInput.set("");
      },
    );

    const updateStatus = handler(
      (
        _event: unknown,
        context: {
          clauseId: Cell<string>;
          statusInput: Cell<string>;
          clauses: Cell<ClauseInput[]>;
        },
      ) => {
        const idStr = context.clauseId.get();
        const statusStr = context.statusInput.get();
        const id = sanitizeClauseId(idStr);
        const status = parseStatus(statusStr);
        if (!id || !status) return;
        const current = sanitizeClauseList(context.clauses.get());
        let changed = false;
        const today = new Date().toISOString().split("T")[0];
        const updated = current.map((clause) => {
          if (clause.id !== id) return clause;
          changed = true;
          return {
            ...clause,
            status,
            lastReviewed: today,
          };
        });
        if (!changed) return;
        updated.sort(compareClauses);
        context.clauses.set(toClauseInputs(updated));
        context.clauseId.set("");
        context.statusInput.set("");
      },
    );

    const name = lift(
      (summary: StatusSummary) =>
        `Legal Clauses: ${summary.approved} Approved, ${summary.draft} Draft`,
    )(statusSummary);

    const header = lift((summary: StatusSummary) => {
      return h(
        "div",
        {
          style:
            "background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 2rem; border-radius: 0.75rem; margin-bottom: 1.5rem;",
        },
        h(
          "h1",
          { style: "margin: 0 0 0.5rem 0; font-size: 2rem;" },
          "Legal Clause Library",
        ),
        h(
          "div",
          {
            style:
              "display: grid; grid-template-columns: repeat(3, 1fr); gap: 1rem; margin-top: 1rem;",
          },
          h(
            "div",
            { style: "text-align: center;" },
            h(
              "div",
              { style: "font-size: 2rem; font-weight: bold;" },
              String(summary.approved),
            ),
            h(
              "div",
              { style: "font-size: 0.875rem; opacity: 0.9;" },
              "Approved",
            ),
          ),
          h(
            "div",
            { style: "text-align: center;" },
            h(
              "div",
              { style: "font-size: 2rem; font-weight: bold;" },
              String(summary.draft),
            ),
            h("div", { style: "font-size: 0.875rem; opacity: 0.9;" }, "Draft"),
          ),
          h(
            "div",
            { style: "text-align: center;" },
            h(
              "div",
              { style: "font-size: 2rem; font-weight: bold;" },
              String(summary.deprecated),
            ),
            h(
              "div",
              { style: "font-size: 0.875rem; opacity: 0.9;" },
              "Deprecated",
            ),
          ),
        ),
      );
    })(statusSummary);

    const filterSection = lift((input: {
      topics: TopicOption[];
      regions: RegionOption[];
    }) => {
      const topicElements = [];
      for (const topic of input.topics) {
        const bgColor = topic.active ? "#dbeafe" : "#f9fafb";
        const borderColor = topic.active ? "#3b82f6" : "#e5e7eb";
        const style =
          "padding: 0.5rem 0.75rem; margin: 0.25rem; border-radius: 0.5rem; border: 2px solid " +
          borderColor +
          "; background: " +
          bgColor +
          "; display: inline-block; font-size: 0.875rem;";
        topicElements.push(
          h(
            "div",
            { style },
            h("strong", {}, topic.label),
            " (" + String(topic.count) + ")",
          ),
        );
      }

      const regionElements = [];
      for (const region of input.regions) {
        const bgColor = region.active ? "#dcfce7" : "#f9fafb";
        const borderColor = region.active ? "#16a34a" : "#e5e7eb";
        const style =
          "padding: 0.5rem 0.75rem; margin: 0.25rem; border-radius: 0.5rem; border: 2px solid " +
          borderColor +
          "; background: " +
          bgColor +
          "; display: inline-block; font-size: 0.875rem;";
        regionElements.push(
          h(
            "div",
            { style },
            h("strong", {}, region.label),
            " (" + String(region.count) + ")",
          ),
        );
      }

      return h(
        "div",
        {
          style:
            "background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 0.5rem; padding: 1rem; margin-bottom: 1.5rem;",
        },
        h(
          "h2",
          { style: "margin: 0 0 0.75rem 0; font-size: 1.25rem;" },
          "Filters",
        ),
        h(
          "div",
          { style: "margin-bottom: 0.75rem;" },
          h("strong", {}, "Topics:"),
        ),
        h("div", { style: "margin-bottom: 1rem;" }, ...topicElements),
        h(
          "div",
          { style: "margin-bottom: 0.75rem;" },
          h("strong", {}, "Regions:"),
        ),
        h("div", {}, ...regionElements),
      );
    })({
      topics: topicOptions,
      regions: regionOptions,
    });

    const clauseList = lift((input: {
      clauses: ClausePreview[];
      summaryText: string;
    }) => {
      const clauseElements = [];
      for (const clause of input.clauses) {
        let statusBg = "#f3f4f6";
        let statusColor = "#374151";
        if (clause.status === "approved") {
          statusBg = "#d1fae5";
          statusColor = "#065f46";
        } else if (clause.status === "draft") {
          statusBg = "#fef3c7";
          statusColor = "#92400e";
        } else if (clause.status === "deprecated") {
          statusBg = "#fee2e2";
          statusColor = "#991b1b";
        }

        const statusBadge = h(
          "span",
          {
            style: "background: " +
              statusBg +
              "; color: " +
              statusColor +
              "; padding: 0.25rem 0.5rem; border-radius: 0.25rem; font-size: 0.75rem; font-weight: 600; text-transform: uppercase;",
          },
          clause.status,
        );

        clauseElements.push(
          h(
            "div",
            {
              style:
                "border: 1px solid #e5e7eb; border-radius: 0.5rem; padding: 1rem; margin-bottom: 0.75rem; background: #ffffff;",
            },
            h(
              "div",
              {
                style:
                  "display: flex; justify-content: space-between; margin-bottom: 0.5rem;",
              },
              h("h3", {
                style: "margin: 0; font-size: 1.125rem; font-weight: 600;",
              }, clause.title),
              statusBadge,
            ),
            h(
              "div",
              {
                style:
                  "font-size: 0.875rem; color: #6b7280; margin-bottom: 0.5rem;",
              },
              "Topic: " + clause.topic + " • Region: " + clause.region +
                " • Last reviewed: " + clause.lastReviewed,
            ),
            h(
              "p",
              { style: "margin: 0; color: #374151; font-size: 0.875rem;" },
              clause.excerpt,
            ),
            h(
              "div",
              {
                style:
                  "margin-top: 0.5rem; font-size: 0.75rem; color: #9ca3af; font-family: monospace;",
              },
              "ID: " + clause.id,
            ),
          ),
        );
      }

      if (clauseElements.length === 0) {
        clauseElements.push(
          h(
            "div",
            {
              style:
                "border: 2px dashed #e5e7eb; border-radius: 0.5rem; padding: 2rem; text-align: center; color: #9ca3af;",
            },
            "No clauses match the current filters",
          ),
        );
      }

      return h(
        "div",
        {},
        h(
          "div",
          {
            style:
              "display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem;",
          },
          h("h2", { style: "margin: 0; font-size: 1.5rem;" }, "Clauses"),
          h(
            "div",
            { style: "font-size: 0.875rem; color: #6b7280;" },
            input.summaryText,
          ),
        ),
        ...clauseElements,
      );
    })({
      clauses: filteredClauses,
      summaryText: summaryLine,
    });

    const ui = (
      <div style="max-width: 1200px; margin: 0 auto; padding: 1.5rem; font-family: system-ui, sans-serif;">
        {header}
        {filterSection}
        <div style="background: white; border: 1px solid #e5e7eb; border-radius: 0.5rem; padding: 1rem; margin-bottom: 1.5rem;">
          <h3 style="margin: 0 0 0.75rem 0; font-size: 1rem;">Apply Filters</h3>
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 1rem;">
            <div>
              <label style="display: block; font-size: 0.875rem; font-weight: 500; margin-bottom: 0.25rem;">
                Topic (e.g., confidentiality, data-protection)
              </label>
              <ct-input
                $value={topicInputField}
                style="width: 100%; margin-bottom: 0.5rem;"
              />
              <ct-button
                onClick={applyTopicFilter({
                  input: topicInputField,
                  clauses,
                  topicFilter,
                })}
              >
                Set Topic
              </ct-button>
            </div>
            <div>
              <label style="display: block; font-size: 0.875rem; font-weight: 500; margin-bottom: 0.25rem;">
                Region (global, na, eu, apac)
              </label>
              <ct-input
                $value={regionInputField}
                style="width: 100%; margin-bottom: 0.5rem;"
              />
              <ct-button
                onClick={applyRegionFilter({
                  input: regionInputField,
                  regionFilter,
                })}
              >
                Set Region
              </ct-button>
            </div>
          </div>
          <ct-button
            onClick={clearAllFilters({
              topicFilter,
              regionFilter,
              topicInput: topicInputField,
              regionInput: regionInputField,
            })}
            style="margin-top: 0.75rem;"
          >
            Clear All Filters
          </ct-button>
        </div>
        <div style="background: white; border: 1px solid #e5e7eb; border-radius: 0.5rem; padding: 1rem; margin-bottom: 1.5rem;">
          <h3 style="margin: 0 0 0.75rem 0; font-size: 1rem;">
            Update Clause Status
          </h3>
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 1rem;">
            <div>
              <label style="display: block; font-size: 0.875rem; font-weight: 500; margin-bottom: 0.25rem;">
                Clause ID
              </label>
              <ct-input
                $value={clauseIdField}
                placeholder="e.g., nda-standard"
              />
            </div>
            <div>
              <label style="display: block; font-size: 0.875rem; font-weight: 500; margin-bottom: 0.25rem;">
                Status (approved, draft, deprecated)
              </label>
              <ct-input $value={statusField} placeholder="e.g., approved" />
            </div>
          </div>
          <ct-button
            onClick={updateStatus({
              clauseId: clauseIdField,
              statusInput: statusField,
              clauses,
            })}
            style="margin-top: 0.75rem;"
          >
            Update Status
          </ct-button>
        </div>
        {clauseList}
      </div>
    );

    return {
      [NAME]: name,
      [UI]: ui,
      handlers: {
        selectTopic: selectTopic({ clauses, topicFilter }),
        selectRegion: selectRegion({ regionFilter }),
        clearFilters: clearFilters({ topicFilter, regionFilter }),
        updateClauseStatus: updateClauseStatus({ clauses }),
      },
    };
  },
);

export type {
  ClauseInput,
  ClausePreview,
  RegionCode,
  RegionOption,
  TopicOption,
};
export type { ClauseStatus };
