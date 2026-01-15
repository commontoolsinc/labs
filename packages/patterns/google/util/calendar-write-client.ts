/**
 * Calendar Write API client for creating, updating, and deleting events.
 *
 * This module provides a client for Calendar API write operations:
 * - Create events with attendees and recurrence
 * - Create multiple events in batches with progress tracking
 * - Update existing events
 * - Delete events
 * - RSVP to events (accept/decline/tentative)
 * - Token refresh on 401 errors
 *
 * Usage:
 * ```typescript
 * import { CalendarWriteClient } from "./util/calendar-write-client.ts";
 *
 * const client = new CalendarWriteClient(authCell, { debugMode: true });
 *
 * // Single event
 * const event = await client.createEvent({
 *   calendarId: "primary",
 *   summary: "Team Meeting",
 *   start: "2024-01-15T10:00:00",
 *   end: "2024-01-15T11:00:00",
 * });
 *
 * // Batch create with progress
 * const result = await client.createBatchEvents({
 *   calendarId: "primary",
 *   events: [...],
 *   onProgress: (p) => console.log(`${p.percentComplete}% complete`),
 * });
 * ```
 */
import { getRecipeEnvironment, Writable } from "commontools";

const env = getRecipeEnvironment();

// Re-export the Auth type for convenience
export type { Auth } from "./google-auth-manager.tsx";
import type { Auth } from "./google-auth-manager.tsx";

// ============================================================================
// TYPES
// ============================================================================

export interface CalendarWriteClientConfig {
  /** Enable verbose console logging */
  debugMode?: boolean;
}

export interface CreateEventParams {
  /** Calendar ID (use "primary" for main calendar) */
  calendarId: string;
  /** Event title/summary (required) */
  summary: string;
  /** Start time - ISO datetime string or Date object */
  start: string | Date;
  /** End time - ISO datetime string or Date object */
  end: string | Date;
  /** Event description (optional) */
  description?: string;
  /** Location (optional) */
  location?: string;
  /** Attendee email addresses (optional) */
  attendees?: string[];
  /** Whether to send email updates to attendees */
  sendUpdates?: "all" | "externalOnly" | "none";
  /** For all-day events, use date instead of dateTime */
  isAllDay?: boolean;
  /**
   * Recurrence rules in RFC 5545 RRULE format.
   * Example: ["RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR;UNTIL=20240531T235959Z"]
   */
  recurrence?: string[];
}

export interface UpdateEventParams {
  /** Event title/summary */
  summary?: string;
  /** Start time - ISO datetime string or Date object */
  start?: string | Date;
  /** End time - ISO datetime string or Date object */
  end?: string | Date;
  /** Event description */
  description?: string;
  /** Location */
  location?: string;
  /** Attendee email addresses (replaces existing) */
  attendees?: string[];
  /** For all-day events */
  isAllDay?: boolean;
}

export type RSVPStatus = "accepted" | "declined" | "tentative";

// ============================================================================
// BATCH API TYPES
// ============================================================================

/**
 * Progress callback for batch operations.
 */
export interface BatchProgress {
  /** Total events to process */
  total: number;
  /** Events processed so far */
  processed: number;
  /** Events successfully created */
  succeeded: number;
  /** Events that failed */
  failed: number;
  /** Percentage complete (0-100) */
  percentComplete: number;
  /** Current event being processed */
  currentEvent?: string;
}

/**
 * Result for a single event in a batch operation.
 */
export interface BatchEventResult {
  /** Client-provided event ID (for correlation) */
  clientId: string;
  /** Whether the event was created successfully */
  success: boolean;
  /** The created event (if successful) */
  event?: CalendarEventResult;
  /** Error message (if failed) */
  error?: string;
}

/**
 * Parameters for batch event creation.
 */
