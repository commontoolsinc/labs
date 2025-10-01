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

type ClaimStatus = "submitted" | "approved" | "rejected" | "paid";

type ActionKind = "approved" | "rejected" | "paid";

interface ExpenseClaimInput {
  id?: string;
  employee?: string;
  description?: string;
  amount?: number;
  status?: string;
}

interface ExpenseClaim {
  id: string;
  employee: string;
  description: string;
  amount: number;
  status: ClaimStatus;
}

interface ExpenseTotals {
  submitted: number;
  approved: number;
  rejected: number;
  paid: number;
  pendingPayment: number;
  totalRequested: number;
}

interface ExpenseReimbursementArgs {
  claims: Default<ExpenseClaimInput[], typeof defaultClaims>;
}

interface StatusChangeEvent {
  id?: string;
}

interface StatusHandlerContext {
  claims: Cell<ExpenseClaimInput[]>;
  history: Cell<string[]>;
  latestAction: Cell<string>;
  sequence: Cell<number>;
  selectedClaimId: Cell<string>;
}

const defaultClaims: ExpenseClaimInput[] = [
  {
    id: "travel-001",
    employee: "Avery",
    description: "Quarterly offsite travel",
    amount: 186.25,
    status: "submitted",
  },
  {
    id: "supplies-002",
    employee: "Briar",
    description: "Workshop materials",
    amount: 92.4,
    status: "submitted",
  },
  {
    id: "team-lunch-003",
    employee: "Sky",
    description: "Team lunch with client",
    amount: 48.5,
    status: "approved",
  },
  {
    id: "lodging-004",
    employee: "Riley",
    description: "Conference lodging",
    amount: 220,
    status: "paid",
  },
];

const roundCurrency = (value: number): number => {
  return Math.round(value * 100) / 100;
};

const sanitizeAmount = (value: unknown, fallback: number): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return roundCurrency(Math.max(fallback, 0));
  }
  return roundCurrency(Math.max(0, value));
};

const normalizeText = (value: unknown, fallback: string): string => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return fallback;
};

const normalizeStatus = (
  value: unknown,
  fallback: ClaimStatus,
): ClaimStatus => {
  if (typeof value !== "string") return fallback;
  const normalized = value.toLowerCase();
  if (
    normalized === "submitted" ||
    normalized === "approved" ||
    normalized === "rejected" ||
    normalized === "paid"
  ) {
    return normalized;
  }
  return fallback;
};

const slugify = (value: string): string => {
  return value.toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
};

const slugOrFallback = (value: unknown, fallback: string): string => {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  if (trimmed.length === 0) return fallback;
  const slug = slugify(trimmed);
  return slug.length > 0 ? slug : fallback;
};

const ensureUniqueId = (
  base: string,
  used: Set<string>,
  fallback: string,
): string => {
  const initial = base.length > 0 ? base : fallback;
  let candidate = initial;
  let suffix = 2;
  while (used.has(candidate)) {
    candidate = `${initial}-${suffix}`;
    suffix++;
  }
  used.add(candidate);
  return candidate;
};

const sanitizeClaimList = (
  value: readonly ExpenseClaimInput[] | undefined,
): ExpenseClaim[] => {
  const source = Array.isArray(value) ? value : [];
  const base = source.length > 0 ? source : defaultClaims;
  const usedIds = new Set<string>();
  const sanitized: ExpenseClaim[] = [];

  for (let index = 0; index < base.length; index++) {
    const raw = base[index];
    const defaults = defaultClaims[index] ?? {};
    const fallbackEmployee = normalizeText(
      defaults.employee,
      `Employee ${index + 1}`,
    );
    const fallbackDescription = normalizeText(
      defaults.description,
      `Expense ${index + 1}`,
    );
    const fallbackAmount = sanitizeAmount(defaults.amount, 0);
    const fallbackStatus = normalizeStatus(defaults.status, "submitted");
    const fallbackSlug = slugOrFallback(defaults.id, `claim-${index + 1}`);
    const baseSlug = slugOrFallback(raw?.id, fallbackSlug);
    const id = ensureUniqueId(baseSlug, usedIds, fallbackSlug);
    const employee = normalizeText(raw?.employee, fallbackEmployee);
    const description = normalizeText(raw?.description, fallbackDescription);
    const amount = sanitizeAmount(raw?.amount, fallbackAmount);
    const status = normalizeStatus(raw?.status, fallbackStatus);
    sanitized.push({ id, employee, description, amount, status });
  }

  if (sanitized.length === 0) {
    return sanitizeClaimList(defaultClaims);
  }

  return sanitized;
};

