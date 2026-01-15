/**
 * Calendar Export Types
 *
 * Shared types for exporting calendar events to multiple targets:
 * - Google Calendar (via CalendarWriteClient batch API)
 * - Apple Calendar (via outbox/apple-sync CLI)
 * - ICS file download (via ical-generator)
 *
 * Usage:
 * ```typescript
 * import {
 *   ExportableEvent,
 *   ExportTarget,
 *   ExportConfig,
 *   ExportResult,
 *   CalendarOutbox,
 * } from "./util/calendar-export-types.ts";
 * ```
 */

// ============================================================================
// BASIC TYPES
// ============================================================================

/**
 * Days of the week for recurring events.
 */
export type DayOfWeek =
  | "monday"
  | "tuesday"
  | "wednesday"
  | "thursday"
  | "friday"
  | "saturday"
  | "sunday";

/**
 * Semester/date range for recurring events.
 */
export interface SemesterDates {
  /** Start date in YYYY-MM-DD format */
  startDate: string;
  /** End date in YYYY-MM-DD format */
  endDate: string;
}

/**
 * Recurrence rule for repeating events.
 * Compatible with both Google Calendar API and iCal RRULE format.
 */
export interface RecurrenceRule {
  /** Frequency of recurrence */
  frequency: "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";
  /** Interval between occurrences (e.g., 2 = every 2 weeks) */
  interval?: number;
  /** Days of week for WEEKLY frequency (e.g., "MO", "MO,WE,FR") */
  byDay?: string;
  /** End date in YYYY-MM-DD format */
  until?: string;
  /** Number of occurrences (alternative to until) */
  count?: number;
}

// ============================================================================
// EXPORT TARGETS
// ============================================================================

/**
 * Supported calendar export targets.
 */
export type ExportTarget = "google" | "apple" | "ics";

/**
 * Information about an export target's availability.
 */
export interface ExportTargetInfo {
  /** Target identifier */
  id: ExportTarget;
  /** Display label */
  label: string;
  /** Icon (emoji) */
  icon: string;
  /** Whether this target is available */
  available: boolean;
  /** Reason why unavailable (if applicable) */
  unavailableReason?: string;
}

// ============================================================================
// EXPORTABLE EVENT FORMAT
// ============================================================================

/**
 * Time slot for an event (day + start/end times).
 */
export interface EventTimeSlot {
  /** Day of the week */
  day: DayOfWeek;
  /** Start time in HH:MM (24-hour) format */
  startTime: string;
  /** End time in HH:MM (24-hour) format */
  endTime: string;
}

/**
 * Unified event format for all export targets.
 *
 * This is the canonical format that patterns should produce.
 * The calendar-export pattern converts this to target-specific formats.
 *
 * For recurring events, provide timeSlots with the day of week.
 * For single events, provide startDate/startTime/endTime directly.
 */
export interface ExportableEvent {
  /**
   * Unique identifier for the event.
   * Used for duplicate detection and idempotent creation.
   * Should be deterministic (same event properties = same ID).
   */
  id: string;

  /** Event title/summary (required) */
  title: string;

  /** Event location (optional) */
  location?: string;

  /** Event description/notes (optional) */
  description?: string;

  /**
   * Time slots for recurring events.
   * Each slot creates one recurring event series.
   */
  timeSlots?: EventTimeSlot[];

  /**
   * For single (non-recurring) events: start date in YYYY-MM-DD format.
   */
  startDate?: string;

  /**
   * For single events: start time in HH:MM (24-hour) format.
   */
  startTime?: string;

  /**
   * For single events: end time in HH:MM (24-hour) format.
   */
  endTime?: string;

  /**
   * Timezone identifier (e.g., "America/Los_Angeles").
   * Defaults to local timezone if not specified.
   */
  timezone?: string;

  /** Whether this is an all-day event */
  isAllDay?: boolean;

  /** Attendee email addresses (Google Calendar only) */
  attendees?: string[];
}

// ============================================================================
// APPLE CALENDAR OUTBOX (for apple-sync CLI)
// ============================================================================

/**
 * Single event for Apple Calendar outbox.
 * This format is consumed by the apple-sync CLI tool.
 */
export interface CalendarOutboxEvent {
  /** Unique event identifier */
  id: string;
  /** Event title */
  title: string;
  /** Target calendar name in Apple Calendar */
  calendarName: string;
  /** Start date in YYYY-MM-DD format */
  startDate: string;
  /** Start time in HH:MM format */
  startTime: string;
  /** End time in HH:MM format */
  endTime: string;
  /** Event location */
  location?: string;
  /** Event notes/description */
  notes?: string;
  /** Recurrence rule for repeating events */
  recurrence?: RecurrenceRule;
}

/**
 * Metadata about what was displayed in the confirmation dialog.
 * Provides audit trail for user confirmation.
 */