export interface BatchCreateEventsParams {
  /** Calendar ID (use "primary" for main calendar) */
  calendarId: string;
  /** Events to create */
  events: Array<{
    /** Client-provided ID for correlation in results */
    clientId: string;
    /** Event title/summary */
    summary: string;
    /** Start time - ISO datetime string or Date object */
    start: string | Date;
    /** End time - ISO datetime string or Date object */
    end: string | Date;
    /** Event description */
    description?: string;
    /** Location */
    location?: string;
    /** Attendee email addresses */
    attendees?: string[];
    /** For all-day events */
    isAllDay?: boolean;
    /** Recurrence rules in RFC 5545 RRULE format */
    recurrence?: string[];
  }>;
  /** Whether to send email updates to attendees */
  sendUpdates?: "all" | "externalOnly" | "none";
  /** Batch size (default: 10, max: 50) */
  batchSize?: number;
  /** Delay between batches in ms (default: 100) */
  batchDelayMs?: number;
  /** Progress callback */
  onProgress?: (progress: BatchProgress) => void;
}

/**
 * Result of a batch event creation operation.
 */
export interface BatchCreateEventsResult {
  /** Total events processed */
  total: number;
  /** Number of events successfully created */
  succeeded: number;
  /** Number of events that failed */
  failed: number;
  /** Per-event results */
  results: BatchEventResult[];
}

export interface CalendarEventResult {
  /** Event ID */
  id: string;
  /** Event status */
  status: string;
  /** HTML link to the event */
  htmlLink: string;
  /** Event summary/title */
  summary?: string;
  /** Event description */
  description?: string;
  /** Event location */
  location?: string;
  /** Start time */
  start?: {
    dateTime?: string;
    date?: string;
    timeZone?: string;
  };
  /** End time */
  end?: {
    dateTime?: string;
    date?: string;
    timeZone?: string;
  };
  /** Attendees */
  attendees?: Array<{
    email: string;
    responseStatus?: string;
    displayName?: string;
    organizer?: boolean;
    self?: boolean;
  }>;
}

// ============================================================================
// HELPERS
// ============================================================================

function debugLog(debugMode: boolean, ...args: unknown[]) {
  if (debugMode) console.log("[CalendarWriteClient]", ...args);
}

// ============================================================================
// CALENDAR WRITE CLIENT
// ============================================================================

/**
 * Calendar Write API client.
 *
 * Provides CRUD operations for Google Calendar events.
 *
 * IMPORTANT: Requires the calendar.events scope to be authorized.
 * The auth cell MUST be writable for token refresh to work!
 */
export class CalendarWriteClient {
  private auth: Writable<Auth>;
  private debugMode: boolean;

  constructor(
    auth: Writable<Auth>,
    { debugMode = false }: CalendarWriteClientConfig = {},
  ) {
    this.auth = auth;
    this.debugMode = debugMode;
  }

  /**
   * Format a date/time for the Calendar API.
   * Returns dateTime format (ISO with timezone) or date format (YYYY-MM-DD).
   */
  private formatDateTime(
    dt: string | Date,
    isAllDay = false,
  ): { dateTime?: string; date?: string; timeZone?: string } {
    const date = typeof dt === "string" ? new Date(dt) : dt;

    if (isAllDay) {
      // All-day events use date format (YYYY-MM-DD)
      return {
        date: date.toISOString().split("T")[0],
      };
    }

    return {
      dateTime: date.toISOString(),
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    };
  }

