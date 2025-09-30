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

/** Pattern managing procurement approvals with derived spending summaries. */
export type StageStatus = "pending" | "approved" | "rejected";

export type RequestStatus = "routing" | "approved" | "rejected";

export interface ApprovalStageSeed {
  key?: string;
  label?: string;
  approver?: string;
  status?: string;
}

export interface ApprovalStage {
  key: StageKey;
  label: string;
  approver: string;
  status: StageStatus;
}

export interface ProcurementRequestSeed {
  id?: string;
  requester?: string;
  department?: string;
  vendor?: string;
  description?: string;
  amount?: number;
  currency?: string;
  stages?: ApprovalStageSeed[];
}

export interface ProcurementRequest {
  id: string;
  requester: string;
  department: string;
  vendor: string;
  description: string;
  amount: number;
  currency: string;
  stages: readonly ApprovalStage[];
  status: RequestStatus;
}

export interface RequestCounts {
  total: number;
  routing: number;
  approved: number;
  rejected: number;
}

export interface AmountTotals {
  requested: number;
  routing: number;
  approved: number;
  rejected: number;
}

export interface DepartmentTotals {
  department: string;
  requested: number;
  routing: number;
  approved: number;
  rejected: number;
}

export interface RoutingAssignment {
  id: string;
  vendor: string;
  department: string;
  stage: string;
  approver: string;
  amount: number;
  currency: string;
}

export interface ProcurementRequestArgs {
  requests: Default<ProcurementRequestSeed[], typeof defaultRequests>;
}

export interface ApprovalDecisionEvent {
  id?: string;
  stage?: string;
  decision?: string;
  note?: string;
}

export interface RerouteEvent {
  id?: string;
  stage?: string;
  approver?: string;
  note?: string;
}

type StageKey = "department" | "procurement" | "finance";

type StageTemplate = {
  key: StageKey;
  label: string;
  fallbackApprover: string;
};

const stageCatalog: readonly StageTemplate[] = [
  {
    key: "department",
    label: "Department Review",
    fallbackApprover: "Department Head",
  },
  {
    key: "procurement",
    label: "Procurement Desk",
    fallbackApprover: "Procurement Lead",
  },
  {
    key: "finance",
    label: "Finance Approval",
    fallbackApprover: "Finance Controller",
  },
];

const defaultRequests: ProcurementRequestSeed[] = [
  {
    id: "monitor-upgrade",
    requester: "Jordan Smith",
    department: "Engineering",
    vendor: "Display Hub",
    description: '24" workstation monitor replacements',
    amount: 3200,
    currency: "usd",
    stages: [
      {
        label: "Department Review",
        approver: "Morgan Patel",
        status: "approved",
      },
      {
        label: "Procurement Desk",
        approver: "Ariana Flores",
        status: "pending",
      },
      {
        label: "Finance Approval",
        approver: "Casey Liu",
        status: "pending",
      },
    ],
  },
  {
    id: "ergonomic-chairs",
    requester: "Kendall Ortiz",
    department: "Operations",
    vendor: "Comfort Office",
    description: "Ergonomic chairs for support pod",
    amount: 1850,
    currency: "usd",
    stages: [
      {
        label: "Department Review",
        approver: "Jamie Lynn",
        status: "pending",
      },
      {
        label: "Procurement Desk",
        approver: "Samir Adey",
        status: "pending",
      },
      {
        label: "Finance Approval",
        approver: "Wei Tan",
        status: "pending",
      },
    ],
  },
  {
    id: "software-renewal",
    requester: "Hayden Lee",
    department: "Product",
    vendor: "Workflow Soft",
    description: "Annual workflow suite renewal",
    amount: 2400,
    currency: "usd",
    stages: [
      {
        label: "Department Review",
        approver: "Ally Ng",
        status: "approved",
      },
      {
        label: "Procurement Desk",
        approver: "Asha Ray",
        status: "approved",
      },
      {
        label: "Finance Approval",
        approver: "Jonas Pike",
        status: "approved",
      },
    ],
  },
];

const HISTORY_LIMIT = 8;

const roundCurrency = (value: number): number => {
  return Math.round(value * 100) / 100;
};

const sanitizeText = (value: unknown, fallback: string): string => {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
};

const sanitizeCurrency = (value: unknown, fallback: string): string => {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(trimmed) ? trimmed : fallback;
};

const sanitizeAmount = (value: unknown, fallback: number): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return roundCurrency(fallback);
  }
  return roundCurrency(value < 0 ? 0 : value);
};

