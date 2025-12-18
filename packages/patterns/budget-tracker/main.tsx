/// <cts-enable />
/**
 * Budget Tracker - Main Pattern
 *
 * Composes data-view and expense-form sub-patterns.
 * Both sub-patterns share the same Cell references,
 * so changes in expense-form automatically update data-view.
 *
 * This demonstrates Level 4 pattern composition from PATTERNS.md.
 *
 * NOTE: Currently causes ConflictError when loaded - investigating.
 */
import { Cell, Default, NAME, pattern, UI } from "commontools";
import { type CategoryBudget, type Expense } from "./schemas.tsx";
import DataView from "./data-view.tsx";
import ExpenseForm from "./expense-form.tsx";

// ============ INPUT/OUTPUT TYPES ============

interface Input {
  expenses: Cell<Default<Expense[], []>>;
  budgets: Cell<Default<CategoryBudget[], []>>;
}

interface Output {
  expenses: Expense[];
  budgets: CategoryBudget[];
  // Re-export handlers from expense-form for CLI access
  addExpense: unknown;
  setBudget: unknown;
  removeBudget: unknown;
}

// ============ PATTERN ============

export default pattern<Input, Output>(({ expenses, budgets }) => {
  // Compose sub-patterns, passing shared cells
  const dataView = DataView({ expenses, budgets });
  const expenseForm = ExpenseForm({ expenses, budgets });

  return {
    [NAME]: "Budget Tracker",
    [UI]: (
      <div
        style={{
          fontFamily: "system-ui",
          display: "flex",
          gap: "1rem",
          padding: "1rem",
        }}
      >
        {/* Left: Data View (read-only display) */}
        <div style={{ flex: 1, borderRight: "1px solid #ddd", paddingRight: "1rem" }}>
          {dataView}
        </div>

        {/* Right: Expense Form (mutations) */}
        <div style={{ flex: 1 }}>
          {expenseForm}
        </div>
      </div>
    ),

    // Export shared data
    expenses,
    budgets,

    // Re-export handlers from expense-form for CLI access
    addExpense: expenseForm.addExpense,
    setBudget: expenseForm.setBudget,
    removeBudget: expenseForm.removeBudget,
  };
});
