/// <cts-enable />
// @ts-nocheck
import {
  type Cell,
  cell,
  compute,
  Default,
  derive,
  h,
  handler,
  ifElse,
  lift,
  NAME,
  recipe,
  str,
  UI,
} from "commontools";

interface BudgetCategoryInput {
  name?: string;
  target?: number;
  allocation?: number;
}

interface BudgetCategoryCatalog {
  id: string;
  name: string;
  target: number;
}

interface CategoryProjection extends BudgetCategoryCatalog {
  allocation: number;
  variance: number;
  share: number;
}

interface AllocationRecord {
  [categoryId: string]: number;
}

interface AllocationEvent {
  category?: string;
  amount?: number;
}

interface RebalanceEvent {
  mode?: "targets" | "even";
}

interface BudgetSummary {
  allocations: AllocationRecord;
  categories: CategoryProjection[];
  totalAllocated: number;
  remaining: number;
  overflow: number;
}

interface BudgetPlannerArgs {
  total: Default<number, typeof defaultTotalBudget>;
  categories: Default<BudgetCategoryInput[], typeof defaultCategories>;
}

const defaultTotalBudget = 4000;

const defaultCategories: BudgetCategoryInput[] = [
  { name: "Housing", target: 1800 },
  { name: "Food", target: 600 },
  { name: "Transportation", target: 400 },
  { name: "Savings", target: 800 },
  { name: "Leisure", target: 400 },
];

const roundCurrency = (value: number): number => {
  return Math.round(value * 100) / 100;
};

const sanitizeTotalBudget = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return defaultTotalBudget;
  }
  const rounded = roundCurrency(value);
  return rounded > 0 ? rounded : defaultTotalBudget;
};

const sanitizeAmount = (value: unknown, fallback: number): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return roundCurrency(Math.max(fallback, 0));
  }
  return roundCurrency(Math.max(value, 0));
};

const normalizeName = (value: unknown, fallback: string): string => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return fallback;
};