const slugify = (value: string): string => {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)+/g, "");
};

const slugOrFallback = (value: unknown, fallback: string): string => {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  if (trimmed.length === 0) return fallback;
  const slug = slugify(trimmed);
  return slug.length > 0 ? slug : fallback;
};

const ensureUniqueId = (base: string, used: Set<string>): string => {
  let candidate = base;
  let index = 2;
  while (used.has(candidate)) {
    candidate = `${base}-${index}`;
    index += 1;
  }
  used.add(candidate);
  return candidate;
};

const sanitizeStageStatus = (
  value: unknown,
  fallback: StageStatus,
): StageStatus => {
  if (value === "pending" || value === "approved" || value === "rejected") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (
      normalized === "pending" ||
      normalized === "approved" ||
      normalized === "rejected"
    ) {
      return normalized as StageStatus;
    }
  }
  return fallback;
};

const normalizeStageKey = (value: unknown): StageKey | undefined => {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  for (const stage of stageCatalog) {
    if (normalized === stage.key) return stage.key;
    if (normalized === stage.label.toLowerCase()) return stage.key;
  }
  return undefined;
};

const defaultStageSeeds = (): ApprovalStageSeed[] => {
  return stageCatalog.map((stage) => ({
    key: stage.key,
    label: stage.label,
    approver: stage.fallbackApprover,
    status: "pending",
  }));
};

const sanitizeStageList = (
  value: readonly ApprovalStageSeed[] | undefined,
  fallback: readonly ApprovalStageSeed[],
): ApprovalStage[] => {
  const base = Array.isArray(value) && value.length > 0 ? value : fallback;
  return stageCatalog.map((stage, index) => {
    const raw = base[index] ?? fallback[index] ?? {};
    const fallbackApprover = sanitizeText(
      fallback[index]?.approver,
      stage.fallbackApprover,
    );
    const fallbackStatus = sanitizeStageStatus(
      fallback[index]?.status,
      "pending",
    );
    const approver = sanitizeText(raw?.approver, fallbackApprover);
    const label = sanitizeText(raw?.label, stage.label);
    const status = sanitizeStageStatus(raw?.status, fallbackStatus);
    return {
      key: stage.key,
      label,
      approver,
      status,
    };
  });
};

const deriveRequestStatus = (
  stages: readonly ApprovalStage[],
): RequestStatus => {
  if (stages.some((stage) => stage.status === "rejected")) {
    return "rejected";
  }
  if (stages.every((stage) => stage.status === "approved")) {
    return "approved";
  }
  return "routing";
};

const sanitizeRequests = (
  value: readonly ProcurementRequestSeed[] | undefined,
): ProcurementRequest[] => {
  const base = Array.isArray(value) && value.length > 0
    ? value
    : defaultRequests;
  const used = new Set<string>();
  const sanitized: ProcurementRequest[] = [];

  for (let index = 0; index < base.length; index++) {
    const raw = base[index] ?? {};
    const defaults = defaultRequests[index] ?? {};
    const fallbackId = slugOrFallback(
      defaults.id,
      `request-${index + 1}`,
    );
    const idBase = slugOrFallback(raw.id, fallbackId);
    const id = ensureUniqueId(idBase, used);
    const requester = sanitizeText(
      raw.requester,
      sanitizeText(defaults.requester, `Requester ${index + 1}`),
    );
    const department = sanitizeText(
      raw.department,
      sanitizeText(defaults.department, "Operations"),
    );
    const vendor = sanitizeText(
      raw.vendor,
      sanitizeText(defaults.vendor, `Vendor ${index + 1}`),
    );
    const description = sanitizeText(
      raw.description,
      sanitizeText(defaults.description, "Procurement request"),
    );
    const amount = sanitizeAmount(
      raw.amount,
      sanitizeAmount(defaults.amount, 1000),
    );
    const currency = sanitizeCurrency(
      raw.currency,
      sanitizeCurrency(defaults.currency, "USD"),
    );
    const fallbackStages = Array.isArray(defaults.stages) &&
        defaults.stages.length > 0
      ? defaults.stages
      : defaultStageSeeds();
    const stages = sanitizeStageList(raw.stages, fallbackStages);
    const status = deriveRequestStatus(stages);
    sanitized.push({
      id,
      requester,
      department,
      vendor,
      description,
      amount,
      currency,
      stages,
      status,
    });
  }

  if (sanitized.length === 0) {
    return sanitizeRequests(defaultRequests);
  }

  return sanitized;
};

