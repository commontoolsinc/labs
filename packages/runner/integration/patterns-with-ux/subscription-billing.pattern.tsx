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

type PlanId = "starter" | "growth" | "enterprise";

interface PlanDefinition {
  id: PlanId;
  name: string;
  price: number;
  cycleDays: number;
}

interface SubscriptionBillingArgs {
  plan: Default<PlanId, typeof defaultPlan>;
  lastInvoiceDate: Default<string, typeof defaultLastInvoiceDate>;
}

interface PlanChangeEvent {
  plan?: string;
  cycleDays?: number;
  lastInvoiceDate?: string;
}

interface InvoiceRecordedEvent {
  date?: string;
}

const defaultPlan: PlanId = "starter";
const defaultLastInvoiceDate = "2024-01-01";

const planCatalog: Record<PlanId, PlanDefinition> = {
  starter: { id: "starter", name: "Starter", price: 29, cycleDays: 30 },
  growth: { id: "growth", name: "Growth", price: 59, cycleDays: 30 },
  enterprise: {
    id: "enterprise",
    name: "Enterprise",
    price: 119,
    cycleDays: 90,
  },
};

const knownPlans = new Set<PlanId>(["starter", "growth", "enterprise"]);

const formatCurrency = (amount: number): string => {
  return `$${amount.toFixed(2)}`;
};

