/**
 * Calendar Export Utility
 *
 * Reusable utility for exporting events to multiple calendar targets:
 * - Google Calendar (direct API with batch support)
 * - Apple Calendar (via outbox pattern)
 * - ICS file download (fallback for any calendar app)
 *
 * This module provides conversion functions and export helpers.
 * For the embeddable UI component, see calendar-export-ui.tsx.
 *
 * Usage:
 * ```typescript
 * import {
 *   convertToGoogleEvents,
 *   convertToAppleOutbox,
 *   convertToICS,
 *   exportToGoogle,
 * } from "./util/calendar-export.tsx";
 * ```
 */

import type { Writable } from "commontools";
import type { Auth } from "./google-auth-manager.tsx";
import {
  type BatchProgress,
  CalendarWriteClient,
} from "./calendar-write-client.ts";
import {
  dayToICalDay,
  generateEventUID,
  generateICS,
  getFirstOccurrenceDate,
  type ICalEvent,
  sanitizeFilename,
} from "./ical-generator.ts";
import type {
  CalendarOutboxEvent,
  DayOfWeek,
  ExportableEvent,
  ExportConfig,
  ExportProgress,
  ExportProgressCallback,
  ExportResult,
  ExportTarget,
  ExportTargetInfo,
  RecurrenceRule,
} from "./calendar-export-types.ts";

// Re-export types for convenience
export type {
  CalendarOutboxEvent,
  ExportableEvent,
  ExportConfig,
  ExportProgress,
  ExportProgressCallback,
  ExportResult,
  ExportTarget,
  ExportTargetInfo,
} from "./calendar-export-types.ts";

// ============================================================================
// CONSTANTS
// ============================================================================

const DAY_TO_RRULE: Record<DayOfWeek, string> = {
  monday: "MO",
  tuesday: "TU",
  wednesday: "WE",
  thursday: "TH",
  friday: "FR",
  saturday: "SA",
  sunday: "SU",
};

// ============================================================================
// CONVERSION HELPERS
// ============================================================================

/**
 * Convert ExportableEvent time slots to Google Calendar events.
 * Each time slot becomes a separate recurring event.
 *
 * TODO: Return { events, skipped } instead of just events array.
 * Events without timeSlots or startDate/startTime/endTime are silently dropped.
 * Same applies to convertToAppleOutbox and convertToICS.
 */
export function convertToGoogleEvents(
  events: ExportableEvent[],
  dateRange: { startDate: string; endDate: string },
  timezone: string = Intl.DateTimeFormat().resolvedOptions().timeZone,
): Array<{
  clientId: string;
  summary: string;
  start: string;
  end: string;
  description?: string;
  location?: string;
  attendees?: string[];
  isAllDay?: boolean;
  recurrence?: string[];
}> {
  const result: Array<{
    clientId: string;
    summary: string;
    start: string;
    end: string;
    description?: string;
    location?: string;
    attendees?: string[];
    isAllDay?: boolean;
    recurrence?: string[];
  }> = [];

  for (const event of events) {
    // Handle recurring events with time slots
    if (event.timeSlots && event.timeSlots.length > 0) {
      for (const slot of event.timeSlots) {
        // Calculate first occurrence date
        const firstDate = getFirstOccurrenceDate(
          dateRange.startDate,
          slot.day as DayOfWeek,
        );

        // Build datetime strings
        const startDateTime = `${firstDate}T${slot.startTime}:00`;
        const endDateTime = `${firstDate}T${slot.endTime}:00`;

        // Build RRULE
        const dayCode = DAY_TO_RRULE[slot.day as DayOfWeek];
        const untilDate = dateRange.endDate.replace(/-/g, "");
        const rrule =
          `RRULE:FREQ=WEEKLY;BYDAY=${dayCode};UNTIL=${untilDate}T235959Z`;

        result.push({
          clientId: `${event.id}-${slot.day}`,
          summary: event.title,
          start: startDateTime,
          end: endDateTime,
          description: event.description,
          location: event.location,
          attendees: event.attendees,
          recurrence: [rrule],
        });
      }
    } else if (event.startDate && event.startTime && event.endTime) {
      // Single event (non-recurring)
      const startDateTime = `${event.startDate}T${event.startTime}:00`;
      const endDateTime = `${event.startDate}T${event.endTime}:00`;

      result.push({
        clientId: event.id,
        summary: event.title,
        start: startDateTime,
        end: endDateTime,
        description: event.description,
        location: event.location,
        attendees: event.attendees,
        isAllDay: event.isAllDay,
      });
    }
  }

  return result;
}