const serializeRequest = (
  request: ProcurementRequest,
): ProcurementRequestSeed => {
  return {
    id: request.id,
    requester: request.requester,
    department: request.department,
    vendor: request.vendor,
    description: request.description,
    amount: request.amount,
    currency: request.currency,
    stages: request.stages.map((stage) => ({
      key: stage.key,
      label: stage.label,
      approver: stage.approver,
      status: stage.status,
    })),
  };
};

const calculateTotals = (
  requests: readonly ProcurementRequest[],
): AmountTotals => {
  let requested = 0;
  let routing = 0;
  let approved = 0;
  let rejected = 0;

  for (const request of requests) {
    const amount = roundCurrency(request.amount);
    requested += amount;
    if (request.status === "routing") {
      routing += amount;
    } else if (request.status === "approved") {
      approved += amount;
    } else {
      rejected += amount;
    }
  }

  return {
    requested: roundCurrency(requested),
    routing: roundCurrency(routing),
    approved: roundCurrency(approved),
    rejected: roundCurrency(rejected),
  };
};

const calculateCounts = (
  requests: readonly ProcurementRequest[],
): RequestCounts => {
  let routing = 0;
  let approved = 0;
  let rejected = 0;
  for (const request of requests) {
    if (request.status === "routing") routing += 1;
    else if (request.status === "approved") approved += 1;
    else rejected += 1;
  }
  return {
    total: requests.length,
    routing,
    approved,
    rejected,
  };
};

const buildDepartmentTotals = (
  requests: readonly ProcurementRequest[],
): DepartmentTotals[] => {
  const totals = new Map<string, DepartmentTotals>();

  for (const request of requests) {
    const existing = totals.get(request.department) ?? {
      department: request.department,
      requested: 0,
      routing: 0,
      approved: 0,
      rejected: 0,
    };
    existing.requested = roundCurrency(existing.requested + request.amount);
    if (request.status === "routing") {
      existing.routing = roundCurrency(existing.routing + request.amount);
    } else if (request.status === "approved") {
      existing.approved = roundCurrency(existing.approved + request.amount);
    } else {
      existing.rejected = roundCurrency(existing.rejected + request.amount);
    }
    totals.set(request.department, existing);
  }

  return Array.from(totals.values()).sort((left, right) =>
    left.department.localeCompare(right.department)
  );
};

const buildAssignments = (
  requests: readonly ProcurementRequest[],
): RoutingAssignment[] => {
  const assignments: RoutingAssignment[] = [];
  for (const request of requests) {
    if (request.status !== "routing") continue;
    const nextStage = request.stages.find((stage) =>
      stage.status === "pending"
    );
    if (!nextStage) continue;
    assignments.push({
      id: request.id,
      vendor: request.vendor,
      department: request.department,
      stage: nextStage.label,
      approver: nextStage.approver,
      amount: request.amount,
      currency: request.currency,
    });
  }
  return assignments.sort((left, right) => left.id.localeCompare(right.id));
};

const formatCurrency = (amount: number, currency: string): string => {
  return `${currency} ${roundCurrency(amount).toFixed(2)}`;
};

const buildSummaryLine = (
  requests: readonly ProcurementRequest[],
): string => {
  if (requests.length === 0) return "No procurement requests";
  const totals = calculateTotals(requests);
  const counts = calculateCounts(requests);
  const currency = requests[0]?.currency ?? "USD";
  const routingLabel = formatCurrency(totals.routing, currency);
  const approvedLabel = formatCurrency(totals.approved, currency);
  const rejectedLabel = formatCurrency(totals.rejected, currency);
  const parts = [
    `${counts.routing} routing (${routingLabel})`,
    `${counts.approved} approved (${approvedLabel})`,
    `${counts.rejected} rejected (${rejectedLabel})`,
  ];
  return `${counts.total} requests: ${parts.join(", ")}`;
};

const normalizeId = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const normalizeDecision = (value: unknown): StageStatus | undefined => {
  if (value === "approved" || value === "rejected") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "approved" || normalized === "rejected") {
      return normalized as StageStatus;
    }
  }
  return undefined;
};