const calculateTotals = (claims: readonly ExpenseClaim[]): ExpenseTotals => {
  let submitted = 0;
  let approved = 0;
  let rejected = 0;
  let paid = 0;

  for (const claim of claims) {
    const amount = roundCurrency(claim.amount);
    switch (claim.status) {
      case "submitted":
        submitted += amount;
        break;
      case "approved":
        approved += amount;
        break;
      case "rejected":
        rejected += amount;
        break;
      case "paid":
        paid += amount;
        break;
    }
  }

  const totalRequested = claims.reduce(
    (sum, claim) => sum + roundCurrency(claim.amount),
    0,
  );

  return {
    submitted: roundCurrency(submitted),
    approved: roundCurrency(approved),
    rejected: roundCurrency(rejected),
    paid: roundCurrency(paid),
    pendingPayment: roundCurrency(approved),
    totalRequested: roundCurrency(totalRequested),
  };
};

const formatCurrency = (value: number): string => {
  return `$${roundCurrency(value).toFixed(2)}`;
};

const buildSummaryLabel = (totals: ExpenseTotals): string => {
  const requested = formatCurrency(totals.totalRequested);
  const paid = formatCurrency(totals.paid);
  const pending = formatCurrency(totals.pendingPayment);
  return `Recorded ${requested} in claims; reimbursed ${paid}; pending ${pending}.`;
};

const buildActionMessage = (
  kind: ActionKind,
  claim: ExpenseClaim,
): string => {
  const amount = formatCurrency(claim.amount);
  if (kind === "approved") {
    return `Approved ${claim.id} for ${claim.employee} (${amount})`;
  }
  if (kind === "rejected") {
    return `Rejected ${claim.id} for ${claim.employee} (${amount})`;
  }
  return `Recorded payment for ${claim.id} (${amount})`;
};

const buildStatusChangeHandler = (
  kind: ActionKind,
  nextStatus: ClaimStatus,
  allowed: readonly ClaimStatus[],
) =>
  handler(
    (_event: unknown, context: StatusHandlerContext) => {
      const id = (context.selectedClaimId.get() || "").trim();
      if (id.length === 0) return;

      const sanitized = sanitizeClaimList(context.claims.get());
      const index = sanitized.findIndex((claim) => claim.id === id);
      if (index === -1) return;

      const target = sanitized[index];
      if (!allowed.includes(target.status)) return;

      const updatedClaim: ExpenseClaim = { ...target, status: nextStatus };
      const nextClaims = sanitized.map((claim, claimIndex) =>
        claimIndex === index ? updatedClaim : claim
      );
      context.claims.set(nextClaims.map((claim) => ({ ...claim })));

      const message = buildActionMessage(kind, updatedClaim);
      context.latestAction.set(message);

      const previousHistory = context.history.get() ?? [];
      const appended = [...previousHistory, message];
      const trimmed = appended.length > 5 ? appended.slice(-5) : appended;
      context.history.set(trimmed);

      const sequence = (context.sequence.get() ?? 0) + 1;
      context.sequence.set(sequence);
    },
  );

