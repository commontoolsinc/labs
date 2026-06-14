/**
 * Budget Tracker - Shared Schemas
 *
 * Type definitions used across all budget tracker sub-patterns.
 */
import { Default, safeDateNow } from "commonfabric";

// ============ CORE TYPES ============

export interface Expense {
  description: string;
  amount: number;
  category: string | Default<"Other">;
  date: string; // YYYY-MM-DD
}

export interface CategoryBudget {
  category: string;
  limit: number;
}

export interface BudgetStatusItem {
  category: string;
  spent: number;
  limit: number | null;
  remaining: number | null;
  percentUsed: number | null;
}

// ============ HELPER FUNCTIONS ============

// `new Date()` with no arguments throws in the secure pattern sandbox —
// derive "today" from safeDateNow() instead.
export const getTodayDate = (): string => {
  return new Date(safeDateNow()).toISOString().split("T")[0];
};