const pushHistory = (
  history: Cell<string[]>,
  sequence: Cell<number>,
  message: string,
) => {
  const current = sequence.get() ?? 1;
  const nextSequence = current + 1;
  sequence.set(nextSequence);
  const entry = `${nextSequence}. ${message}`;
  const previous = history.get() ?? [];
  const appended = [...previous, entry];
  if (appended.length > HISTORY_LIMIT) {
    history.set(appended.slice(-HISTORY_LIMIT));
    return;
  }
  history.set(appended);
};

const buildDecisionMessage = (
  request: ProcurementRequest,
  stage: ApprovalStage,
  decision: StageStatus,
): string => {
  const amount = formatCurrency(request.amount, request.currency);
  if (decision === "approved") {
    if (request.status === "approved") {
      return [
        "Completed approval for",
        `${request.vendor} (${request.id})`,
        amount,
      ].join(" ");
    }
    return [
      "Approved",
      stage.label,
      "for",
      request.id,
      `(${stage.approver})`,
    ].join(" ");
  }
  return [
    "Rejected",
    request.id,
    "at",
    stage.label,
    `(${amount})`,
  ].join(" ");
};

const buildRerouteMessage = (
  request: ProcurementRequest,
  stage: ApprovalStage,
): string => {
  const amount = formatCurrency(request.amount, request.currency);
  return [
    "Rerouted",
    request.id,
    "to",
    stage.approver,
    "for",
    stage.label,
    `(${amount})`,
  ].join(" ");
};

const recordDecision = handler(
  (
    event: ApprovalDecisionEvent | undefined,
    context: {
      requests: Cell<ProcurementRequestSeed[]>;
      history: Cell<string[]>;
      sequence: Cell<number>;
    },
  ) => {
    const id = normalizeId(event?.id);
    const decision = normalizeDecision(event?.decision);
    if (!id || !decision) return;

    const sanitized = sanitizeRequests(context.requests.get());
    const index = sanitized.findIndex((request) => request.id === id);
    if (index === -1) return;

    const request = sanitized[index];
    const stageKey = normalizeStageKey(event?.stage) ??
      request.stages.find((stage) => stage.status === "pending")?.key;
    if (!stageKey) return;

    const stageIndex = request.stages.findIndex((stage) =>
      stage.key === stageKey
    );
    if (stageIndex === -1) return;

    const targetStage = request.stages[stageIndex];
    if (decision === targetStage.status) return;

    const updatedStages = request.stages.map(
      (stage, stageIdx): ApprovalStage => {
        if (stageIdx === stageIndex) {
          return { ...stage, status: decision };
        }
        if (decision === "rejected" && stageIdx > stageIndex) {
          return { ...stage, status: "pending" };
        }
        return stage;
      },
    );

    const updatedRequest: ProcurementRequest = {
      ...request,
      stages: updatedStages,
      status: deriveRequestStatus(updatedStages),
    };

    const nextRequests = sanitized.map((entry, entryIndex) =>
      entryIndex === index ? updatedRequest : entry
    );
    context.requests.set(nextRequests.map(serializeRequest));

    const message = buildDecisionMessage(
      updatedRequest,
      updatedStages[stageIndex],
      decision,
    );
    pushHistory(context.history, context.sequence, message);
  },
);

const rerouteStage = handler(
  (
    event: RerouteEvent | undefined,
    context: {
      requests: Cell<ProcurementRequestSeed[]>;
      history: Cell<string[]>;
      sequence: Cell<number>;
    },
  ) => {
    const id = normalizeId(event?.id);
    if (!id) return;
    const sanitized = sanitizeRequests(context.requests.get());
    const index = sanitized.findIndex((request) => request.id === id);
    if (index === -1) return;

    const request = sanitized[index];
    const stageKey = normalizeStageKey(event?.stage) ??
      request.stages.find((stage) => stage.status !== "approved")?.key;
    if (!stageKey) return;

    const stageIndex = request.stages.findIndex((stage) =>
      stage.key === stageKey
    );
    if (stageIndex === -1) return;

    const currentStage = request.stages[stageIndex];
    const approver = sanitizeText(
      event?.approver,
      currentStage.approver,
    );

    const updatedStages = request.stages.map(
      (stage, stageIdx): ApprovalStage => {
        if (stageIdx === stageIndex) {
          return { ...stage, approver, status: "pending" };
        }
        if (stageIdx > stageIndex) {
          return { ...stage, status: "pending" };
        }
        return stage;
      },
    );

    const updatedRequest: ProcurementRequest = {
      ...request,
      stages: updatedStages,
      status: deriveRequestStatus(updatedStages),
    };

    const nextRequests = sanitized.map((entry, entryIndex) =>
      entryIndex === index ? updatedRequest : entry
    );
    context.requests.set(nextRequests.map(serializeRequest));

    const message = buildRerouteMessage(
      updatedRequest,
      updatedStages[stageIndex],
    );
    pushHistory(context.history, context.sequence, message);
  },
);

