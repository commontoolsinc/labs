/// <cts-enable />
/**
 * Budget Tracker - Data View Sub-Pattern
 *
 * Displays expense data and computed budget status.
 * No mutations - this is a read-only view.
 *
 * Can be deployed standalone for testing computed values,
 * or composed into a larger pattern.
 */
import {
  Cell,
  computed,
  ifElse,
  NAME,
  pattern,
  UI,
} from "commontools";
import {
  type BudgetStatusItem,
  type CategoryBudget,
  type Expense,
  getTodayDate,
} from "./schemas.tsx";

// ============ INPUT/OUTPUT TYPES ============

// Sub-patterns don't use Default<> - the parent pattern owns initialization
interface Input {
  expenses: Cell<Expense[]>;
  budgets: Cell<CategoryBudget[]>;
}

interface Output {
  // Don't re-export shared cells - parent owns them
  totalSpent: number;
  spentByCategory: Record<string, number>;
  budgetStatus: BudgetStatusItem[];
}

// ============ PATTERN ============

export default pattern<Input, Output>(({ expenses, budgets }) => {
  const todayDate = getTodayDate();

  // Computed values - use .get() to access array values inside computed()
  const totalSpent = computed(() => {
    const exp = expenses.get();
    return exp.reduce((sum, e) => sum + (e.amount || 0), 0);
  });

  const spentByCategory = computed(() => {
    const exp = expenses.get();
    const result: Record<string, number> = {};
    for (const expense of exp) {
      const cat = expense.category || "Other";
      result[cat] = (result[cat] || 0) + (expense.amount || 0);
    }
    return result;
  });

  const budgetStatus = computed((): BudgetStatusItem[] => {
    const spent = spentByCategory;
    const budgetList = budgets.get();

    // Get all categories (from spending + budgets)
    const allCategories = new Set<string>(Object.keys(spent));
    for (const b of budgetList) {
      allCategories.add(b.category);
    }

    const budgetMap = new Map<string, number>();
    for (const b of budgetList) {
      budgetMap.set(b.category, b.limit);
    }

    return Array.from(allCategories)
      .sort()
      .map((category) => {
        const categorySpent = spent[category] || 0;
        const limit = budgetMap.get(category) ?? null;
        const remaining = limit !== null ? limit - categorySpent : null;
        const percentUsed =
          limit !== null && limit > 0 ? (categorySpent / limit) * 100 : null;

        return { category, spent: categorySpent, limit, remaining, percentUsed };
      });
  });

  const expenseCount = computed(() => expenses.get().length);

  return {
    [NAME]: "Budget Data View",
    [UI]: (
      <div style={{ fontFamily: "system-ui", padding: "1rem" }}>
        <h3 style={{ margin: "0 0 0.5rem 0" }}>Budget Summary</h3>
        <div style={{ marginBottom: "1rem", color: "#666" }}>
          <div>Date: {todayDate}</div>
          <div>Expenses: {expenseCount}</div>
          <div>Total Spent: ${computed(() => totalSpent.toFixed(2))}</div>
        </div>

        {/* Budget Status Display */}
        <div style={{ marginBottom: "1rem" }}>
          <h4 style={{ margin: "0 0 0.5rem 0" }}>By Category</h4>
          {budgetStatus.map((status) => (
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                padding: "0.5rem",
                borderBottom: "1px solid #eee",
              }}
            >
              <span>{status.category}</span>
              <span>
                ${status.spent}
                {ifElse(
                  computed(() => status.limit !== null),
                  <span style={{ color: "#666" }}>
                    {" "}/ ${status.limit} ({status.percentUsed}%)
                  </span>,
                  null
                )}
              </span>
            </div>
          ))}
        </div>

        {/* Debug Panel */}
        <details>
          <summary style={{ cursor: "pointer", color: "#666" }}>
            Debug: Raw Data
          </summary>
          <pre
            style={{
              fontSize: "11px",
              background: "#f5f5f5",
              padding: "0.5rem",
              overflow: "auto",
            }}
          >
            {computed(() => JSON.stringify({ expenses: expenses.get(), budgets: budgets.get() }, null, 2))}
          </pre>
        </details>
      </div>
    ),

    // Export computed values only (not shared cells - those are owned by parent)
    totalSpent,
    spentByCategory,
    budgetStatus,
  };
});
