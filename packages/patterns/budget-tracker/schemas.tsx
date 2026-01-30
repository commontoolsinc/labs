/// <cts-enable />
/**
 * Budget Tracker - Shared Schemas
 *
 * Type definitions used across all budget tracker sub-patterns.
 */
import { Default } from "commontools";

// ============ CORE TYPES ============

export interface Expense {
  description: string;
  amount: number;
  category: Default<string, "Other">;
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

export const getTodayDate = (): string => {
  return Temporal.Now.plainDateISO().toString();
};
