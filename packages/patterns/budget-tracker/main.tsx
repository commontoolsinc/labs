/// <cts-enable />
import { Cell, Default, NAME, pattern, UI } from "commontools";
import { type CategoryBudget, type Expense } from "./schemas.tsx";
import DataView from "./data-view.tsx";
import ExpenseForm from "./expense-form.tsx";

// Use SINGLE type parameter to avoid conflict bug with sub-pattern rendering
interface State {
  expenses: Cell<Default<Expense[], []>>;
  budgets: Cell<Default<CategoryBudget[], []>>;
}

export default pattern<State>(({ expenses, budgets }) => {
  const dataView = DataView({ expenses, budgets });
  const expenseForm = ExpenseForm({ expenses, budgets });

  return {
    [NAME]: "Budget Tracker",
    [UI]: (
      <div style={{ display: "flex", gap: "2rem", padding: "1rem" }}>
        <div style={{ flex: 1 }}>{expenseForm}</div>
        <div style={{ flex: 1 }}>{dataView}</div>
      </div>
    ),
    expenses,
    budgets,
  };
});
