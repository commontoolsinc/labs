/**
 * Type definitions for BillExtractor building block.
 */
import type { JSONSchema } from "commontools";
import type { Schema } from "commontools/schema";

// =============================================================================
// SCHEMA
// =============================================================================

/**
 * Standardized schema for bill extraction.
 * All bill trackers use this same schema - they just provide different prompts
 * that explain what "identifier" means for their specific use case.
 */
export const BILL_EXTRACTION_SCHEMA = {
  type: "object",
  properties: {
    emailType: {
      type: "string",
      enum: [
        "bill_due",
        "payment_received",
        "payment_reminder",
        "statement_ready",
        "autopay_scheduled",
        "other",
      ],
      description:
        "Type of email: bill_due for payment due notifications, payment_received for payment confirmations, payment_reminder for upcoming due reminders, statement_ready for new statement notifications, autopay_scheduled for autopay confirmation, other for unrelated emails",
    },
    identifier: {
      type: "string",
      description:
        "Account or card identifier. See prompt for what to extract (e.g., card last 4 digits, account number).",
    },
    amount: {
      type: "number",
      description:
        "The payment amount or bill amount in dollars (just the number, no $ sign)",
    },
    dueDate: {
      type: "string",
      description: "Payment due date in ISO format YYYY-MM-DD (if mentioned)",
    },
    paymentDate: {
      type: "string",
      description:
        "Date payment was received/processed in ISO format YYYY-MM-DD (for payment confirmations)",
    },
    minimumPayment: {
      type: "number",
      description: "Minimum payment amount if mentioned",
    },
    statementBalance: {
      type: "number",
      description: "Statement balance or total amount due if mentioned",
    },
    autopayEnabled: {
      type: "boolean",
      description: "Whether autopay is mentioned as being enabled",
    },
    summary: {
      type: "string",
      description: "Brief one-sentence summary of the email content",
    },
  },
  required: ["emailType", "identifier", "summary"],
} as const satisfies JSONSchema;

/**
 * Type for the LLM extraction result based on BILL_EXTRACTION_SCHEMA.
 */
export type BillAnalysis = Schema<typeof BILL_EXTRACTION_SCHEMA>;

// =============================================================================
// TYPES
// =============================================================================

/**
 * Type of email notification.
 */
export type EmailType =
  | "bill_due"
  | "payment_received"
  | "payment_reminder"
  | "statement_ready"
  | "autopay_scheduled"
  | "other";

/**
 * Status of a tracked bill.
 */
export type BillStatus = "unpaid" | "paid" | "overdue" | "likely_paid";

/**
 * A tracked bill extracted from email.
 */
export interface TrackedBill {
  /** Unique key for deduplication (identifier|dueDate) */
  key: string;
  /** Generic identifier (card last 4, account number, etc.) */
  identifier: string;
  /** Bill amount in dollars */
  amount: number;
  /** Due date in ISO format */
  dueDate: string;
  /** Current status */
  status: BillStatus;
  /** Whether the bill is considered paid */
  isPaid: boolean;
  /** Date the bill was paid (if known) */
  paidDate?: string;
  /** Date the email was received */
  emailDate: string;
  /** Gmail message ID */
  emailId: string;
  /** Whether user manually marked as paid */
  isManuallyPaid: boolean;
  /** Whether assumed paid due to age (>45 days overdue) */
  isLikelyPaid: boolean;
  /** Days until due (negative = overdue) */
  daysUntilDue: number;
}
