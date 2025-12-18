/// <cts-enable />
/**
 * Budget Tracker - Expense Form Sub-Pattern
 *
 * Provides UI and handlers for adding/removing expenses and budgets.
 * Requires Cell<> for write access to data.
 *
 * Can be deployed standalone for testing handlers,
 * or composed into a larger pattern.
 */
import {
  Cell,
  computed,
  handler,
  NAME,
  pattern,
  Stream,
  UI,
} from "commontools";
import {
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
  // Handlers typed as Stream<T> for cross-charm communication
  addExpense: Stream<{
    description: string;
    amount: number;
    category?: string;
    date?: string;
  }>;
  setBudget: Stream<{ category: string; limit: number }>;
  removeBudget: Stream<{ category: string }>;
}

// ============ HANDLERS ============

const addExpenseHandler = handler<
  { description: string; amount: number; category?: string; date?: string },
  { expenses: Cell<Expense[]> }
>(({ description, amount, category, date }, { expenses }) => {
  if (!description?.trim() || typeof amount !== "number" || amount <= 0) {
    return;
  }
  expenses.push({
    description: description.trim(),
    amount,
    category: category || "Other",
    date: date || getTodayDate(),
  });
});

const setBudgetHandler = handler<
  { category: string; limit: number },
  { budgets: Cell<CategoryBudget[]> }
>(({ category, limit }, { budgets }) => {
  if (!category?.trim() || typeof limit !== "number" || limit < 0) {
    return;
  }
  const current = budgets.get();
  const existingIndex = current.findIndex((b) => b.category === category.trim());

  if (existingIndex >= 0) {
    budgets.set(
      current.map((b, i) => (i === existingIndex ? { ...b, limit } : b))
    );
  } else {
    budgets.push({ category: category.trim(), limit });
  }
});

const removeBudgetHandler = handler<
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

  // Local state for form inputs
  const newDescription = Cell.of("");
  const newAmount = Cell.of("");
  const newCategory = Cell.of("Other");

  // Expense count for display
  const expenseCount = computed(() => expenses.get().length);

  // Bound handlers
  const addExpense = addExpenseHandler({ expenses });
  const setBudget = setBudgetHandler({ budgets });
  const removeBudget = removeBudgetHandler({ budgets });

  return {
    [NAME]: "Expense Form",
    [UI]: (
      <div style={{ fontFamily: "system-ui", padding: "1rem" }}>
        <h3 style={{ margin: "0 0 0.5rem 0" }}>Add Expense</h3>

        {/* Add Expense Form - using $value binding */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "0.5rem",
            marginBottom: "1rem",
          }}
        >
          <ct-input $value={newDescription} placeholder="Description" />
          <ct-input $value={newAmount} placeholder="Amount" />
          <ct-input $value={newCategory} placeholder="Category" />
          <ct-button
            onClick={() => {
              const desc = newDescription.get().trim();
              const amt = parseFloat(newAmount.get());
              const cat = newCategory.get().trim() || "Other";

              if (desc && !isNaN(amt) && amt > 0) {
                expenses.push({
                  description: desc,
                  amount: amt,
                  category: cat,
                  date: todayDate,
                });
                // Clear form
                newDescription.set("");
                newAmount.set("");
                newCategory.set("Other");
              }
            }}
          >
            Add Expense
          </ct-button>
        </div>

        {/* Expense List with Remove */}
        <h4 style={{ margin: "0 0 0.5rem 0" }}>Expenses ({expenseCount})</h4>
        <div style={{ marginBottom: "1rem" }}>
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
              <ct-button
                variant="ghost"
                onClick={() => {
                  const current = expenses.get();
                  const index = current.findIndex((el) =>
                    Cell.equals(expense, el)
                  );
                  if (index >= 0) {
                    expenses.set(current.toSpliced(index, 1));
                  }
                }}
              >
                ×
              </ct-button>
            </div>
          ))}
        </div>

        {/* Debug */}
        <details>
          <summary style={{ cursor: "pointer", color: "#666" }}>
            Debug: Form State
          </summary>
          <pre
            style={{
              fontSize: "11px",
              background: "#f5f5f5",
              padding: "0.5rem",
            }}
          >
            {computed(() =>
              JSON.stringify(
                {
                  newDescription: newDescription.get(),
                  newAmount: newAmount.get(),
                  newCategory: newCategory.get(),
                },
                null,
                2
              )
            )}
          </pre>
        </details>
      </div>
    ),

    // Export bound handlers as Streams (not shared cells - parent owns those)
    addExpense,
    setBudget,
    removeBudget,
  };
});