  /**
   * Create a new calendar event.
   *
   * @param params - Event parameters
   * @returns The created event
   * @throws Error if creation fails or auth is invalid
   */
  async createEvent(
    params: CreateEventParams,
    retryCount = 0,
  ): Promise<CalendarEventResult> {
    const token = this.auth.get()?.token;
    if (!token) {
      throw new Error("No authorization token. Please authenticate first.");
    }

    debugLog(this.debugMode, "Creating event:", {
      calendarId: params.calendarId,
      summary: params.summary,
      start: params.start,
      end: params.end,
      attendeeCount: params.attendees?.length || 0,
    });

    // Build event body
    const body: Record<string, unknown> = {
      summary: params.summary,
      start: this.formatDateTime(params.start, params.isAllDay),
      end: this.formatDateTime(params.end, params.isAllDay),
    };

    if (params.description) {
      body.description = params.description;
    }
    if (params.location) {
      body.location = params.location;
    }
    if (params.attendees && params.attendees.length > 0) {
      body.attendees = params.attendees.map((email) => ({ email }));
    }
    if (params.recurrence && params.recurrence.length > 0) {
      body.recurrence = params.recurrence;
    }

    // Build URL with query params
    const url = new URL(
      `https://www.googleapis.com/calendar/v3/calendars/${
        encodeURIComponent(params.calendarId)
      }/events`,
    );
    if (params.sendUpdates) {
      url.searchParams.set("sendUpdates", params.sendUpdates);
    }

    const res = await fetch(url.toString(), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    // Handle 401 (token expired) - try to refresh and retry (max 2 retries)
    if (res.status === 401) {
      if (retryCount >= 2) {
        throw new Error(
          "Authentication failed after retries. Please re-authenticate.",
        );
      }
      debugLog(this.debugMode, "Token expired, attempting refresh...");
      await this.refreshAuth();
      return this.createEvent(params, retryCount + 1);
    }

    if (!res.ok) {
      const error = await res.json().catch(() => ({}));
      const errorMessage =
        (error as { error?: { message?: string } }).error?.message ||
        res.statusText;
      debugLog(this.debugMode, "Create failed:", res.status, errorMessage);
      throw new Error(`Calendar API error: ${res.status} ${errorMessage}`);
    }

    const result = await res.json();
    debugLog(this.debugMode, "Event created successfully:", result.id);

    return result;
  }

  /**
   * Update an existing calendar event.
   *
   * @param calendarId - Calendar ID
   * @param eventId - Event ID to update
   * @param params - Fields to update
   * @param sendUpdates - Whether to notify attendees
   * @returns The updated event
   * @throws Error if update fails or auth is invalid
   */
  async updateEvent(
    calendarId: string,
    eventId: string,
    params: UpdateEventParams,
    sendUpdates: "all" | "externalOnly" | "none" = "all",
    retryCount = 0,
  ): Promise<CalendarEventResult> {
    const token = this.auth.get()?.token;
    if (!token) {
      throw new Error("No authorization token. Please authenticate first.");
    }

    debugLog(this.debugMode, "Updating event:", eventId, params);

    // Build update body (only include fields that are provided)
    const body: Record<string, unknown> = {};

    if (params.summary !== undefined) {
      body.summary = params.summary;
    }
    if (params.description !== undefined) {
      body.description = params.description;
    }
    if (params.location !== undefined) {
      body.location = params.location;
    }
    if (params.start !== undefined) {
      body.start = this.formatDateTime(params.start, params.isAllDay);
    }
    if (params.end !== undefined) {
      body.end = this.formatDateTime(params.end, params.isAllDay);
    }
    if (params.attendees !== undefined) {
      body.attendees = params.attendees.map((email) => ({ email }));
    }

    const url = new URL(
      `https://www.googleapis.com/calendar/v3/calendars/${
        encodeURIComponent(calendarId)
      }/events/${encodeURIComponent(eventId)}`,
    );
    url.searchParams.set("sendUpdates", sendUpdates);

    const res = await fetch(url.toString(), {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    // Handle 401 (token expired) - try to refresh and retry (max 2 retries)
    if (res.status === 401) {
      if (retryCount >= 2) {
        throw new Error(
          "Authentication failed after retries. Please re-authenticate.",
        );
      }
      debugLog(this.debugMode, "Token expired, attempting refresh...");
      await this.refreshAuth();
      return this.updateEvent(
        calendarId,
        eventId,
        params,
        sendUpdates,
        retryCount + 1,
      );
    }

    if (!res.ok) {
      const error = await res.json().catch(() => ({}));
      const errorMessage =
        (error as { error?: { message?: string } }).error?.message ||
        res.statusText;
      debugLog(this.debugMode, "Update failed:", res.status, errorMessage);
      throw new Error(`Calendar API error: ${res.status} ${errorMessage}`);
    }

    const result = await res.json();
    debugLog(this.debugMode, "Event updated successfully:", result.id);

    return result;
  }

  /**
   * Delete a calendar event.
   *
   * @param calendarId - Calendar ID
   * @param eventId - Event ID to delete
   * @param sendUpdates - Whether to notify attendees of cancellation
   * @throws Error if deletion fails or auth is invalid
   */
  async deleteEvent(
    calendarId: string,
    eventId: string,
    sendUpdates: "all" | "externalOnly" | "none" = "all",
    retryCount = 0,
  ): Promise<void> {
    const token = this.auth.get()?.token;
    if (!token) {
      throw new Error("No authorization token. Please authenticate first.");
    }

    debugLog(this.debugMode, "Deleting event:", eventId);

    const url = new URL(
      `https://www.googleapis.com/calendar/v3/calendars/${
        encodeURIComponent(calendarId)
      }/events/${encodeURIComponent(eventId)}`,
    );
    url.searchParams.set("sendUpdates", sendUpdates);

    const res = await fetch(url.toString(), {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    // Handle 401 (token expired) - try to refresh and retry (max 2 retries)
    if (res.status === 401) {
      if (retryCount >= 2) {
        throw new Error(
          "Authentication failed after retries. Please re-authenticate.",
        );
      }
      debugLog(this.debugMode, "Token expired, attempting refresh...");
      await this.refreshAuth();
      return this.deleteEvent(calendarId, eventId, sendUpdates, retryCount + 1);
    }

    // DELETE returns 204 No Content on success
    if (!res.ok && res.status !== 204) {
      const error = await res.json().catch(() => ({}));
      const errorMessage =
        (error as { error?: { message?: string } }).error?.message ||
        res.statusText;
      debugLog(this.debugMode, "Delete failed:", res.status, errorMessage);
      throw new Error(`Calendar API error: ${res.status} ${errorMessage}`);
    }

    debugLog(this.debugMode, "Event deleted successfully");
  }

  /**
   * RSVP to a calendar event (update own attendee status).
   *
   * This method fetches the event, updates the user's attendee status,
   * and patches the event back.
   *
   * @param calendarId - Calendar ID
   * @param eventId - Event ID to RSVP to
   * @param status - Response status
   * @returns The updated event
   * @throws Error if RSVP fails or auth is invalid
   */
  async rsvpToEvent(
    calendarId: string,
    eventId: string,
    status: RSVPStatus,
  ): Promise<CalendarEventResult> {
    const token = this.auth.get()?.token;
    if (!token) {
      throw new Error("No authorization token. Please authenticate first.");
    }

    const userEmail = this.auth.get()?.user?.email;
    if (!userEmail) {
      throw new Error("No user email available for RSVP.");
    }

    debugLog(this.debugMode, "RSVP to event:", eventId, "status:", status);

    // First, get the current event to find attendee list
    const getUrl = new URL(
      `https://www.googleapis.com/calendar/v3/calendars/${
        encodeURIComponent(calendarId)
      }/events/${encodeURIComponent(eventId)}`,
    );

    const getRes = await fetch(getUrl.toString(), {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    // Handle 401 (token expired) - try to refresh and retry once
    if (getRes.status === 401) {
      debugLog(this.debugMode, "Token expired, attempting refresh...");
      await this.refreshAuth();
      return this.rsvpToEvent(calendarId, eventId, status);
    }

    if (!getRes.ok) {
      const error = await getRes.json().catch(() => ({}));
      const errorMessage =
        (error as { error?: { message?: string } }).error?.message ||
        getRes.statusText;
      throw new Error(
        `Failed to fetch event: ${getRes.status} ${errorMessage}`,
      );
    }

    const event = (await getRes.json()) as CalendarEventResult;

    // Find and update own attendee status
    const userEmailLower = userEmail.toLowerCase();
    const attendees = (event.attendees || []).map((a) => {
      const attendeeEmail = a.email.toLowerCase();
      if (attendeeEmail === userEmailLower) {
        return { ...a, responseStatus: status };
      }
      return a;
    });

    // Check if user was found as an attendee
    const userFound = event.attendees?.some(
      (a) => a.email.toLowerCase() === userEmailLower,
    );

    if (!userFound) {
      throw new Error(
        "You are not listed as an attendee for this event. Cannot RSVP.",
      );
    }

    // Patch the event with updated attendee status
    const patchUrl = new URL(
      `https://www.googleapis.com/calendar/v3/calendars/${
        encodeURIComponent(calendarId)
      }/events/${encodeURIComponent(eventId)}`,
    );
    patchUrl.searchParams.set("sendUpdates", "all");

    const patchRes = await fetch(patchUrl.toString(), {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ attendees }),
    });

    if (!patchRes.ok) {
      const error = await patchRes.json().catch(() => ({}));
      const errorMessage =
        (error as { error?: { message?: string } }).error?.message ||
        patchRes.statusText;
      debugLog(this.debugMode, "RSVP failed:", patchRes.status, errorMessage);
      throw new Error(`Calendar API error: ${patchRes.status} ${errorMessage}`);
    }

    const result = await patchRes.json();
    debugLog(this.debugMode, "RSVP successful:", result.id, "status:", status);

    return result;
  }

  /**
   * Create multiple calendar events in batches.
   *
   * This method creates events sequentially in batches, with rate limiting
   * between batches to avoid hitting API quotas. Progress is reported via callback.
   *
   * @param params - Batch creation parameters
   * @returns Result with per-event success/failure details
   */
  async createBatchEvents(
    params: BatchCreateEventsParams,
  ): Promise<BatchCreateEventsResult> {
    const {
      calendarId,
      events,
      sendUpdates = "none",
      batchSize = 10,
      batchDelayMs = 100,
      onProgress,
    } = params;

    const effectiveBatchSize = Math.min(Math.max(1, batchSize), 50);
    const results: BatchEventResult[] = [];
    let succeeded = 0;
    let failed = 0;

    debugLog(this.debugMode, "Starting batch creation:", {
      total: events.length,
      batchSize: effectiveBatchSize,
      calendarId,
    });

    // Report initial progress
    onProgress?.({
      total: events.length,
      processed: 0,
      succeeded: 0,
      failed: 0,
      percentComplete: 0,
    });

    // Process events in batches
    for (let i = 0; i < events.length; i += effectiveBatchSize) {
      const batch = events.slice(i, i + effectiveBatchSize);

      // Process each event in the batch sequentially
      // (Google Calendar API doesn't have true batch endpoint for events)
      for (const event of batch) {
        onProgress?.({
          total: events.length,
          processed: results.length,
          succeeded,
          failed,
          percentComplete: Math.round((results.length / events.length) * 100),
          currentEvent: event.summary,
        });

        try {
          const created = await this.createEvent({
            calendarId,
            summary: event.summary,
            start: event.start,
            end: event.end,
            description: event.description,
            location: event.location,
            attendees: event.attendees,
            isAllDay: event.isAllDay,
            recurrence: event.recurrence,
            sendUpdates,
          });

          results.push({
            clientId: event.clientId,
            success: true,
            event: created,
          });
          succeeded++;

          debugLog(
            this.debugMode,
            `Created event ${results.length}/${events.length}:`,
            created.id,
          );
        } catch (error) {
          const errorMessage = error instanceof Error
            ? error.message
            : String(error);
          results.push({
            clientId: event.clientId,
            success: false,
            error: errorMessage,
          });
          failed++;

          debugLog(
            this.debugMode,
            `Failed event ${results.length}/${events.length}:`,
            errorMessage,
          );
        }
      }

      // Delay between batches to avoid rate limiting
      if (i + effectiveBatchSize < events.length) {
        await this.delay(batchDelayMs);
      }
    }

    // Report final progress
    onProgress?.({
      total: events.length,
      processed: events.length,
      succeeded,
      failed,
      percentComplete: 100,
    });

    debugLog(this.debugMode, "Batch creation complete:", {
      total: events.length,
      succeeded,
      failed,
    });

    return {
      total: events.length,
      succeeded,
      failed,
      results,
    };
  }

  /**
   * Delay helper for rate limiting.
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Refresh the OAuth token using the refresh token.
   * Updates the auth cell with new token data.
   */
  private async refreshAuth(): Promise<void> {
    const refreshToken = this.auth.get()?.refreshToken;
    if (!refreshToken) {
      throw new Error("No refresh token available. Please re-authenticate.");
    }

    debugLog(this.debugMode, "Refreshing auth token...");

    const res = await fetch(
      new URL("/api/integrations/google-oauth/refresh", env.apiUrl),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken }),
      },
    );

    if (!res.ok) {
      throw new Error("Token refresh failed. Please re-authenticate.");
    }

    const json = await res.json();
    if (!json.tokenInfo) {
      throw new Error("Invalid refresh response");
    }

    // Update auth cell with new token data
    // Keep existing user info since refresh doesn't return it
    const currentAuth = this.auth.get();
    this.auth.update({
      ...json.tokenInfo,
      user: currentAuth?.user,
    });

    debugLog(this.debugMode, "Auth token refreshed successfully");
  }
}