/**
 * Builds a procurement approval workflow that tracks routing progress while
 * deriving deterministic spending summaries for the harness.
 */
export const procurementRequest = recipe<ProcurementRequestArgs>(
  "Procurement Request Workflow",
  ({ requests }) => {
    const history = cell<string[]>(["1. Procurement queue initialized"]);
    const sequence = cell(1);

    const requestList = lift(sanitizeRequests)(requests);
    const totals = lift(calculateTotals)(requestList);
    const counts = lift(calculateCounts)(requestList);
    const departmentTotals = lift(buildDepartmentTotals)(requestList);
    const routingAssignments = lift(buildAssignments)(requestList);
    const summaryLine = lift(buildSummaryLine)(requestList);
    const stageHeadline = str`${counts.routing} requests awaiting review`;

    const handlerContext = { requests, history, sequence };

    // UI-specific cells
    const requestIdField = cell("");
    const stageField = cell("");
    const decisionField = cell("");
    const approverField = cell("");

    // UI handlers that replicate business logic
    const handleApprove = handler((
      _event: unknown,
      context: {
        requestIdField: Cell<string>;
        stageField: Cell<string>;
        requests: Cell<ProcurementRequestSeed[]>;
        history: Cell<string[]>;
        sequence: Cell<number>;
      },
    ) => {
      const id = normalizeId(context.requestIdField.get());
      if (!id) return;

      const sanitized = sanitizeRequests(context.requests.get());
      const index = sanitized.findIndex((request) => request.id === id);
      if (index === -1) return;

      const request = sanitized[index];
      const stageFieldValue = context.stageField.get();
      const stageKey = normalizeStageKey(stageFieldValue) ??
        request.stages.find((stage) => stage.status === "pending")?.key;
      if (!stageKey) return;

      const stageIndex = request.stages.findIndex((stage) =>
        stage.key === stageKey
      );
      if (stageIndex === -1) return;

      const targetStage = request.stages[stageIndex];
      if ("approved" === targetStage.status) return;

      const updatedStages = request.stages.map(
        (stage, stageIdx): ApprovalStage => {
          if (stageIdx === stageIndex) {
            return { ...stage, status: "approved" };
          }
          return stage;
        },
      );

      const updatedRequest: ProcurementRequest = {
        ...request,
        stages: updatedStages,
        status: deriveRequestStatus(updatedStages),
      };

      const nextRequests = sanitized.map((entry, entryIndex) =>
        entryIndex === index ? updatedRequest : entry
      );
      context.requests.set(nextRequests.map(serializeRequest));

      const message = buildDecisionMessage(
        updatedRequest,
        updatedStages[stageIndex],
        "approved",
      );
      pushHistory(context.history, context.sequence, message);

      context.requestIdField.set("");
      context.stageField.set("");
    });

    const handleReject = handler((
      _event: unknown,
      context: {
        requestIdField: Cell<string>;
        stageField: Cell<string>;
        requests: Cell<ProcurementRequestSeed[]>;
        history: Cell<string[]>;
        sequence: Cell<number>;
      },
    ) => {
      const id = normalizeId(context.requestIdField.get());
      if (!id) return;

      const sanitized = sanitizeRequests(context.requests.get());
      const index = sanitized.findIndex((request) => request.id === id);
      if (index === -1) return;

      const request = sanitized[index];
      const stageFieldValue = context.stageField.get();
      const stageKey = normalizeStageKey(stageFieldValue) ??
        request.stages.find((stage) => stage.status === "pending")?.key;
      if (!stageKey) return;

      const stageIndex = request.stages.findIndex((stage) =>
        stage.key === stageKey
      );
      if (stageIndex === -1) return;

      const targetStage = request.stages[stageIndex];
      if ("rejected" === targetStage.status) return;

      const updatedStages = request.stages.map(
        (stage, stageIdx): ApprovalStage => {
          if (stageIdx === stageIndex) {
            return { ...stage, status: "rejected" };
          }
          if (stageIdx > stageIndex) {
            return { ...stage, status: "pending" };
          }
          return stage;
        },
      );

      const updatedRequest: ProcurementRequest = {
        ...request,
        stages: updatedStages,
        status: deriveRequestStatus(updatedStages),
      };

      const nextRequests = sanitized.map((entry, entryIndex) =>
        entryIndex === index ? updatedRequest : entry
      );
      context.requests.set(nextRequests.map(serializeRequest));

      const message = buildDecisionMessage(
        updatedRequest,
        updatedStages[stageIndex],
        "rejected",
      );
      pushHistory(context.history, context.sequence, message);

      context.requestIdField.set("");
      context.stageField.set("");
    });

    const handleReroute = handler((
      _event: unknown,
      context: {
        requestIdField: Cell<string>;
        stageField: Cell<string>;
        approverField: Cell<string>;
        requests: Cell<ProcurementRequestSeed[]>;
        history: Cell<string[]>;
        sequence: Cell<number>;
      },
    ) => {
      const id = normalizeId(context.requestIdField.get());
      if (!id) return;
      const sanitized = sanitizeRequests(context.requests.get());
      const index = sanitized.findIndex((request) => request.id === id);
      if (index === -1) return;

      const request = sanitized[index];
      const stageFieldValue = context.stageField.get();
      const stageKey = normalizeStageKey(stageFieldValue) ??
        request.stages.find((stage) => stage.status !== "approved")?.key;
      if (!stageKey) return;

      const stageIndex = request.stages.findIndex((stage) =>
        stage.key === stageKey
      );
      if (stageIndex === -1) return;

      const currentStage = request.stages[stageIndex];
      const approver = sanitizeText(
        context.approverField.get(),
        currentStage.approver,
      );

      const updatedStages = request.stages.map(
        (stage, stageIdx): ApprovalStage => {
          if (stageIdx === stageIndex) {
            return { ...stage, approver, status: "pending" };
          }
          if (stageIdx > stageIndex) {
            return { ...stage, status: "pending" };
          }
          return stage;
        },
      );

      const updatedRequest: ProcurementRequest = {
        ...request,
        stages: updatedStages,
        status: deriveRequestStatus(updatedStages),
      };

      const nextRequests = sanitized.map((entry, entryIndex) =>
        entryIndex === index ? updatedRequest : entry
      );
      context.requests.set(nextRequests.map(serializeRequest));

      const message = buildRerouteMessage(
        updatedRequest,
        updatedStages[stageIndex],
      );
      pushHistory(context.history, context.sequence, message);

      context.requestIdField.set("");
      context.stageField.set("");
      context.approverField.set("");
    });

    // Derived name
    const name = lift((c: RequestCounts) =>
      `Procurement: ${c.routing} pending`
    )(counts);

    // UI Component
    const requestsUI = lift((
      reqs: readonly ProcurementRequest[],
    ) => {
      const elements = [];
      for (const req of reqs) {
        const statusColor = req.status === "approved"
          ? "#10b981"
          : req.status === "rejected"
          ? "#ef4444"
          : "#f59e0b";
        const statusBg = req.status === "approved"
          ? "#d1fae5"
          : req.status === "rejected"
          ? "#fee2e2"
          : "#fef3c7";

        const stageElements = [];
        for (const stage of req.stages) {
          const stageColor = stage.status === "approved"
            ? "#10b981"
            : stage.status === "rejected"
            ? "#ef4444"
            : "#94a3b8";
          const stageBg = stage.status === "approved"
            ? "#d1fae5"
            : stage.status === "rejected"
            ? "#fee2e2"
            : "#f1f5f9";

          stageElements.push(
            h(
              "div",
              {
                style: "padding: 6px 10px; border-radius: 4px; background: " +
                  stageBg +
                  "; border: 1px solid " + stageColor +
                  "; font-size: 12px;",
              },
              h(
                "div",
                { style: "font-weight: 600; margin-bottom: 2px;" },
                stage.label,
              ),
              h(
                "div",
                { style: "color: #475569; font-size: 11px;" },
                stage.approver,
              ),
              h(
                "div",
                {
                  style:
                    "margin-top: 4px; font-size: 10px; text-transform: uppercase; font-weight: 600; color: " +
                    stageColor + ";",
                },
                stage.status,
              ),
            ),
          );
        }

        elements.push(
          h(
            "ct-card",
            {
              style: "margin-bottom: 12px; border-left: 4px solid " +
                statusColor +
                ";",
            },
            h(
              "div",
              {
                style:
                  "display: flex; justify-content: space-between; align-items: start; margin-bottom: 8px;",
              },
              h(
                "div",
                {},
                h(
                  "div",
                  {
                    style: "font-weight: 700; font-size: 16px; color: #1e293b;",
                  },
                  req.id,
                ),
                h(
                  "div",
                  {
                    style: "color: #64748b; font-size: 13px; margin-top: 2px;",
                  },
                  req.description,
                ),
              ),
              h(
                "div",
                {
                  style: "background: " + statusBg +
                    "; color: " + statusColor +
                    "; padding: 4px 10px; border-radius: 4px; font-size: 11px; font-weight: 700; text-transform: uppercase;",
                },
                req.status,
              ),
            ),
            h(
              "div",
              {
                style:
                  "display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 10px; font-size: 13px;",
              },
              h(
                "div",
                {},
                h(
                  "span",
                  { style: "color: #64748b;" },
                  "Requester: ",
                ),
                h("span", { style: "font-weight: 600;" }, req.requester),
              ),
              h(
                "div",
                {},
                h(
                  "span",
                  { style: "color: #64748b;" },
                  "Dept: ",
                ),
                h("span", { style: "font-weight: 600;" }, req.department),
              ),
              h(
                "div",
                {},
                h(
                  "span",
                  { style: "color: #64748b;" },
                  "Vendor: ",
                ),
                h("span", { style: "font-weight: 600;" }, req.vendor),
              ),
              h(
                "div",
                {},
                h(
                  "span",
                  { style: "color: #64748b;" },
                  "Amount: ",
                ),
                h(
                  "span",
                  { style: "font-weight: 700; color: #1e293b;" },
                  formatCurrency(req.amount, req.currency),
                ),
              ),
            ),
            h(
              "div",
              {
                style: "font-weight: 600; font-size: 12px; margin-bottom: 6px;",
              },
              "Approval Pipeline:",
            ),
            h(
              "div",
              { style: "display: flex; gap: 8px; flex-wrap: wrap;" },
              ...stageElements,
            ),
          ),
        );
      }

      if (elements.length === 0) {
        return h(
          "div",
          {
            style:
              "padding: 24px; text-align: center; color: #94a3b8; border: 2px dashed #cbd5e1; border-radius: 8px;",
          },
          "No procurement requests",
        );
      }

      return h("div", {}, ...elements);
    })(requestList);

    const summaryUI = lift((
      t: AmountTotals,
      c: RequestCounts,
      reqs: readonly ProcurementRequest[],
    ) => {
      if (!t || !c || !reqs) {
        return h("div", {}, "Loading...");
      }
      const currency = reqs.length > 0 ? reqs[0].currency : "USD";
      return h(
        "div",
        {
          style:
            "display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin-bottom: 16px;",
        },
        h(
          "ct-card",
          {
            style:
              "background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; text-align: center;",
          },
          h(
            "div",
            { style: "font-size: 28px; font-weight: 700; margin-bottom: 4px;" },
            String(c.total || 0),
          ),
          h(
            "div",
            { style: "font-size: 12px; opacity: 0.9;" },
            "Total Requests",
          ),
        ),
        h(
          "ct-card",
          { style: "background: #fef3c7; text-align: center;" },
          h(
            "div",
            {
              style:
                "font-size: 24px; font-weight: 700; color: #f59e0b; margin-bottom: 4px;",
            },
            String(c.routing || 0),
          ),
          h("div", { style: "font-size: 12px; color: #92400e;" }, "Routing"),
          h(
            "div",
            {
              style:
                "font-size: 11px; color: #92400e; margin-top: 4px; font-family: monospace;",
            },
            formatCurrency(t.routing || 0, currency),
          ),
        ),
        h(
          "ct-card",
          { style: "background: #d1fae5; text-align: center;" },
          h(
            "div",
            {
              style:
                "font-size: 24px; font-weight: 700; color: #10b981; margin-bottom: 4px;",
            },
            String(c.approved || 0),
          ),
          h("div", { style: "font-size: 12px; color: #065f46;" }, "Approved"),
          h(
            "div",
            {
              style:
                "font-size: 11px; color: #065f46; margin-top: 4px; font-family: monospace;",
            },
            formatCurrency(t.approved || 0, currency),
          ),
        ),
        h(
          "ct-card",
          { style: "background: #fee2e2; text-align: center;" },
          h(
            "div",
            {
              style:
                "font-size: 24px; font-weight: 700; color: #ef4444; margin-bottom: 4px;",
            },
            String(c.rejected || 0),
          ),
          h("div", { style: "font-size: 12px; color: #991b1b;" }, "Rejected"),
          h(
            "div",
            {
              style:
                "font-size: 11px; color: #991b1b; margin-top: 4px; font-family: monospace;",
            },
            formatCurrency(t.rejected || 0, currency),
          ),
        ),
      );
    })(totals, counts, requestList);

    const activityUI = lift((log: readonly string[]) => {
      const elements = [];
      const reversed = log.slice().reverse();
      for (let i = 0; i < Math.min(reversed.length, 6); i++) {
        const entry = reversed[i];
        elements.push(
          h(
            "div",
            {
              style: "padding: 8px 12px; background: " +
                (i % 2 === 0 ? "#f8fafc" : "#ffffff") +
                "; border-left: 3px solid #3b82f6; font-size: 12px; color: #475569;",
            },
            entry,
          ),
        );
      }
      return h("div", {}, ...elements);
    })(history);

    const ui = (
      <div style="padding: 20px; max-width: 1200px; margin: 0 auto; font-family: system-ui, -apple-system, sans-serif;">
        <div style="margin-bottom: 24px;">
          <h1 style="margin: 0 0 8px 0; font-size: 28px; color: #1e293b; font-weight: 800;">
            Procurement Request Workflow
          </h1>
          <p style="margin: 0; color: #64748b; font-size: 14px;">
            Track and approve procurement requests through multi-stage approval
            pipeline
          </p>
        </div>

        {summaryUI}

        <div style="display: grid; grid-template-columns: 2fr 1fr; gap: 20px; margin-bottom: 20px;">
          <div>
            <h2 style="font-size: 18px; font-weight: 700; margin: 0 0 12px 0; color: #1e293b;">
              Active Requests
            </h2>
            {requestsUI}
          </div>

          <div>
            <ct-card style="margin-bottom: 16px; background: #f8fafc;">
              <h3 style="margin: 0 0 12px 0; font-size: 16px; font-weight: 700; color: #1e293b;">
                Approve / Reject
              </h3>
              <div style="display: flex; flex-direction: column; gap: 8px;">
                <ct-input
                  $value={requestIdField}
                  placeholder="Request ID (e.g., monitor-upgrade)"
                  style="width: 100%;"
                />
                <ct-input
                  $value={stageField}
                  placeholder="Stage (optional, auto-detects next)"
                  style="width: 100%;"
                />
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px;">
                  <ct-button
                    onClick={handleApprove({
                      requestIdField,
                      stageField,
                      requests,
                      history,
                      sequence,
                    })}
                    style="background: #10b981; color: white;"
                  >
                    Approve
                  </ct-button>
                  <ct-button
                    onClick={handleReject({
                      requestIdField,
                      stageField,
                      requests,
                      history,
                      sequence,
                    })}
                    style="background: #ef4444; color: white;"
                  >
                    Reject
                  </ct-button>
                </div>
              </div>
            </ct-card>

            <ct-card style="background: #f8fafc;">
              <h3 style="margin: 0 0 12px 0; font-size: 16px; font-weight: 700; color: #1e293b;">
                Reassign Approver
              </h3>
              <div style="display: flex; flex-direction: column; gap: 8px;">
                <ct-input
                  $value={requestIdField}
                  placeholder="Request ID"
                  style="width: 100%;"
                />
                <ct-input
                  $value={stageField}
                  placeholder="Stage (optional)"
                  style="width: 100%;"
                />
                <ct-input
                  $value={approverField}
                  placeholder="New approver name"
                  style="width: 100%;"
                />
                <ct-button
                  onClick={handleReroute({
                    requestIdField,
                    stageField,
                    approverField,
                    requests,
                    history,
                    sequence,
                  })}
                  style="background: #8b5cf6; color: white; width: 100%;"
                >
                  Reroute
                </ct-button>
              </div>
            </ct-card>
          </div>
        </div>

        <ct-card>
          <h3 style="margin: 0 0 12px 0; font-size: 16px; font-weight: 700; color: #1e293b;">
            Recent Activity
          </h3>
          {activityUI}
        </ct-card>
      </div>
    );

    return {
      requests,
      requestList,
      totals,
      counts,
      departmentTotals,
      routingAssignments,
      summaryLine,
      stageHeadline,
      activityLog: history,
      recordDecision: recordDecision(handlerContext),
      rerouteStage: rerouteStage(handlerContext),
      [NAME]: name,
      [UI]: ui,
    };
  },
);
