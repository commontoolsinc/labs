/// <cts-enable />
/**
 * Budget Tracker - Layer 2: Mutation Handlers
 *
 * Builds on Layer 1, adding:
 * - addExpense handler
 * - removeExpense handler
 * - setBudget handler
 *
 * Test each handler via CLI before moving to Layer 3.
 */
import {
  Cell,
  computed,
  Default,
  handler,
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

// ============ HANDLERS ============

// Add a new expense
const addExpense = handler<
  { description: string; amount: number; category?: string; date?: string },
  { expenses: Cell<Expense[]> }
>(({ description, amount, category, date }, { expenses }) => {
  if (!description?.trim() || typeof amount !== "number" || amount <= 0) {
    return; // Validation: require description and positive amount
  }

  expenses.push({
    description: description.trim(),
    amount,
    category: category || "Other",
    date: date || getTodayDate(),
  });
});

// Remove an expense by matching the Cell reference
const removeExpense = handler<
  { expense: Cell<Expense> },
  { expenses: Cell<Expense[]> }
>(({ expense }, { expenses }) => {
  const current = expenses.get();
  const index = current.findIndex((el) => Cell.equals(expense, el));
  if (index >= 0) {
    expenses.set(current.toSpliced(index, 1));
  }
});

// Set or update a category budget
const setBudget = handler<
  { category: string; limit: number },
  { budgets: Cell<CategoryBudget[]> }
>(({ category, limit }, { budgets }) => {
  if (!category?.trim() || typeof limit !== "number" || limit < 0) {
    return; // Validation: require category and non-negative limit
  }

  const current = budgets.get();
  const existingIndex = current.findIndex(
    (b) => b.category === category.trim()
  );

  if (existingIndex >= 0) {
    // Update existing budget
    const updated = current.map((b, i) =>
      i === existingIndex ? { ...b, limit } : b
    );
    budgets.set(updated);
  } else {
    // Add new budget
    budgets.push({ category: category.trim(), limit });
  }
});

// Remove a budget limit for a category
const removeBudget = handler<
  { category: string },
  { budgets: Cell<CategoryBudget[]> }
>(({ category }, { budgets }) => {
  const current = budgets.get();
  const index = current.findIndex((b) => b.category === category);
  if (index >= 0) {
    budgets.set(current.toSpliced(index, 1));
  }
});

// ============ PATTERN ============

export default pattern<Input, Output>(({ expenses, budgets }) => {
  const todayDate = getTodayDate();

  // Computed values (from Layer 1)
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

  return {
    [NAME]: "Budget Tracker",
    [UI]: (
      <div style={{ fontFamily: "system-ui", padding: "1rem" }}>
        <h2 style={{ margin: "0 0 1rem 0" }}>Budget Tracker - Handlers Layer</h2>
        <p style={{ color: "#666", marginBottom: "1rem" }}>
          Debug UI - test handlers via CLI, verify state updates
        </p>

        {/* Quick Actions for Testing - using inline handlers */}
        <div
          style={{
            display: "flex",
            gap: "0.5rem",
            marginBottom: "1rem",
            flexWrap: "wrap",
          }}
        >
          <button
            onClick={() => {
              expenses.push({
                description: "Test Expense",
                amount: 10,
                category: "Food",
                date: todayDate,
              });
            }}
          >
            + Add Test Expense ($10 Food)
          </button>
          <button
            onClick={() => {
              const current = budgets.get();
              const existingIndex = current.findIndex((b) => b.category === "Food");
              if (existingIndex >= 0) {
                budgets.set(
                  current.map((b, i) => (i === existingIndex ? { ...b, limit: 100 } : b))
                );
              } else {
                budgets.push({ category: "Food", limit: 100 });
              }
            }}
          >
            Set Food Budget ($100)
          </button>
        </div>

        {/* Expense List with Remove Buttons */}
        <div style={{ marginBottom: "1rem" }}>
          <h3 style={{ margin: "0 0 0.5rem 0" }}>
            Expenses ({expenseCount})
          </h3>
          {expenses.map((expense) => (
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                padding: "0.5rem",
                borderBottom: "1px solid #eee",
              }}
            >
              <span>
                {expense.description} - ${expense.amount} ({expense.category})
              </span>
              <button
                onClick={() => {
                  const current = expenses.get();
                  const index = current.findIndex((el) => Cell.equals(expense, el));
                  if (index >= 0) {
                    expenses.set(current.toSpliced(index, 1));
                  }
                }}
                style={{ color: "red" }}
              >
                ×
              </button>
            </div>
          ))}
        </div>

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
              Total spent: ${computed(() => totalSpent.toFixed(2))}
            </div>
          </div>

          <hr style={{ margin: "1rem 0", border: "none", borderTop: "1px solid #ddd" }} />

          <details>
            <summary style={{ cursor: "pointer" }}>Budget Status</summary>
            <pre style={{ margin: "0.5rem 0", whiteSpace: "pre-wrap" }}>
              {computed(() => JSON.stringify(budgetStatus, null, 2))}
            </pre>
          </details>

          <details>
            <summary style={{ cursor: "pointer" }}>Raw Expenses</summary>
            <pre style={{ margin: "0.5rem 0", whiteSpace: "pre-wrap" }}>
              {computed(() => JSON.stringify(expenses.get(), null, 2))}
            </pre>
          </details>

          <details>
            <summary style={{ cursor: "pointer" }}>Raw Budgets</summary>
            <pre style={{ margin: "0.5rem 0", whiteSpace: "pre-wrap" }}>
              {computed(() => JSON.stringify(budgets.get(), null, 2))}
            </pre>
          </details>
        </div>
      </div>
    ),

    // Export data
    expenses,
    budgets,
    totalSpent,
    spentByCategory,
    budgetStatus,

    // Export handlers for CLI testing
    addExpense: addExpense({ expenses }),
    setBudget: setBudget({ budgets }),
    removeBudget: removeBudget({ budgets }),
  };
});