export const expenseReimbursementUx = recipe<ExpenseReimbursementArgs>(
  "Expense Reimbursement Tracker (UX)",
  ({ claims }) => {
    const history = cell<string[]>(["Reimbursement tracker initialized"]);
    const latestAction = cell("Reimbursement tracker initialized");
    const sequence = cell(0);
    const selectedClaimId = cell<string>("");

    const claimList = lift(sanitizeClaimList)(claims);
    const totals = lift(calculateTotals)(claimList);

    const claimCount = lift((entries: readonly ExpenseClaim[]) =>
      entries.length
    )(
      claimList,
    );
    const submittedTotal = lift((data: ExpenseTotals) => data.submitted)(
      totals,
    );
    const approvedTotal = lift((data: ExpenseTotals) => data.approved)(totals);
    const rejectedTotal = lift((data: ExpenseTotals) => data.rejected)(totals);
    const paidTotal = lift((data: ExpenseTotals) => data.paid)(totals);
    const pendingPayment = lift((data: ExpenseTotals) => data.pendingPayment)(
      totals,
    );
    const summaryLabel = lift(buildSummaryLabel)(totals);
    const statusHeadline = str`${claimCount} claims ready for review`;

    const handlerContext = {
      claims,
      history,
      latestAction,
      sequence,
      selectedClaimId,
    };

    const approveClaim = buildStatusChangeHandler(
      "approved",
      "approved",
      ["submitted"],
    )(handlerContext);
    const recordPayment = buildStatusChangeHandler(
      "paid",
      "paid",
      ["approved"],
    )(handlerContext);
    const rejectClaim = buildStatusChangeHandler(
      "rejected",
      "rejected",
      ["submitted", "approved"],
    )(handlerContext);

    const name = str`Expense Reimbursement (${claimCount} claims)`;

    const claimsList = lift((claimsData: ExpenseClaim[]) => {
      if (!claimsData || claimsData.length === 0) {
        return (
          <div style="
              padding: 2rem;
              text-align: center;
              color: #94a3b8;
              font-size: 0.9rem;
            ">
            No expense claims to review.
          </div>
        );
      }

      const elements = [];
      for (let i = 0; i < claimsData.length; i++) {
        const claim = claimsData[i];
        let statusColor = "#64748b";
        let statusBg = "#f1f5f9";
        let statusText = claim.status;

        if (claim.status === "submitted") {
          statusColor = "#0369a1";
          statusBg = "#e0f2fe";
          statusText = "Submitted";
        } else if (claim.status === "approved") {
          statusColor = "#15803d";
          statusBg = "#dcfce7";
          statusText = "Approved";
        } else if (claim.status === "rejected") {
          statusColor = "#b91c1c";
          statusBg = "#fee2e2";
          statusText = "Rejected";
        } else if (claim.status === "paid") {
          statusColor = "#6d28d9";
          statusBg = "#ede9fe";
          statusText = "Paid";
        }

        const bgColor = i % 2 === 0 ? "#ffffff" : "#f8fafc";

        elements.push(
          <div
            key={claim.id}
            style={"display: flex; flex-direction: column; gap: 0.5rem; padding: 1rem; background: " +
              bgColor +
              "; border-bottom: 1px solid #e2e8f0;"}
          >
            <div style="
                display: flex;
                justify-content: space-between;
                align-items: flex-start;
                gap: 1rem;
              ">
              <div style="flex: 1; min-width: 0;">
                <div style="
                    font-size: 0.75rem;
                    color: #64748b;
                    font-family: monospace;
                    margin-bottom: 0.25rem;
                  ">
                  {claim.id}
                </div>
                <div style="
                    font-weight: 600;
                    color: #0f172a;
                    font-size: 0.95rem;
                    margin-bottom: 0.25rem;
                  ">
                  {claim.employee}
                </div>
                <div style="font-size: 0.85rem; color: #475569;">
                  {claim.description}
                </div>
              </div>
              <div style="
                  display: flex;
                  flex-direction: column;
                  align-items: flex-end;
                  gap: 0.5rem;
                ">
                <div style="
                    font-size: 1.1rem;
                    font-weight: 700;
                    color: #0f172a;
                    font-family: monospace;
                  ">
                  {formatCurrency(claim.amount)}
                </div>
                <span
                  style={"display: inline-block; padding: 0.25rem 0.75rem; border-radius: 1rem; font-size: 0.75rem; font-weight: 600; color: " +
                    statusColor +
                    "; background: " +
                    statusBg +
                    ";"}
                >
                  {statusText}
                </span>
              </div>
            </div>
          </div>,
        );
      }

      return <div>{elements}</div>;
    })(claimList);

    const activityList = lift((log: string[]) => {
      if (!log || log.length === 0) {
        return (
          <div style="
              padding: 1rem;
              text-align: center;
              color: #94a3b8;
              font-size: 0.85rem;
            ">
            No activity yet
          </div>
        );
      }

      const elements = [];
      for (let i = 0; i < log.length; i++) {
        const message = log[i];
        elements.push(
          <div
            key={String(i)}
            style="
              padding: 0.75rem;
              font-size: 0.85rem;
              color: #334155;
              border-bottom: 1px solid #e2e8f0;
            "
          >
            {message}
          </div>,
        );
      }

      return <div>{elements}</div>;
    })(history);

    return {
      [NAME]: name,
      [UI]: (
        <div style="
            display: flex;
            flex-direction: column;
            gap: 1.5rem;
            max-width: 50rem;
            background: #fafafa;
            padding: 1.5rem;
            border-radius: 0.75rem;
          ">
          <div style="
              display: flex;
              flex-direction: column;
              gap: 0.5rem;
            ">
            <h1 style="
                margin: 0;
                font-size: 1.75rem;
                color: #0f172a;
                font-weight: 700;
              ">
              Expense Reimbursement
            </h1>
            <p style="margin: 0; font-size: 0.9rem; color: #64748b;">
              Review and process employee expense claims
            </p>
          </div>

          <div style="
              display: grid;
              grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
              gap: 1rem;
            ">
            <div style="
                background: #fef3c7;
                border-left: 4px solid #f59e0b;
                padding: 1rem;
                border-radius: 0.5rem;
              ">
              <div style="font-size: 0.75rem; color: #92400e; font-weight: 600;">
                SUBMITTED
              </div>
              <div style="font-size: 1.5rem; font-weight: 700; color: #78350f;">
                {lift((t: ExpenseTotals) => formatCurrency(t.submitted))(
                  totals,
                )}
              </div>
            </div>

            <div style="
                background: #d1fae5;
                border-left: 4px solid #10b981;
                padding: 1rem;
                border-radius: 0.5rem;
              ">
              <div style="font-size: 0.75rem; color: #065f46; font-weight: 600;">
                APPROVED
              </div>
              <div style="font-size: 1.5rem; font-weight: 700; color: #064e3b;">
                {lift((t: ExpenseTotals) => formatCurrency(t.approved))(totals)}
              </div>
            </div>

            <div style="
                background: #dbeafe;
                border-left: 4px solid #3b82f6;
                padding: 1rem;
                border-radius: 0.5rem;
              ">
              <div style="font-size: 0.75rem; color: #1e3a8a; font-weight: 600;">
                PAID
              </div>
              <div style="font-size: 1.5rem; font-weight: 700; color: #1e40af;">
                {lift((t: ExpenseTotals) => formatCurrency(t.paid))(totals)}
              </div>
            </div>

            <div style="
                background: #fee2e2;
                border-left: 4px solid #ef4444;
                padding: 1rem;
                border-radius: 0.5rem;
              ">
              <div style="font-size: 0.75rem; color: #991b1b; font-weight: 600;">
                REJECTED
              </div>
              <div style="font-size: 1.5rem; font-weight: 700; color: #7f1d1d;">
                {lift((t: ExpenseTotals) => formatCurrency(t.rejected))(totals)}
              </div>
            </div>
          </div>

          <ct-card>
            <div slot="header">
              <h2 style="margin: 0; font-size: 1.1rem; color: #0f172a;">
                All Claims ({claimCount})
              </h2>
            </div>
            <div
              slot="content"
              style="
                display: flex;
                flex-direction: column;
                gap: 0;
              "
            >
              {claimsList}
            </div>
          </ct-card>

          <ct-card>
            <div slot="header">
              <h2 style="margin: 0; font-size: 1.1rem; color: #0f172a;">
                Process Claim
              </h2>
            </div>
            <div
              slot="content"
              style="
                display: flex;
                flex-direction: column;
                gap: 1rem;
              "
            >
              <div style="
                  background: #f0f9ff;
                  border: 1px solid #bae6fd;
                  border-radius: 0.5rem;
                  padding: 0.75rem;
                  font-size: 0.85rem;
                  color: #0c4a6e;
                ">
                Enter a claim ID from the list above, then use the action
                buttons to approve, reject, or record payment.
              </div>

              <div style="
                  display: flex;
                  flex-direction: column;
                  gap: 0.5rem;
                ">
                <label
                  for="claim-id"
                  style="
                    font-size: 0.85rem;
                    font-weight: 600;
                    color: #334155;
                  "
                >
                  Claim ID
                </label>
                <ct-input
                  id="claim-id"
                  type="text"
                  placeholder="e.g., travel-001"
                  $value={selectedClaimId}
                  aria-label="Claim ID to process"
                />
              </div>

              <div style="
                  display: grid;
                  grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
                  gap: 0.75rem;
                ">
                <ct-button
                  variant="primary"
                  onClick={approveClaim}
                  aria-label="Approve selected claim"
                >
                  ✓ Approve
                </ct-button>
                <ct-button
                  variant="secondary"
                  onClick={rejectClaim}
                  aria-label="Reject selected claim"
                >
                  ✗ Reject
                </ct-button>
                <ct-button
                  variant="secondary"
                  onClick={recordPayment}
                  aria-label="Record payment for selected claim"
                >
                  💰 Record Payment
                </ct-button>
              </div>

              <div style="
                  margin-top: 0.5rem;
                  padding: 0.75rem;
                  background: #f8fafc;
                  border-radius: 0.5rem;
                  font-size: 0.85rem;
                  color: #475569;
                ">
                <strong>Latest action:</strong> {latestAction}
              </div>
            </div>
          </ct-card>

          <ct-card>
            <div slot="header">
              <h2 style="margin: 0; font-size: 1.1rem; color: #0f172a;">
                Recent Activity
              </h2>
            </div>
            <div
              slot="content"
              style="
                display: flex;
                flex-direction: column;
                gap: 0;
              "
            >
              {activityList}
            </div>
          </ct-card>
        </div>
      ),
      claims,
      claimList,
      totals,
      claimCount,
      submittedTotal,
      approvedTotal,
      rejectedTotal,
      paidTotal,
      pendingPayment,
      summaryLabel,
      statusHeadline,
      latestAction,
      activityLog: history,
      approveClaim,
      recordPayment,
      rejectClaim,
    };
  },
);

export default expenseReimbursementUx;