const parseIsoDate = (input: string): Date | null => {
  if (typeof input !== "string") return null;
  const date = new Date(`${input}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date;
};

const formatIsoDate = (date: Date): string => {
  return date.toISOString().slice(0, 10);
};

const sanitizePlanId = (value: unknown): PlanId => {
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (knownPlans.has(normalized as PlanId)) {
      return normalized as PlanId;
    }
  }
  return defaultPlan;
};

const sanitizeCycleDays = (value: unknown, fallback: number): number => {
  if (typeof value === "number" && Number.isFinite(value)) {
    const rounded = Math.trunc(value);
    return rounded > 0 ? rounded : fallback;
  }
  if (typeof fallback === "number" && fallback > 0) {
    return Math.trunc(fallback);
  }
  return planCatalog[defaultPlan].cycleDays;
};

const sanitizeInvoiceDate = (value: unknown, fallback: string): string => {
  if (typeof value === "string") {
    const parsed = parseIsoDate(value);
    if (parsed) return formatIsoDate(parsed);
  }
  const parsedFallback = parseIsoDate(fallback);
  if (parsedFallback) return formatIsoDate(parsedFallback);
  return defaultLastInvoiceDate;
};

const computeNextInvoiceDate = (input: {
  lastInvoice: string;
  cycleDays: number;
}): string => {
  const parsed = parseIsoDate(input.lastInvoice);
  if (!parsed) return defaultLastInvoiceDate;
  const increment = sanitizeCycleDays(input.cycleDays, 1);
  const next = new Date(parsed);
  next.setUTCDate(next.getUTCDate() + increment);
  return formatIsoDate(next);
};

const describePlanActivation = (
  plan: PlanDefinition,
  cycle: number,
  nextInvoice: string,
): string => {
  return `${plan.name} plan uses a ${cycle}-day cycle. Next invoice ${nextInvoice}`;
};

const describeInvoiceRecord = (
  plan: PlanDefinition,
  cycle: number,
  invoice: string,
  nextInvoice: string,
): string => {
  return `Invoice recorded on ${invoice} for ${plan.name}. Next invoice ${nextInvoice}`;
};

const resolvePlanDefinition = (plan: PlanId): PlanDefinition => {
  return planCatalog[plan] ?? planCatalog[defaultPlan];
};

const changePlan = handler(
  (
    event: PlanChangeEvent | undefined,
    context: {
      plan: Cell<PlanId>;
      cycleOverride: Cell<number | null>;
      lastInvoice: Cell<string>;
      history: Cell<string[]>;
    },
  ) => {
    const currentPlan = sanitizePlanId(context.plan.get());
    const nextPlan = sanitizePlanId(event?.plan ?? currentPlan);
    const definition = resolvePlanDefinition(nextPlan);

    context.plan.set(nextPlan);

    if (event && Object.hasOwn(event, "cycleDays")) {
      const overrideValue = sanitizeCycleDays(
        event?.cycleDays,
        definition.cycleDays,
      );
      context.cycleOverride.set(overrideValue);
    } else if (currentPlan !== nextPlan) {
      context.cycleOverride.set(null);
    }

    const baseInvoice = sanitizeInvoiceDate(
      context.lastInvoice.get(),
      defaultLastInvoiceDate,
    );
    const updatedInvoice = event?.lastInvoiceDate
      ? sanitizeInvoiceDate(event.lastInvoiceDate, baseInvoice)
      : baseInvoice;
    context.lastInvoice.set(updatedInvoice);

    const resolvedCycle = sanitizeCycleDays(
      context.cycleOverride.get(),
      definition.cycleDays,
    );

    const nextInvoice = computeNextInvoiceDate({
      lastInvoice: updatedInvoice,
      cycleDays: resolvedCycle,
    });

    context.history.push(
      describePlanActivation(definition, resolvedCycle, nextInvoice),
    );
  },
);

const recordInvoice = handler(
  (
    event: InvoiceRecordedEvent | undefined,
    context: {
      plan: Cell<PlanId>;
      cycleOverride: Cell<number | null>;
      lastInvoice: Cell<string>;
      history: Cell<string[]>;
    },
  ) => {
    if (!event) return;
    const definition = resolvePlanDefinition(
      sanitizePlanId(context.plan.get()),
    );
    const resolvedCycle = sanitizeCycleDays(
      context.cycleOverride.get(),
      definition.cycleDays,
    );
    const previousInvoice = sanitizeInvoiceDate(
      context.lastInvoice.get(),
      defaultLastInvoiceDate,
    );
    const appliedInvoice = sanitizeInvoiceDate(
      event.date,
      previousInvoice,
    );
    context.lastInvoice.set(appliedInvoice);
    const nextInvoice = computeNextInvoiceDate({
      lastInvoice: appliedInvoice,
      cycleDays: resolvedCycle,
    });
    context.history.push(
      describeInvoiceRecord(
        definition,
        resolvedCycle,
        appliedInvoice,
        nextInvoice,
      ),
    );
  },
);

// UI Handlers
const uiChangePlan = handler(
  (
    _event: unknown,
    context: {
      plan: Cell<PlanId>;
      cycleOverride: Cell<number | null>;
      lastInvoice: Cell<string>;
      history: Cell<string[]>;
      planField: Cell<string>;
      cycleDaysField: Cell<string>;
    },
  ) => {
    const planStr = context.planField.get();
    const cycleDaysStr = context.cycleDaysField.get();

    if (typeof planStr !== "string" || planStr.trim() === "") return;

    const currentPlan = sanitizePlanId(context.plan.get());
    const nextPlan = sanitizePlanId(planStr);
    const definition = resolvePlanDefinition(nextPlan);

    context.plan.set(nextPlan);

    if (typeof cycleDaysStr === "string" && cycleDaysStr.trim() !== "") {
      const parsed = parseInt(cycleDaysStr, 10);
      if (!Number.isNaN(parsed)) {
        const overrideValue = sanitizeCycleDays(parsed, definition.cycleDays);
        context.cycleOverride.set(overrideValue);
      }
    } else if (currentPlan !== nextPlan) {
      context.cycleOverride.set(null);
    }

    const baseInvoice = sanitizeInvoiceDate(
      context.lastInvoice.get(),
      defaultLastInvoiceDate,
    );

    const resolvedCycle = sanitizeCycleDays(
      context.cycleOverride.get(),
      definition.cycleDays,
    );

    const nextInvoice = computeNextInvoiceDate({
      lastInvoice: baseInvoice,
      cycleDays: resolvedCycle,
    });

    context.history.push(
      describePlanActivation(definition, resolvedCycle, nextInvoice),
    );

    context.planField.set("");
    context.cycleDaysField.set("");
  },
);

const uiRecordInvoice = handler(
  (
    _event: unknown,
    context: {
      plan: Cell<PlanId>;
      cycleOverride: Cell<number | null>;
      lastInvoice: Cell<string>;
      history: Cell<string[]>;
      invoiceDateField: Cell<string>;
    },
  ) => {
    const dateStr = context.invoiceDateField.get();
    if (typeof dateStr !== "string" || dateStr.trim() === "") return;

    const definition = resolvePlanDefinition(
      sanitizePlanId(context.plan.get()),
    );
    const resolvedCycle = sanitizeCycleDays(
      context.cycleOverride.get(),
      definition.cycleDays,
    );
    const previousInvoice = sanitizeInvoiceDate(
      context.lastInvoice.get(),
      defaultLastInvoiceDate,
    );
    const appliedInvoice = sanitizeInvoiceDate(dateStr, previousInvoice);
    context.lastInvoice.set(appliedInvoice);
    const nextInvoice = computeNextInvoiceDate({
      lastInvoice: appliedInvoice,
      cycleDays: resolvedCycle,
    });
    context.history.push(
      describeInvoiceRecord(
        definition,
        resolvedCycle,
        appliedInvoice,
        nextInvoice,
      ),
    );

    context.invoiceDateField.set("");
  },
);

export const subscriptionBilling = recipe<SubscriptionBillingArgs>(
  "Subscription Billing",
  ({ plan, lastInvoiceDate }) => {
    const cycleOverride = cell<number | null>(null);
    const history = cell<string[]>([]);

    // UI form fields
    const planField = cell("");
    const cycleDaysField = cell("");
    const invoiceDateField = cell("");

    const currentPlan = lift(sanitizePlanId)(plan);
    const planDetails = lift(resolvePlanDefinition)(currentPlan);

    const cycleDays = lift((input: {
      plan: PlanId;
      override: number | null;
    }) => {
      const definition = resolvePlanDefinition(input.plan);
      if (input.override === null || input.override === undefined) {
        return definition.cycleDays;
      }
      return sanitizeCycleDays(input.override, definition.cycleDays);
    })({
      plan: currentPlan,
      override: cycleOverride,
    });

    const normalizedInvoice = lift((value: string | undefined) =>
      sanitizeInvoiceDate(value, defaultLastInvoiceDate)
    )(lastInvoiceDate);

    const nextInvoiceDate = lift(computeNextInvoiceDate)({
      lastInvoice: normalizedInvoice,
      cycleDays,
    });

    const planName = lift((detail: PlanDefinition) => detail.name)(
      planDetails,
    );
    const priceLabel = lift((detail: PlanDefinition) =>
      formatCurrency(detail.price)
    )(planDetails);
    const cycleLabel = lift((cycle: number) => `${cycle} days`)(cycleDays);

    const summary =
      str`${planName} plan renews on ${nextInvoiceDate} for ${priceLabel}`;

    const name = str`Subscription: ${planName}`;

    const ui = (
      <div style="max-width: 800px; margin: 0 auto; padding: 1.5rem; font-family: system-ui, -apple-system, sans-serif;">
        {/* Header */}
        <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 2rem; border-radius: 12px; margin-bottom: 1.5rem;">
          <h1 style="margin: 0 0 0.5rem 0; font-size: 1.75rem; font-weight: 600;">
            Subscription Billing
          </h1>
          <p style="margin: 0; font-size: 1rem; opacity: 0.95;">{summary}</p>
        </div>

        {/* Current Plan Details */}
        <div style="background: white; border: 1px solid #e2e8f0; border-radius: 8px; padding: 1.5rem; margin-bottom: 1.5rem;">
          <h2 style="margin: 0 0 1rem 0; font-size: 1.25rem; font-weight: 600; color: #1a202c;">
            Current Plan
          </h2>
          <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 1rem;">
            <div>
              <div style="font-size: 0.75rem; color: #718096; text-transform: uppercase; font-weight: 500; margin-bottom: 0.25rem;">
                Plan
              </div>
              <div style="font-size: 1.125rem; font-weight: 600; color: #2d3748;">
                {planName}
              </div>
            </div>
            <div>
              <div style="font-size: 0.75rem; color: #718096; text-transform: uppercase; font-weight: 500; margin-bottom: 0.25rem;">
                Price
              </div>
              <div style="font-size: 1.125rem; font-weight: 600; color: #2d3748;">
                {priceLabel}
              </div>
            </div>
            <div>
              <div style="font-size: 0.75rem; color: #718096; text-transform: uppercase; font-weight: 500; margin-bottom: 0.25rem;">
                Cycle
              </div>
              <div style="font-size: 1.125rem; font-weight: 600; color: #2d3748;">
                {cycleLabel}
              </div>
            </div>
          </div>
          <div style="margin-top: 1rem; padding-top: 1rem; border-top: 1px solid #e2e8f0;">
            <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 1rem;">
              <div>
                <div style="font-size: 0.75rem; color: #718096; text-transform: uppercase; font-weight: 500; margin-bottom: 0.25rem;">
                  Last Invoice
                </div>
                <div style="font-size: 1rem; font-family: monospace; color: #2d3748;">
                  {normalizedInvoice}
                </div>
              </div>
              <div>
                <div style="font-size: 0.75rem; color: #718096; text-transform: uppercase; font-weight: 500; margin-bottom: 0.25rem;">
                  Next Invoice
                </div>
                <div style="font-size: 1rem; font-family: monospace; color: #2d3748; font-weight: 600;">
                  {nextInvoiceDate}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Available Plans */}
        <div style="background: white; border: 1px solid #e2e8f0; border-radius: 8px; padding: 1.5rem; margin-bottom: 1.5rem;">
          <h2 style="margin: 0 0 1rem 0; font-size: 1.25rem; font-weight: 600; color: #1a202c;">
            Available Plans
          </h2>
          <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 1rem;">
            <div style="border: 2px solid #cbd5e0; border-radius: 8px; padding: 1rem; background: #f7fafc;">
              <div style="font-size: 1rem; font-weight: 600; color: #2d3748; margin-bottom: 0.5rem;">
                Starter
              </div>
              <div style="font-size: 1.5rem; font-weight: 700; color: #667eea; margin-bottom: 0.25rem;">
                $29
              </div>
              <div style="font-size: 0.875rem; color: #718096;">30 days</div>
            </div>
            <div style="border: 2px solid #cbd5e0; border-radius: 8px; padding: 1rem; background: #f7fafc;">
              <div style="font-size: 1rem; font-weight: 600; color: #2d3748; margin-bottom: 0.5rem;">
                Growth
              </div>
              <div style="font-size: 1.5rem; font-weight: 700; color: #667eea; margin-bottom: 0.25rem;">
                $59
              </div>
              <div style="font-size: 0.875rem; color: #718096;">30 days</div>
            </div>
            <div style="border: 2px solid #cbd5e0; border-radius: 8px; padding: 1rem; background: #f7fafc;">
              <div style="font-size: 1rem; font-weight: 600; color: #2d3748; margin-bottom: 0.5rem;">
                Enterprise
              </div>
              <div style="font-size: 1.5rem; font-weight: 700; color: #667eea; margin-bottom: 0.25rem;">
                $119
              </div>
              <div style="font-size: 0.875rem; color: #718096;">90 days</div>
            </div>
          </div>
        </div>

        {/* Change Plan */}
        <div style="background: white; border: 1px solid #e2e8f0; border-radius: 8px; padding: 1.5rem; margin-bottom: 1.5rem;">
          <h2 style="margin: 0 0 1rem 0; font-size: 1.25rem; font-weight: 600; color: #1a202c;">
            Change Plan
          </h2>
          <div style="display: grid; gap: 1rem;">
            <div>
              <label style="display: block; font-size: 0.875rem; font-weight: 500; color: #4a5568; margin-bottom: 0.5rem;">
                Plan (starter, growth, or enterprise)
              </label>
              <ct-input
                $value={planField}
                placeholder="e.g., growth"
                style="width: 100%; padding: 0.5rem; border: 1px solid #cbd5e0; border-radius: 6px; font-size: 0.875rem;"
              />
            </div>
            <div>
              <label style="display: block; font-size: 0.875rem; font-weight: 500; color: #4a5568; margin-bottom: 0.5rem;">
                Custom Cycle Days (optional)
              </label>
              <ct-input
                $value={cycleDaysField}
                placeholder="e.g., 60"
                style="width: 100%; padding: 0.5rem; border: 1px solid #cbd5e0; border-radius: 6px; font-size: 0.875rem;"
              />
            </div>
            <ct-button
              onClick={uiChangePlan({
                plan,
                cycleOverride,
                lastInvoice: lastInvoiceDate,
                history,
                planField,
                cycleDaysField,
              })}
              style="background: #667eea; color: white; padding: 0.75rem 1.5rem; border-radius: 6px; font-weight: 500; border: none; cursor: pointer;"
            >
              Change Plan
            </ct-button>
          </div>
        </div>

        {/* Record Invoice */}
        <div style="background: white; border: 1px solid #e2e8f0; border-radius: 8px; padding: 1.5rem; margin-bottom: 1.5rem;">
          <h2 style="margin: 0 0 1rem 0; font-size: 1.25rem; font-weight: 600; color: #1a202c;">
            Record Invoice
          </h2>
          <div style="display: grid; gap: 1rem;">
            <div>
              <label style="display: block; font-size: 0.875rem; font-weight: 500; color: #4a5568; margin-bottom: 0.5rem;">
                Invoice Date (YYYY-MM-DD)
              </label>
              <ct-input
                $value={invoiceDateField}
                placeholder="e.g., 2024-02-01"
                style="width: 100%; padding: 0.5rem; border: 1px solid #cbd5e0; border-radius: 6px; font-size: 0.875rem;"
              />
            </div>
            <ct-button
              onClick={uiRecordInvoice({
                plan,
                cycleOverride,
                lastInvoice: lastInvoiceDate,
                history,
                invoiceDateField,
              })}
              style="background: #48bb78; color: white; padding: 0.75rem 1.5rem; border-radius: 6px; font-weight: 500; border: none; cursor: pointer;"
            >
              Record Invoice
            </ct-button>
          </div>
        </div>

        {/* History */}
        {lift((hist: string[]) => {
          if (!hist || hist.length === 0) {
            return h(
              "div",
              {
                style:
                  "background: white; border: 1px solid #e2e8f0; border-radius: 8px; padding: 1.5rem;",
              },
              h("h2", {
                style:
                  "margin: 0 0 1rem 0; font-size: 1.25rem; font-weight: 600; color: #1a202c;",
              }, "History"),
              h(
                "p",
                { style: "color: #718096; font-style: italic;" },
                "No activity yet",
              ),
            );
          }

          const reversed = hist.slice().reverse();
          const recent = reversed.slice(0, 10);
          const historyItems = [];

          for (let i = 0; i < recent.length; i++) {
            const entry = recent[i];
            const bgColor = i % 2 === 0 ? "#ffffff" : "#f7fafc";
            const itemStyle =
              "padding: 0.75rem; border-left: 3px solid #667eea; background: " +
              bgColor + ";";
            historyItems.push(
              h(
                "div",
                { style: itemStyle },
                h(
                  "div",
                  { style: "font-size: 0.875rem; color: #2d3748;" },
                  entry,
                ),
              ),
            );
          }

          return h(
            "div",
            {
              style:
                "background: white; border: 1px solid #e2e8f0; border-radius: 8px; padding: 1.5rem;",
            },
            h("h2", {
              style:
                "margin: 0 0 1rem 0; font-size: 1.25rem; font-weight: 600; color: #1a202c;",
            }, "Recent Activity"),
            h("div", {
              style: "display: flex; flex-direction: column; gap: 0.5rem;",
            }, ...historyItems),
          );
        })(history)}
      </div>
    );

    return {
      [NAME]: name,
      [UI]: ui,
      planId: currentPlan,
      planName,
      planPrice: priceLabel,
      cycleDays,
      cycleLabel,
      lastInvoiceDate: normalizedInvoice,
      nextInvoiceDate,
      summary,
      history,
      changePlan: changePlan({
        plan,
        cycleOverride,
        lastInvoice: lastInvoiceDate,
        history,
      }),
      recordInvoice: recordInvoice({
        plan,
        cycleOverride,
        lastInvoice: lastInvoiceDate,
        history,
      }),
    };
  },
);