/**
 * Convert ExportableEvent to Apple Calendar outbox format.
 */
export function convertToAppleOutbox(
  events: ExportableEvent[],
  calendarName: string,
  dateRange: { startDate: string; endDate: string },
): CalendarOutboxEvent[] {
  const result: CalendarOutboxEvent[] = [];

  for (const event of events) {
    // Handle recurring events with time slots
    if (event.timeSlots && event.timeSlots.length > 0) {
      for (const slot of event.timeSlots) {
        const firstDate = getFirstOccurrenceDate(
          dateRange.startDate,
          slot.day as DayOfWeek,
        );

        const dayCode = DAY_TO_RRULE[slot.day as DayOfWeek];
        const recurrence: RecurrenceRule = {
          frequency: "WEEKLY",
          byDay: dayCode,
          until: dateRange.endDate,
        };

        result.push({
          id: `${event.id}-${slot.day}`,
          title: event.title,
          calendarName,
          startDate: firstDate,
          startTime: slot.startTime,
          endTime: slot.endTime,
          location: event.location,
          notes: event.description,
          recurrence,
        });
      }
    } else if (event.startDate && event.startTime && event.endTime) {
      // Single event
      result.push({
        id: event.id,
        title: event.title,
        calendarName,
        startDate: event.startDate,
        startTime: event.startTime,
        endTime: event.endTime,
        location: event.location,
        notes: event.description,
      });
    }
  }

  return result;
}

/**
 * Convert ExportableEvent to ICS format string.
 */
export function convertToICS(
  events: ExportableEvent[],
  dateRange: { startDate: string; endDate: string },
  options: {
    calendarName?: string;
    timezone?: string;
  } = {},
): string {
  const timezone = options.timezone ||
    Intl.DateTimeFormat().resolvedOptions().timeZone;
  const icalEvents: ICalEvent[] = [];

  for (const event of events) {
    // Handle recurring events with time slots
    if (event.timeSlots && event.timeSlots.length > 0) {
      for (const slot of event.timeSlots) {
        const firstDate = getFirstOccurrenceDate(
          dateRange.startDate,
          slot.day as DayOfWeek,
        );

        const uid = generateEventUID(
          event.title,
          slot.day,
          slot.startTime,
          firstDate,
        );

        icalEvents.push({
          uid,
          summary: event.title,
          location: event.location,
          description: event.description,
          startDate: firstDate,
          startTime: slot.startTime,
          endTime: slot.endTime,
          timezone,
          rrule: {
            freq: "WEEKLY",
            byday: dayToICalDay(slot.day as DayOfWeek),
            until: dateRange.endDate,
          },
        });
      }
    } else if (event.startDate && event.startTime && event.endTime) {
      // Single event
      const uid = generateEventUID(
        event.title,
        "single",
        event.startTime,
        event.startDate,
      );

      icalEvents.push({
        uid,
        summary: event.title,
        location: event.location,
        description: event.description,
        startDate: event.startDate,
        startTime: event.startTime,
        endTime: event.endTime,
        timezone,
        allDay: event.isAllDay,
      });
    }
  }

  return generateICS(icalEvents, {
    calendarName: options.calendarName,
    timezone,
  });
}

// ============================================================================
// EXPORT FUNCTIONS
// ============================================================================

/**
 * Export events to Google Calendar.
 *
 * @param auth - Google auth cell
 * @param events - Events to export
 * @param config - Export configuration
 * @param onProgress - Progress callback
 * @returns Export result
 */
