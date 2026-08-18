/**
 * Budget Tracker - Shared Schemas
 *
 * Type definitions used across all budget tracker sub-patterns.
 */
import { type Confidential, Default } from "commonfabric";

// ============ CORE TYPES ============

export interface Expense {
  // The free-text note is the private part of a record; the inert
  // `category` / `amount` / `date` fields alongside it are not labelled, so
  // an aggregate computed from them alone carries no confidentiality.
  description: Confidential<string, readonly ["expense-note"]>;
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

// `nowMs` is the current time in epoch milliseconds. Callers in a handler pass
// Date.now(); callers in a lift pass a reactive #now value.
export const getTodayDate = (nowMs: number): string => {
  return new Date(nowMs).toISOString().split("T")[0];
};
