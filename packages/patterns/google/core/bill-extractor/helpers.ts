/**
 * Helper functions for BillExtractor building block.
 */

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * Bills older than this many days overdue are assumed "likely paid".
 * Rationale: If someone hasn't paid a bill for 45+ days, they probably
 * paid it through a different method that didn't generate an email confirmation.
 */
export const LIKELY_PAID_THRESHOLD_DAYS = -45;

/**
 * Color palette for identifier badges.
 * Uses a hash of the identifier to pick a consistent color.
 */
export const IDENTIFIER_COLORS = [
  "#ef4444",
  "#dc2626",
  "#f97316",
  "#ea580c",
  "#eab308",
  "#ca8a04",
  "#84cc16",
  "#65a30d",
  "#22c55e",
  "#16a34a",
  "#14b8a6",
  "#0d9488",
  "#06b6d4",
  "#0891b2",
  "#0ea5e9",
  "#0284c7",
  "#3b82f6",
  "#2563eb",
  "#6366f1",
  "#4f46e5",
  "#8b5cf6",
  "#7c3aed",
  "#a855f7",
  "#9333ea",
  "#d946ef",
  "#c026d3",
  "#ec4899",
  "#db2777",
  "#f43f5e",
  "#e11d48",
  "#78716c",
  "#57534e",
];

// =============================================================================
// BILL KEY FUNCTIONS
// =============================================================================

/**
 * Create a unique key for a bill (for deduplication).
 * Format: "identifier|dueDate"
 */
export function createBillKey(identifier: string, dueDate: string): string {
  return `${identifier}|${dueDate}`;
}

// =============================================================================
// DATE FUNCTIONS
// =============================================================================

/**
 * Calculate days until due date from a reference date.
 * Returns 999 for invalid/missing dates.
 */
export function calculateDaysUntilDue(
  dueDate: string | undefined,
  referenceDate: Date,
): number {
  if (!dueDate) return 999;
  const match = dueDate.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return 999;
  const [, year, month, day] = match;
  const due = new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
  if (isNaN(due.getTime())) return 999;
  due.setHours(0, 0, 0, 0);
  return Math.ceil(
    (due.getTime() - referenceDate.getTime()) / (1000 * 60 * 60 * 24),
  );
}

/**
 * Parse an ISO date string to milliseconds.
 * Returns NaN for invalid dates.
 */
export function parseDateToMs(dateStr: string): number {
  const match = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return NaN;
  const [, year, month, day] = match;
  const date = new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

// =============================================================================
// FORMATTING FUNCTIONS
// =============================================================================

/**
 * Format a number as USD currency.
 */
export function formatCurrency(amount: number | undefined): string {
  if (amount === undefined || typeof amount !== "number") return "N/A";
  return `$${amount.toFixed(2)}`;
}

/**
 * Format an ISO date string as a human-readable date.
 * Example: "Sat, Jan 15"
 */
export function formatDate(dateStr: string | undefined): string {
  if (!dateStr) return "N/A";
  const [year, month, day] = dateStr.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  return date.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

/**
 * Get a consistent color for an identifier (card number, account ID, etc.)
 */
export function getIdentifierColor(identifier: string | undefined): string {
  if (!identifier || typeof identifier !== "string") {
    return IDENTIFIER_COLORS[0];
  }
  let hash = 0;
  for (let i = 0; i < identifier.length; i++) {
    hash = (hash * 31 + identifier.charCodeAt(i)) % 32;
  }
  return IDENTIFIER_COLORS[hash];
}

/**
 * Transform real amount to a fake demo amount (for privacy).
 * Uses a deterministic hash so the same input always produces the same output.
 */
export function demoPrice(amount: number, isDemoMode: boolean): number {
  if (!isDemoMode) return amount;
  if (typeof amount !== "number" || !Number.isFinite(amount)) return 0;
  const str = amount.toFixed(2);
  let hash = 0;
  for (const char of str) {
    hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
  }
  const normalized = (hash >>> 0) / 0xffffffff;
  const powerLaw = Math.pow(normalized, 2);
  return Math.round(powerLaw * 500000) / 100;
}

/**
 * Format an identifier for display based on type.
 * - "card": "...1234"
 * - "account": "Acct: 1234"
 */
export function formatIdentifier(
  id: string,
  type: "card" | "account",
): string {
  if (type === "card") {
    return `...${id}`;
  }
  return `Acct: ${id}`;
}