export async function exportToGoogle(
  auth: Writable<Auth>,
  events: ExportableEvent[],
  config: ExportConfig,
  onProgress?: ExportProgressCallback,
): Promise<ExportResult> {
  const client = new CalendarWriteClient(auth, { debugMode: false });

  // Convert to Google format
  const googleEvents = convertToGoogleEvents(events, config.dateRange);

  if (googleEvents.length === 0) {
    return {
      success: true,
      target: "google",
      message: "No events to export",
      timestamp: new Date().toISOString(),
      exportedCount: 0,
    };
  }

  // Report initial progress
  onProgress?.({
    phase: "preparing",
    total: googleEvents.length,
    processed: 0,
    succeeded: 0,
    failed: 0,
    percentComplete: 0,
  });

  try {
    // Use batch API
    const result = await client.createBatchEvents({
      calendarId: config.calendarName, // "primary" or calendar ID
      events: googleEvents,
      sendUpdates: "none",
      batchSize: 5, // Conservative to avoid rate limits
      batchDelayMs: 200,
      onProgress: (bp: BatchProgress) => {
        onProgress?.({
          phase: "exporting",
          total: bp.total,
          processed: bp.processed,
          succeeded: bp.succeeded,
          failed: bp.failed,
          percentComplete: bp.percentComplete,
          currentEvent: bp.currentEvent,
        });
      },
    });

    onProgress?.({
      phase: "done",
      total: result.total,
      processed: result.total,
      succeeded: result.succeeded,
      failed: result.failed,
      percentComplete: 100,
    });

    return {
      success: result.failed === 0,
      target: "google",
      message: result.failed === 0
        ? `Successfully exported ${result.succeeded} events to Google Calendar`
        : `Exported ${result.succeeded} events, ${result.failed} failed`,
      timestamp: new Date().toISOString(),
      exportedCount: result.succeeded,
      failedCount: result.failed,
      eventResults: result.results.map((r) => ({
        eventId: r.clientId,
        success: r.success,
        externalId: r.event?.id,
        error: r.error,
      })),
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    onProgress?.({
      phase: "error",
      total: googleEvents.length,
      processed: 0,
      succeeded: 0,
      failed: googleEvents.length,
      percentComplete: 0,
      error: errorMessage,
    });

    return {
      success: false,
      target: "google",
      message: `Export failed: ${errorMessage}`,
      timestamp: new Date().toISOString(),
      exportedCount: 0,
      failedCount: googleEvents.length,
    };
  }
}

/**
 * Export events as ICS content.
 * Returns the ICS content and filename for use with <ct-file-download>.
 *
 * @param events - Events to export
 * @param config - Export configuration
 * @returns Export result with ICS content (use <ct-file-download> for actual download)
 */
export function exportToICS(
  events: ExportableEvent[],
  config: ExportConfig,
): ExportResult {
  const icsContent = convertToICS(events, config.dateRange, {
    calendarName: config.exportTitle || config.calendarName,
  });

  const filename = `${
    sanitizeFilename(
      config.icsFilenamePrefix || config.calendarName || "calendar",
    )
  }-${new Date().toISOString().split("T")[0]}.ics`;

  return {
    success: true,
    target: "ics",
    message: `ICS file ready: ${filename}`,
    timestamp: new Date().toISOString(),
    exportedCount: events.length,
    icsContent,
    icsFilename: filename,
  };
}

/**
 * Check which export targets are available.
 *
 * @param googleAuth - Google auth cell (optional)
 * @returns Array of available export targets with status
 */
export function getAvailableTargets(
  googleAuth?: Writable<Auth> | null,
): ExportTargetInfo[] {
  const targets: ExportTargetInfo[] = [];

  // Google Calendar - requires valid auth
  const hasGoogleAuth = !!googleAuth?.get()?.token;
  targets.push({
    id: "google",
    label: "Google Calendar",
    icon: "📅",
    available: hasGoogleAuth,
    unavailableReason: hasGoogleAuth
      ? undefined
      : "Sign in with Google to enable",
  });

  // Apple Calendar - always available via outbox
  // (actual sync requires CLI tool, but we can always add to outbox)
  targets.push({
    id: "apple",
    label: "Apple Calendar",
    icon: "🍎",
    available: true,
  });

  // ICS download - always available
  targets.push({
    id: "ics",
    label: "Download .ics",
    icon: "📥",
    available: true,
  });

  return targets;
}
