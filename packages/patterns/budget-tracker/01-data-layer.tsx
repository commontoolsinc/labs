/// <cts-enable />
/**
 * Budget Tracker - Layer 1: Data Model + Computed Values
 *
 * This layer establishes:
 * - Expense and budget schemas
 * - Computed totals and category breakdowns
 * - Debug UI to verify reactivity
 *
 * Test via CLI before moving to Layer 2.
 */
import {
  Cell,
  computed,
  Default,
  NAME,
  pattern,
  UI,
} from "commontools";

// ============ SCHEMAS ============

interface Expense {
  description: string;
  amount: number;
  category: Default<string, "Other">;
  date: string; // YYYY-MM-DD
}

interface CategoryBudget {
  category: string;
  limit: number;
}

interface Input {
  expenses: Cell<Default<Expense[], []>>;
  budgets: Cell<Default<CategoryBudget[], []>>;
}

interface Output {
  expenses: Expense[];
  budgets: CategoryBudget[];
  totalSpent: number;
  spentByCategory: Record<string, number>;
  budgetStatus: Array<{
    category: string;
    spent: number;
    limit: number | null;
    remaining: number | null;
    percentUsed: number | null;
  }>;
}

// ============ HELPER FUNCTIONS ============

const getTodayDate = (): string => {
  return new Date().toISOString().split("T")[0];
};

// ============ PATTERN ============

export default pattern<Input, Output>(({ expenses, budgets }) => {
  const todayDate = getTodayDate();

  // Computed values - use computed() for reactive transformations
  const totalSpent = computed(() => {
    const exp = expenses.get();
    if (!Array.isArray(exp)) return 0;
    return exp.reduce((sum, e) => sum + (e.amount || 0), 0);
  });

  const spentByCategory = computed(() => {
    const exp = expenses.get();
    if (!Array.isArray(exp)) return {};
    const result: Record<string, number> = {};
    for (const expense of exp) {
      const cat = expense.category || "Other";
      result[cat] = (result[cat] || 0) + (expense.amount || 0);
    }
    return result;
  });

  const budgetStatus = computed(() => {
    const spent = spentByCategory;
    const budgetList = budgets.get();
    if (!spent || typeof spent !== "object") return [];

    // Get all categories (from spending + budgets)
    const allCategories = new Set<string>(Object.keys(spent));
    if (Array.isArray(budgetList)) {
      for (const b of budgetList) {
        allCategories.add(b.category);
      }
    }

    const budgetMap = new Map<string, number>();
    if (Array.isArray(budgetList)) {
      for (const b of budgetList) {
        budgetMap.set(b.category, b.limit);
      }
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

  // Derived computeds for display
  const expenseCount = computed(() => expenses.get().length);
  const categoryCount = computed(() => Object.keys(spentByCategory).length);

  return {
    [NAME]: "Budget Tracker",
    [UI]: (
      <div style={{ fontFamily: "system-ui", padding: "1rem" }}>
        <h2 style={{ margin: "0 0 1rem 0" }}>Budget Tracker - Data Layer</h2>
        <p style={{ color: "#666", marginBottom: "1rem" }}>
          Debug UI - verify computed values update reactively
        </p>

        {/* Debug Panel */}
        <div
          style={{
            fontFamily: "monospace",
            fontSize: "12px",
            padding: "1rem",
            background: "#f5f5f5",
            borderRadius: "8px",
          }}
        >
          <strong>Debug State</strong>
          <div style={{ marginTop: "0.5rem" }}>
            <div>Today: {todayDate}</div>
            <div>Expense count: {expenseCount}</div>
            <div>
              Total spent: $
              {computed(() => totalSpent.toFixed(2))}
            </div>
            <div>Categories with spending: {categoryCount}</div>
          </div>

          <hr style={{ margin: "1rem 0", border: "none", borderTop: "1px solid #ddd" }} />

          <details>
            <summary style={{ cursor: "pointer" }}>
              Spent by Category
            </summary>
            <pre style={{ margin: "0.5rem 0", whiteSpace: "pre-wrap" }}>
              {computed(() => JSON.stringify(spentByCategory, null, 2))}
            </pre>
          </details>

          <details>
            <summary style={{ cursor: "pointer" }}>
              Budget Status
            </summary>
            <pre style={{ margin: "0.5rem 0", whiteSpace: "pre-wrap" }}>
              {computed(() => JSON.stringify(budgetStatus, null, 2))}
            </pre>
          </details>

          <details>
            <summary style={{ cursor: "pointer" }}>
              Raw Expenses
            </summary>
            <pre style={{ margin: "0.5rem 0", whiteSpace: "pre-wrap" }}>
              {computed(() => JSON.stringify(expenses.get(), null, 2))}
            </pre>
          </details>

          <details>
            <summary style={{ cursor: "pointer" }}>
              Raw Budgets
            </summary>
            <pre style={{ margin: "0.5rem 0", whiteSpace: "pre-wrap" }}>
              {computed(() => JSON.stringify(budgets.get(), null, 2))}
            </pre>
          </details>
        </div>
      </div>
    ),

    // Export all data for linking and inspection
    expenses,
    budgets,
    totalSpent,
    spentByCategory,
    budgetStatus,
  };
});