export interface UserConfirmation {
  /** ISO timestamp when user confirmed */
  timestamp: string;
  /** What was displayed in the dialog */
  dialogContent: {
    displayedTitle: string;
    displayedCalendar: string;
    displayedTimeRange: string;
    displayedEventCount: number;
    displayedClasses: string[];
    warningMessage: string;
  };
  /** Source pattern information */
  sourcePattern: {
    name: string;
    path: string;
  };
}

/**
 * Execution status from CLI processing.
 */
export interface ExecutionResult {
  /** Current status */
  status: "pending" | "processing" | "completed" | "failed";
  /** When processing started */
  startedAt?: string;
  /** When processing completed */
  completedAt?: string;
  /** Error message if failed */
  error?: string;
  /** IDs of events created in Apple Calendar */
  createdEventIds?: string[];
}

/**
 * Complete outbox entry with events and metadata.
 */
export interface CalendarOutboxEntry {
  /** Unique entry identifier */
  id: string;
  /** Events to create */
  events: CalendarOutboxEvent[];
  /** User confirmation metadata (audit trail) */
  confirmation: UserConfirmation;
  /** Execution status (updated by CLI) */
  execution: ExecutionResult;
  /** ISO timestamp when entry was created */
  createdAt: string;
}

/**
 * The calendar outbox cell structure.
 * This is stored in the pattern and consumed by apple-sync CLI.
 */
export interface CalendarOutbox {
  /** Outbox entries */
  entries: CalendarOutboxEntry[];
  /** ISO timestamp of last update */
  lastUpdated: string;
  /** Schema version */
  version: string; // "1.0"
}

// ============================================================================
// EXPORT CONFIGURATION
// ============================================================================

/**
 * Configuration for an export operation.
 */
export interface ExportConfig {
  /** Target calendar name (for Apple) or ID (for Google, use "primary" for main) */
  calendarName: string;

  /** Date range for recurring events */
  dateRange: SemesterDates;

  /** Title for the export (shown in confirmation dialog) */
  exportTitle?: string;

  /** Filename prefix for ICS download */
  icsFilenamePrefix?: string;

  /** Source pattern info for audit trail */
  sourcePattern?: {
    name: string;
    path: string;
  };
}

// ============================================================================
// EXPORT STATE AND RESULTS
// ============================================================================

/**
 * Result for a single event export attempt.
 */
export interface EventExportResult {
  /** ID of the event */
  eventId: string;
  /** Whether export succeeded */
  success: boolean;
  /** External ID assigned by target system */
  externalId?: string;
  /** Error message if failed */
  error?: string;
  /** Whether this was skipped as duplicate */
  skipped?: boolean;
  /** Reason for skipping */
  skipReason?: string;
}

/**
 * Overall result of an export operation.
 */
export interface ExportResult {
  /** Overall success */
  success: boolean;
  /** Export target */
  target: ExportTarget;
  /** Human-readable message */
  message: string;
  /** ISO timestamp when completed */
  timestamp: string;
  /** Number of events exported */
  exportedCount: number;
  /** Number of events that failed */
  failedCount?: number;
  /** Number of duplicates skipped */
  skippedCount?: number;
  /** Per-event results (for detailed reporting) */
  eventResults?: EventExportResult[];
  /** Whether events were added to outbox (Apple) */
  addedToOutbox?: boolean;
  /** Outbox entry ID (Apple) */
  outboxEntryId?: string;
  /** ICS content (for download target) */
  icsContent?: string;
  /** ICS filename (for download target) */
  icsFilename?: string;
}

/**
 * Pending export operation awaiting user confirmation.
 */
export interface PendingExport {
  /** Export target */
  target: ExportTarget;
  /** Events to export */
  events: ExportableEvent[];
  /** Export configuration */
  config: ExportConfig;
  /** Number of events (excluding duplicates) */
  eventCount: number;
  /** Number of duplicates detected */
  duplicateCount: number;
  /** Items that will be skipped */
  skippedItems: Array<{ name: string; reason: string }>;
  /** Pre-generated ICS content (for Apple fallback) */
  icsContent?: string;
  /** Converted outbox events (for Apple) */
  outboxEvents?: CalendarOutboxEvent[];
}

// ============================================================================
// PROGRESS TRACKING
// ============================================================================

/**
 * Progress state for batch export operations.
 */
export interface ExportProgress {
  /** Current phase */
  phase: "preparing" | "exporting" | "completing" | "done" | "error";
  /** Total events to export */
  total: number;
  /** Events processed so far */
  processed: number;
  /** Events successfully exported */
  succeeded: number;
  /** Events that failed */
  failed: number;
  /** Percentage complete (0-100) */
  percentComplete: number;
  /** Current event being processed */
  currentEvent?: string;
  /** Error message if phase is "error" */
  error?: string;
}

/**
 * Callback for progress updates during batch export.
 */
export type ExportProgressCallback = (progress: ExportProgress) => void;