const slugifyName = (value: string, fallback: string): string => {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : fallback;
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

const sanitizeCategoryList = (
  input: readonly BudgetCategoryInput[] | undefined,
  total: number,
): { catalog: BudgetCategoryCatalog[]; allocations: AllocationRecord } => {
  const source = Array.isArray(input) ? input : defaultCategories;
  const sanitizedCatalog: BudgetCategoryCatalog[] = [];
  const allocations: AllocationRecord = {};
  const usedIds = new Set<string>();
  const entries = source.filter((entry) =>
    typeof entry?.name === "string" || typeof entry?.target === "number"
  );
  const fallbackList = entries.length > 0 ? entries : defaultCategories;
  const fallbackTarget = fallbackList.length > 0
    ? roundCurrency(total / fallbackList.length)
    : roundCurrency(total);

  let remaining = roundCurrency(Math.max(total, 0));

  for (let index = 0; index < fallbackList.length; index++) {
    const raw = fallbackList[index];
    const fallbackName = defaultCategories[index]?.name ??
      `Category ${index + 1}`;
    const normalizedName = normalizeName(raw?.name, fallbackName);
    const fallbackId = slugifyName(fallbackName, `category-${index + 1}`);
    const id = ensureUniqueId(
      slugifyName(normalizedName, fallbackId),
      usedIds,
      fallbackId,
    );
    const targetFallback = defaultCategories[index]?.target ?? fallbackTarget;
    const target = sanitizeAmount(raw?.target, targetFallback);
    const desiredAllocation = sanitizeAmount(raw?.allocation, 0);
    const allocation = Math.min(desiredAllocation, remaining);
    const rounded = roundCurrency(allocation);
    remaining = roundCurrency(remaining - rounded);
    sanitizedCatalog.push({ id, name: normalizedName, target });
    allocations[id] = rounded;
  }

  if (sanitizedCatalog.length === 0) {
    return sanitizeCategoryList(defaultCategories, total);
  }

  return { catalog: sanitizedCatalog, allocations };
};

const enforceAllocationLimits = (
  raw: AllocationRecord | undefined,
  catalog: readonly BudgetCategoryCatalog[],
  total: number,
): BudgetSummary => {
  const record = raw ?? {};
  const sanitized: AllocationRecord = {};
  const normalizedTotal = roundCurrency(Math.max(total, 0));
  let remaining = normalizedTotal;
  let overflow = 0;

  for (const category of catalog) {
    const desired = sanitizeAmount(record[category.id], 0);
    if (desired > remaining) {
      overflow = roundCurrency(overflow + desired - remaining);
    }
    const applied = Math.min(desired, remaining);
    const rounded = roundCurrency(applied);
    remaining = roundCurrency(remaining - rounded);
    sanitized[category.id] = rounded;
  }

  for (const key of Object.keys(record)) {
    if (catalog.some((category) => category.id === key)) continue;
    overflow = roundCurrency(overflow + sanitizeAmount(record[key], 0));
  }

  const allocatedTotal = roundCurrency(normalizedTotal - remaining);
  const projections: CategoryProjection[] = catalog.map((category) => {
    const allocation = sanitized[category.id] ?? 0;
    const variance = roundCurrency(allocation - category.target);
    const share = normalizedTotal > 0
      ? Math.round((allocation / normalizedTotal) * 1000) / 10
      : 0;
    return {
      id: category.id,
      name: category.name,
      target: category.target,
      allocation,
      variance,
      share,
    };
  });

  return {
    allocations: sanitized,
    categories: projections,
    totalAllocated: allocatedTotal,
    remaining,
    overflow,
  };
};

const computeTargetAllocations = (
  catalog: readonly BudgetCategoryCatalog[],
  total: number,
): AllocationRecord => {
  if (catalog.length === 0) return {};
  const normalizedTotal = roundCurrency(Math.max(total, 0));
  const targets = catalog.map((entry) => sanitizeAmount(entry.target, 0));
  const targetSum = targets.reduce((sum, value) => sum + value, 0);
  const allocations: AllocationRecord = {};
  let remaining = normalizedTotal;

  if (targetSum <= 0) {
    return computeEvenAllocations(catalog, normalizedTotal);
  }

  for (let index = 0; index < catalog.length; index++) {
    const isLast = index === catalog.length - 1;
    const ratio = targets[index] / targetSum;
    const desired = roundCurrency(normalizedTotal * ratio);
    const applied = isLast ? remaining : Math.min(desired, remaining);
    const rounded = roundCurrency(applied);
    remaining = roundCurrency(remaining - rounded);
    allocations[catalog[index].id] = rounded;
  }

  return allocations;
};

const computeEvenAllocations = (
  catalog: readonly BudgetCategoryCatalog[],
  total: number,
): AllocationRecord => {
  if (catalog.length === 0) return {};
  const normalizedTotal = roundCurrency(Math.max(total, 0));
  const allocations: AllocationRecord = {};
  const evenShare = normalizedTotal > 0
    ? roundCurrency(normalizedTotal / catalog.length)
    : 0;
  let remaining = normalizedTotal;

  for (let index = 0; index < catalog.length; index++) {
    const isLast = index === catalog.length - 1;
    const desired = isLast ? remaining : Math.min(evenShare, remaining);
    const rounded = roundCurrency(desired);
    remaining = roundCurrency(remaining - rounded);
    allocations[catalog[index].id] = rounded;
  }

  return allocations;
};

const resetAllocationsForCatalog = (
  catalog: readonly BudgetCategoryCatalog[],
): AllocationRecord => {
  const reset: AllocationRecord = {};
  for (const category of catalog) {
    reset[category.id] = 0;
  }
  return reset;
};

const formatAmount = (value: number): string => {
  return `$${value.toFixed(2)}`;
};

const appendHistory = (history: Cell<string[]>, entry: string) => {
  const previous = history.get();
  const list = Array.isArray(previous) ? previous.slice() : [];
  list.push(entry);
  const trimmed = list.length > 6 ? list.slice(-6) : list;
  history.set(trimmed);
};

const resolveCategoryId = (
  identifier: string | undefined,
  catalog: readonly BudgetCategoryCatalog[],
): BudgetCategoryCatalog | null => {
  if (!identifier) return null;
  const normalized = identifier.trim().toLowerCase();
  for (const category of catalog) {
    if (category.id === normalized) return category;
    if (category.name.toLowerCase() === normalized) return category;
  }
  return null;
};

const updateAllocation = handler(
  (
    event: AllocationEvent | undefined,
    context: {
      overrides: Cell<AllocationRecord | null>;
      base: Cell<{
        catalog: BudgetCategoryCatalog[];
        allocations: AllocationRecord;
      }>;
      total: Cell<number>;
      history: Cell<string[]>;
      lastAction: Cell<string>;
      sequence: Cell<number>;
    },
  ) => {
    const baseState = context.base.get();
    const catalog = baseState.catalog;
    const total = sanitizeTotalBudget(context.total.get());

    const targetCategory = resolveCategoryId(event?.category, catalog);
    if (!targetCategory) {
      const message = "Ignored allocation update for unknown category";
      context.lastAction.set(message);
      appendHistory(context.history, message);
      return;
    }

    const desired = sanitizeAmount(event?.amount, 0);
    const overrides = context.overrides.get();
    const currentAllocations = overrides
      ? { ...overrides }
      : { ...baseState.allocations };
    const previous = currentAllocations[targetCategory.id] ?? 0;
    let otherTotal = 0;
    for (const [id, amount] of Object.entries(currentAllocations)) {
      if (id === targetCategory.id) continue;
      otherTotal = roundCurrency(otherTotal + amount);
    }
    const available = Math.max(roundCurrency(total - otherTotal), 0);
    const capped = Math.min(desired, available);
    currentAllocations[targetCategory.id] = roundCurrency(capped);
    const enforced = enforceAllocationLimits(
      currentAllocations,
      catalog,
      total,
    );
    context.overrides.set(enforced.allocations);

    const applied = enforced.allocations[targetCategory.id] ?? 0;
    const delta = roundCurrency(applied - previous);
    const remaining = enforced.remaining;
    const message =
      `Allocated ${formatAmount(applied)} to ${targetCategory.name} ` +
      `(change ${formatAmount(delta)}). Remaining ` +
      formatAmount(remaining);

    context.lastAction.set(message);
    appendHistory(context.history, message);

    const sequence = (context.sequence.get() ?? 0) + 1;
    context.sequence.set(sequence);
  },
);

const rebalanceAllocations = handler(
  (
    event: RebalanceEvent | undefined,
    context: {
      overrides: Cell<AllocationRecord | null>;
      base: Cell<{
        catalog: BudgetCategoryCatalog[];
        allocations: AllocationRecord;
      }>;
      total: Cell<number>;
      history: Cell<string[]>;
      lastAction: Cell<string>;
      sequence: Cell<number>;
    },
  ) => {
    const baseState = context.base.get();
    const catalog = baseState.catalog;
    const total = sanitizeTotalBudget(context.total.get());
    const draft = event?.mode === "even"
      ? computeEvenAllocations(catalog, total)
      : computeTargetAllocations(catalog, total);

    const applied = enforceAllocationLimits(draft, catalog, total);
    context.overrides.set(applied.allocations);
    const mode = event?.mode === "even" ? "even" : "target";
    const message = mode === "even"
      ? "Distributed budget evenly across categories"
      : "Distributed budget using target proportions";

    context.lastAction.set(message);
    appendHistory(context.history, message);

    const sequence = (context.sequence.get() ?? 0) + 1;
    context.sequence.set(sequence);
  },
);

const resetAllocations = handler(
  (
    _event: undefined,
    context: {
      overrides: Cell<AllocationRecord | null>;
      base: Cell<{
        catalog: BudgetCategoryCatalog[];
        allocations: AllocationRecord;
      }>;
      total: Cell<number>;
      history: Cell<string[]>;
      lastAction: Cell<string>;
      sequence: Cell<number>;
    },
  ) => {
    const baseState = context.base.get();
    const catalog = baseState.catalog;
    const total = sanitizeTotalBudget(context.total.get());
    const resetMap = resetAllocationsForCatalog(catalog);
    const applied = enforceAllocationLimits(resetMap, catalog, total);
    context.overrides.set(applied.allocations);
    const message = "Reset all allocations to $0.00";
    context.lastAction.set(message);
    appendHistory(context.history, message);
    const sequence = (context.sequence.get() ?? 0) + 1;
    context.sequence.set(sequence);
  },
);

export const budgetPlannerUx = recipe<BudgetPlannerArgs>(
  "Budget Planner (UX)",
  ({ total, categories }) => {
    const sanitizedTotal = lift((value: number | undefined) =>
      sanitizeTotalBudget(value)
    )(total);

    const baseState = lift(
      (
        { categories, total }: {
          categories: BudgetCategoryInput[];
          total: number;
        },
      ) => sanitizeCategoryList(categories, total),
    )({ categories, total: sanitizedTotal });

    const categoryCatalog = derive(baseState, (state) => state.catalog);
    const baseAllocations = derive(baseState, (state) => state.allocations);
    const overrides = cell<AllocationRecord | null>(null);
    const history = cell<string[]>(["Budget initialized"]);
    const lastAction = cell("Budget initialized");
    const sequence = cell(0);

    const summary = lift(
      (
        { total, base, overrides }: {
          total: number;
          base: {
            catalog: BudgetCategoryCatalog[];
            allocations: AllocationRecord;
          };
          overrides: AllocationRecord | null;
        },
      ) => {
        const active = overrides ?? base.allocations;
        return enforceAllocationLimits(
          active,
          base.catalog,
          sanitizeTotalBudget(total),
        );
      },
    )({ total: sanitizedTotal, base: baseState, overrides });

    const categorySummary = derive(summary, (state) => state.categories);
    const allocationView = derive(summary, (state) => state.allocations);
    const allocatedTotal = derive(summary, (state) => state.totalAllocated);
    const remainingBudget = derive(summary, (state) => state.remaining);
    const overflowAmount = derive(summary, (state) => state.overflow);
    const balanced = derive(
      summary,
      (state) => state.remaining <= 0.01 && state.overflow === 0,
    );

    const summaryLabel = lift(
      ({ total, summary }: { total: number; summary: BudgetSummary }) => {
        const totalValue = sanitizeTotalBudget(total);
        return `Allocated ${formatAmount(summary.totalAllocated)} of ` +
          `${formatAmount(totalValue)} (${formatAmount(summary.remaining)} ` +
          "remaining)";
      },
    )({ total: sanitizedTotal, summary });

    const statusMessage = lift((state: BudgetSummary) => {
      if (state.remaining <= 0.01) {
        return "Budget balanced";
      }
      return `Remaining allocation ${formatAmount(state.remaining)}`;
    })(summary);

    const historyView = lift((entries: string[] | undefined) =>
      Array.isArray(entries) ? entries.slice() : []
    )(history);

    // UI state
    const categoryField = cell<string>("");
    const amountField = cell<string>("0");

    const applyAllocation = handler<
      unknown,
      {
        categoryField: Cell<string>;
        amountField: Cell<string>;
        overrides: Cell<AllocationRecord | null>;
        base: Cell<{
          catalog: BudgetCategoryCatalog[];
          allocations: AllocationRecord;
        }>;
        total: Cell<number>;
        history: Cell<string[]>;
        lastAction: Cell<string>;
        sequence: Cell<number>;
      }
    >(
      (
        _event,
        {
          categoryField,
          amountField,
          overrides,
          base,
          total,
          history,
          lastAction,
          sequence,
        },
      ) => {
        const categoryInput = categoryField.get();
        const amountInput = amountField.get();
        const parsed = Number(amountInput);
        const amount = sanitizeAmount(parsed, 0);

        const baseState = base.get();
        const catalog = baseState.catalog;
        const totalValue = sanitizeTotalBudget(total.get());

        const targetCategory = resolveCategoryId(categoryInput, catalog);
        if (!targetCategory) {
          const message = "Please select a valid category";
          lastAction.set(message);
          appendHistory(history, message);
          return;
        }

        const currentOverrides = overrides.get();
        const currentAllocations = currentOverrides
          ? { ...currentOverrides }
          : { ...baseState.allocations };
        const previous = currentAllocations[targetCategory.id] ?? 0;
        let otherTotal = 0;
        for (const [id, amt] of Object.entries(currentAllocations)) {
          if (id === targetCategory.id) continue;
          otherTotal = roundCurrency(otherTotal + amt);
        }
        const available = Math.max(roundCurrency(totalValue - otherTotal), 0);
        const capped = Math.min(amount, available);
        currentAllocations[targetCategory.id] = roundCurrency(capped);
        const enforced = enforceAllocationLimits(
          currentAllocations,
          catalog,
          totalValue,
        );
        overrides.set(enforced.allocations);

        const applied = enforced.allocations[targetCategory.id] ?? 0;
        const delta = roundCurrency(applied - previous);
        const remaining = enforced.remaining;
        const message =
          `Allocated ${formatAmount(applied)} to ${targetCategory.name} ` +
          `(change ${formatAmount(delta)}). Remaining ` +
          formatAmount(remaining);

        lastAction.set(message);
        appendHistory(history, message);

        const seq = (sequence.get() ?? 0) + 1;
        sequence.set(seq);
      },
    )({
      categoryField,
      amountField,
      overrides,
      base: baseState,
      total: sanitizedTotal,
      history,
      lastAction,
      sequence,
    });

    const applyRebalanceTargets = handler<
      unknown,
      {
        overrides: Cell<AllocationRecord | null>;
        base: Cell<{
          catalog: BudgetCategoryCatalog[];
          allocations: AllocationRecord;
        }>;
        total: Cell<number>;
        history: Cell<string[]>;
        lastAction: Cell<string>;
        sequence: Cell<number>;
      }
    >(
      (_event, { overrides, base, total, history, lastAction, sequence }) => {
        const baseState = base.get();
        const catalog = baseState.catalog;
        const totalValue = sanitizeTotalBudget(total.get());
        const draft = computeTargetAllocations(catalog, totalValue);

        const applied = enforceAllocationLimits(draft, catalog, totalValue);
        overrides.set(applied.allocations);
        const message = "Distributed budget using target proportions";

        lastAction.set(message);
        appendHistory(history, message);

        const seq = (sequence.get() ?? 0) + 1;
        sequence.set(seq);
      },
    )({
      overrides,
      base: baseState,
      total: sanitizedTotal,
      history,
      lastAction,
      sequence,
    });

    const applyRebalanceEven = handler<
      unknown,
      {
        overrides: Cell<AllocationRecord | null>;
        base: Cell<{
          catalog: BudgetCategoryCatalog[];
          allocations: AllocationRecord;
        }>;
        total: Cell<number>;
        history: Cell<string[]>;
        lastAction: Cell<string>;
        sequence: Cell<number>;
      }
    >(
      (_event, { overrides, base, total, history, lastAction, sequence }) => {
        const baseState = base.get();
        const catalog = baseState.catalog;
        const totalValue = sanitizeTotalBudget(total.get());
        const draft = computeEvenAllocations(catalog, totalValue);

        const applied = enforceAllocationLimits(draft, catalog, totalValue);
        overrides.set(applied.allocations);
        const message = "Distributed budget evenly across categories";

        lastAction.set(message);
        appendHistory(history, message);

        const seq = (sequence.get() ?? 0) + 1;
        sequence.set(seq);
      },
    )({
      overrides,
      base: baseState,
      total: sanitizedTotal,
      history,
      lastAction,
      sequence,
    });

    const applyReset = handler<
      unknown,
      {
        overrides: Cell<AllocationRecord | null>;
        base: Cell<{
          catalog: BudgetCategoryCatalog[];
          allocations: AllocationRecord;
        }>;
        total: Cell<number>;
        history: Cell<string[]>;
        lastAction: Cell<string>;
        sequence: Cell<number>;
      }
    >(
      (_event, { overrides, base, total, history, lastAction, sequence }) => {
        const baseState = base.get();
        const catalog = baseState.catalog;
        const totalValue = sanitizeTotalBudget(total.get());
        const resetMap = resetAllocationsForCatalog(catalog);
        const applied = enforceAllocationLimits(
          resetMap,
          catalog,
          totalValue,
        );
        overrides.set(applied.allocations);
        const message = "Reset all allocations to $0.00";
        lastAction.set(message);
        appendHistory(history, message);
        const seq = (sequence.get() ?? 0) + 1;
        sequence.set(seq);
      },
    )({
      overrides,
      base: baseState,
      total: sanitizedTotal,
      history,
      lastAction,
      sequence,
    });

    const name = lift(
      ({ total, remaining }: { total: number; remaining: number }) =>
        `Budget Planner ($${formatAmount(total - remaining)} / ${
          formatAmount(total)
        })`,
    )({ total: sanitizedTotal, remaining: remainingBudget });

    const categoriesDisplay = lift(
      (categories: CategoryProjection[]) => {
        return categories.map((cat) => {
          const varianceColor = cat.variance < 0
            ? "#dc2626"
            : cat.variance > 0
            ? "#16a34a"
            : "#64748b";
          const progressPercent = cat.target > 0
            ? (cat.allocation / cat.target * 100).toFixed(1)
            : 0;
          const progressColor = cat.allocation >= cat.target
            ? "#16a34a"
            : cat.allocation > 0
            ? "#3b82f6"
            : "#94a3b8";

          return (
            <div
              key={cat.id}
              style="
              background: #ffffff;
              border: 1px solid #e2e8f0;
              border-radius: 0.5rem;
              padding: 1rem;
              display: flex;
              flex-direction: column;
              gap: 0.5rem;
            "
            >
              <div style="
                display: flex;
                justify-content: space-between;
                align-items: baseline;
              ">
                <strong style="font-size: 0.95rem; color: #0f172a;">
                  {cat.name}
                </strong>
                <span style="font-size: 0.8rem; color: #64748b;">
                  {cat.share.toFixed(1)}%
                </span>
              </div>
              <div style="
                display: flex;
                flex-direction: column;
                gap: 0.25rem;
                font-size: 0.85rem;
              ">
                <div style="
                  display: flex;
                  justify-content: space-between;
                  color: #475569;
                ">
                  <span>Target:</span>
                  <span>{formatAmount(cat.target)}</span>
                </div>
                <div style="
                  display: flex;
                  justify-content: space-between;
                  color: #0f172a;
                  font-weight: 500;
                ">
                  <span>Allocated:</span>
                  <span>{formatAmount(cat.allocation)}</span>
                </div>
                <div
                  style={"display: flex; justify-content: space-between; color: " +
                    varianceColor + ";"}
                >
                  <span>Variance:</span>
                  <span>
                    {cat.variance > 0 ? "+" : ""}
                    {formatAmount(cat.variance)}
                  </span>
                </div>
              </div>
              <div style="
                position: relative;
                height: 0.375rem;
                background: #e2e8f0;
                border-radius: 0.25rem;
                overflow: hidden;
                margin-top: 0.25rem;
              ">
                <div
                  style={"position: absolute; left: 0; top: 0; bottom: 0; width: " +
                    progressPercent +
                    "%; background: " +
                    progressColor +
                    "; border-radius: 0.25rem; transition: width 0.2s ease;"}
                >
                </div>
              </div>
            </div>
          );
        });
      },
    )(categorySummary);

    const historyDisplay = lift((entries: string[]) => {
      if (entries.length === 0) {
        return (
          <div style="color: #94a3b8; font-style: italic;">
            No actions yet
          </div>
        );
      }
      return entries.slice().reverse().map((entry, index) => (
        <div
          key={index}
          style="
            padding: 0.5rem;
            background: #f8fafc;
            border-radius: 0.375rem;
            font-size: 0.85rem;
            color: #475569;
          "
        >
          {entry}
        </div>
      ));
    })(historyView);

    const budgetStatusStyle = lift(
      ({ remaining, balanced }: { remaining: number; balanced: boolean }) => {
        if (balanced) {
          return "background: linear-gradient(135deg, #dcfce7, #bbf7d0); border: 2px solid #16a34a;";
        }
        if (remaining > 0) {
          return "background: linear-gradient(135deg, #fef3c7, #fde68a); border: 2px solid #f59e0b;";
        }
        return "background: linear-gradient(135deg, #f1f5f9, #e2e8f0); border: 2px solid #94a3b8;";
      },
    )({ remaining: remainingBudget, balanced });

    return {
      [NAME]: name,
      [UI]: (
        <div style="
            display: flex;
            flex-direction: column;
            gap: 1.5rem;
            max-width: 48rem;
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
                  Monthly Budget Manager
                </span>
                <h2 style="
                    margin: 0;
                    font-size: 1.3rem;
                    color: #0f172a;
                  ">
                  Allocate funds across categories
                </h2>
              </div>

              <div
                style={lift(
                  (statusStyle: string) =>
                    "padding: 1.25rem; border-radius: 0.75rem; display: flex; justify-content: space-between; align-items: center; gap: 1rem; " +
                    statusStyle,
                )(budgetStatusStyle)}
              >
                <div style="
                    display: flex;
                    flex-direction: column;
                    gap: 0.25rem;
                  ">
                  <span style="font-size: 0.8rem; color: #475569;">
                    Total Budget
                  </span>
                  <strong style="font-size: 2rem; color: #0f172a;">
                    {lift((total: number) => formatAmount(total))(
                      sanitizedTotal,
                    )}
                  </strong>
                </div>
                <div style="
                    display: flex;
                    flex-direction: column;
                    gap: 0.25rem;
                    align-items: flex-end;
                  ">
                  <span style="font-size: 0.8rem; color: #475569;">
                    Remaining
                  </span>
                  <strong style="font-size: 1.5rem; color: #0f172a;">
                    {lift((remaining: number) => formatAmount(remaining))(
                      remainingBudget,
                    )}
                  </strong>
                </div>
              </div>

              <div style="
                  display: flex;
                  flex-direction: column;
                  gap: 0.5rem;
                ">
                <h3 style="
                    margin: 0;
                    font-size: 0.9rem;
                    color: #475569;
                    text-transform: uppercase;
                    letter-spacing: 0.05em;
                  ">
                  Budget Categories
                </h3>
                <div style="
                    display: grid;
                    grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
                    gap: 0.75rem;
                  ">
                  {categoriesDisplay}
                </div>
              </div>
            </div>
          </ct-card>

          <ct-card>
            <div slot="header">
              <h3 style="margin: 0; font-size: 1rem; color: #0f172a;">
                Allocation Controls
              </h3>
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
                  display: grid;
                  grid-template-columns: 2fr 1fr auto;
                  gap: 0.75rem;
                  align-items: flex-end;
                ">
                <div style="
                    display: flex;
                    flex-direction: column;
                    gap: 0.4rem;
                  ">
                  <label
                    for="category-select"
                    style="
                      font-size: 0.85rem;
                      font-weight: 500;
                      color: #334155;
                    "
                  >
                    Category
                  </label>
                  <ct-input
                    id="category-select"
                    placeholder="housing, food, etc."
                    $value={categoryField}
                    aria-label="Select category to allocate funds"
                  >
                  </ct-input>
                </div>
                <div style="
                    display: flex;
                    flex-direction: column;
                    gap: 0.4rem;
                  ">
                  <label
                    for="amount-input"
                    style="
                      font-size: 0.85rem;
                      font-weight: 500;
                      color: #334155;
                    "
                  >
                    Amount
                  </label>
                  <ct-input
                    id="amount-input"
                    type="number"
                    step="0.01"
                    min="0"
                    placeholder="0.00"
                    $value={amountField}
                    aria-label="Enter allocation amount"
                  >
                  </ct-input>
                </div>
                <ct-button
                  id="allocate-button"
                  onClick={applyAllocation}
                  aria-label="Apply allocation"
                >
                  Allocate
                </ct-button>
              </div>

              <div style="
                  display: flex;
                  gap: 0.5rem;
                  flex-wrap: wrap;
                ">
                <ct-button
                  id="balance-targets-button"
                  variant="secondary"
                  onClick={applyRebalanceTargets}
                  aria-label="Distribute budget by target proportions"
                >
                  Balance by Targets
                </ct-button>
                <ct-button
                  id="balance-evenly-button"
                  variant="secondary"
                  onClick={applyRebalanceEven}
                  aria-label="Distribute budget evenly"
                >
                  Balance Evenly
                </ct-button>
                <ct-button
                  id="reset-all-button"
                  variant="secondary"
                  onClick={applyReset}
                  aria-label="Reset all allocations"
                >
                  Reset All
                </ct-button>
              </div>
            </div>
          </ct-card>

          <ct-card>
            <div slot="header">
              <h3 style="margin: 0; font-size: 1rem; color: #0f172a;">
                Recent Actions
              </h3>
            </div>
            <div
              slot="content"
              style="
                display: flex;
                flex-direction: column;
                gap: 0.5rem;
                max-height: 200px;
                overflow-y: auto;
              "
            >
              {historyDisplay}
            </div>
          </ct-card>

          <div
            role="status"
            aria-live="polite"
            data-testid="status"
            style="
              font-size: 0.85rem;
              color: #475569;
              text-align: center;
            "
          >
            {statusMessage}
          </div>
        </div>
      ),
      totalBudget: sanitizedTotal,
      categoryCatalog,
      categorySummary,
      allocations: allocationView,
      allocatedTotal,
      remainingBudget,
      overflowAmount,
      balanced,
      summaryLabel,
      statusMessage,
      lastAction,
      history: historyView,
      allocate: updateAllocation({
        total: sanitizedTotal,
        base: baseState,
        overrides,
        history,
        lastAction,
        sequence,
      }),
      rebalance: rebalanceAllocations({
        total: sanitizedTotal,
        base: baseState,
        overrides,
        history,
        lastAction,
        sequence,
      }),
      reset: resetAllocations({
        overrides,
        base: baseState,
        total: sanitizedTotal,
        history,
        lastAction,
        sequence,
      }),
      uiControls: {
        categoryField,
        amountField,
        applyAllocation,
        applyRebalanceTargets,
        applyRebalanceEven,
        applyReset,
      },
    };
  },
);

export default budgetPlannerUx;
