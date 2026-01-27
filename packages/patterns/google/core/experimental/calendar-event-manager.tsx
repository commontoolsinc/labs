/// <cts-enable />
/**
 * Calendar Event Manager Pattern
 *
 * Create, update, delete, and RSVP to Google Calendar events with mandatory
 * user confirmation for all operations.
 *
 * Security: User must see the exact operation details and explicitly confirm
 * before any calendar modification. This pattern can serve as a declassification
 * gate when policies are implemented (patterns with verified SHA can be trusted).
 *
 * Usage:
 * 1. Create and favorite a Google Auth charm with "Calendar (create/edit/delete events)" permission
 * 2. Create a Calendar Event Manager charm
 * 3. Fill out event details or select an existing event
 * 4. Click the action button (Create/Update/Delete/RSVP)
 * 5. Review the confirmation dialog showing exactly what will happen
 * 6. Confirm to execute the operation
 *
 * Multi-account support: Use createGoogleAuth() with accountType parameter
 * to wish for #googleAuthPersonal or #googleAuthWork accounts.
 * See: gmail-importer.tsx for an example with account switching dropdown.
 */

import {
  Default,
  derive,
  handler,
  ifElse,
  NAME,
  pattern,
  UI,
  Writable,
} from "commontools";
import {
  CalendarWriteClient,
  type RSVPStatus,
} from "../util/calendar-write-client.ts";
import {
  type Auth,
  createGoogleAuth,
  type ScopeKey,
} from "../util/google-auth-manager.tsx";

// ============================================================================
// TYPES
// ============================================================================

type CalendarOperation = "create" | "update" | "delete" | "rsvp";

type EventDraft = {
  /** Event title/summary */
  summary: Default<string, "">;
  /** Start datetime (ISO or datetime-local format) */
  start: Default<string, "">;
  /** End datetime (ISO or datetime-local format) */
  end: Default<string, "">;
  /** Calendar ID (primary for main calendar) */
  calendarId: Default<string, "primary">;
  /** Event description */
  description: Default<string, "">;
  /** Event location */
  location: Default<string, "">;
  /** Attendee emails (comma-separated) */
  attendeesText: Default<string, "">;
};

type ExistingEvent = {
  /** Event ID for update/delete/rsvp */
  id: string;
  /** Calendar ID */
  calendarId: string;
  /** Event summary for display */
  summary?: string;
} | null;

type PendingOperation = {
  operation: CalendarOperation;
  event: {
    summary: string;
    start: string;
    end: string;
    calendarId: string;
    description?: string;
    location?: string;
    attendees?: string[];
  };
  existingEventId?: string;
  rsvpStatus?: RSVPStatus;
} | null;

type OperationResult = {
  success: boolean;
  operation: CalendarOperation;
  eventId?: string;
  error?: string;
  timestamp?: string;
} | null;

interface Input {
  /** Event draft for creating/editing */
  draft: Default<
    EventDraft,
    {
      summary: "";
      start: "";
      end: "";
      calendarId: "primary";
      description: "";
      location: "";
      attendeesText: "";
    }
  >;
  /** Existing event for update/delete/rsvp operations */
  existingEvent: Default<ExistingEvent, null>;
}

/** Google Calendar event manager for creating/editing/deleting events. #calendarManager */
interface Output {
  draft: EventDraft;
  existingEvent: ExistingEvent;
  result: OperationResult;
}

// ============================================================================
// HELPERS
// ============================================================================

function formatDateTime(iso: string): string {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      weekday: "short",
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function parseAttendees(text: string): string[] {
  if (!text || text.trim() === "") return [];
  return text
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "" && s.includes("@"));
}

function getOperationWarning(op: PendingOperation): {
  title: string;
  desc: string;
} {
  if (!op) return { title: "", desc: "" };

  const hasAttendees = op.event.attendees && op.event.attendees.length > 0;

  switch (op.operation) {
    case "create":
      return {
        title: "This will create a real calendar event",
        desc: hasAttendees
          ? `Invitations will be sent to ${
            op.event.attendees!.length
          } attendee(s).`
          : "The event will appear on your Google Calendar.",
      };
    case "update":
      return {
        title: "This will update the calendar event",
        desc: hasAttendees
          ? "Attendees will be notified of the changes."
          : "The event will be modified on your calendar.",
      };
    case "delete":
      return {
        title: "This will permanently delete the event",
        desc: hasAttendees
          ? "Attendees will be notified of the cancellation."
          : "This action cannot be undone.",
      };
    case "rsvp":
      return {
        title: `You are responding "${op.rsvpStatus}"`,
        desc: "The organizer will be notified of your response.",
      };
  }
}

// ============================================================================
// HANDLERS
// ============================================================================

const prepareCreate = handler<
  unknown,
  { draft: Writable<EventDraft>; pendingOp: Writable<PendingOperation> }
>((_, { draft, pendingOp }) => {
  const d = draft.get();
  pendingOp.set({
    operation: "create",
    event: {
      summary: d.summary,
      start: d.start,
      end: d.end,
      calendarId: d.calendarId || "primary",
      description: d.description,
      location: d.location,
      attendees: parseAttendees(d.attendeesText),
    },
  });
});

const prepareUpdate = handler<
  unknown,
  {
    draft: Writable<EventDraft>;
    existingEvent: Writable<ExistingEvent>;
    pendingOp: Writable<PendingOperation>;
  }
>((_, { draft, existingEvent, pendingOp }) => {
  const d = draft.get();
  const existing = existingEvent.get();
  if (!existing?.id) return;

  pendingOp.set({
    operation: "update",
    event: {
      summary: d.summary,
      start: d.start,
      end: d.end,
      calendarId: existing.calendarId || d.calendarId || "primary",
      description: d.description,
      location: d.location,
      attendees: parseAttendees(d.attendeesText),
    },
    existingEventId: existing.id,
  });
});

const prepareDelete = handler<
  unknown,
  {
    draft: Writable<EventDraft>;
    existingEvent: Writable<ExistingEvent>;
    pendingOp: Writable<PendingOperation>;
  }
>((_, { draft, existingEvent, pendingOp }) => {
  const d = draft.get();
  const existing = existingEvent.get();
  if (!existing?.id) return;

  pendingOp.set({
    operation: "delete",
    event: {
      summary: existing.summary || d.summary,
      start: d.start,
      end: d.end,
      calendarId: existing.calendarId || d.calendarId || "primary",
    },
    existingEventId: existing.id,
  });
});

const prepareRsvp = handler<
  unknown,
  {
    status: RSVPStatus;
    draft: Writable<EventDraft>;
    existingEvent: Writable<ExistingEvent>;
    pendingOp: Writable<PendingOperation>;
  }
>((_, { status, draft, existingEvent, pendingOp }) => {
  const d = draft.get();
  const existing = existingEvent.get();
  if (!existing?.id) return;

  pendingOp.set({
    operation: "rsvp",
    event: {
      summary: existing.summary || d.summary,
      start: d.start,
      end: d.end,
      calendarId: existing.calendarId || d.calendarId || "primary",
    },
    existingEventId: existing.id,
    rsvpStatus: status,
  });
});

const cancelOperation = handler<
  unknown,
  { pendingOp: Writable<PendingOperation> }
>(
  (_, { pendingOp }) => {
    pendingOp.set(null);
  },
);

const confirmOperation = handler<
  unknown,
  {
    pendingOp: Writable<PendingOperation>;
    auth: Writable<Auth>;
    processing: Writable<boolean>;
    result: Writable<OperationResult>;
    draft: Writable<EventDraft>;
    existingEvent: Writable<ExistingEvent>;
  }
>(
  async (
    _,
    { pendingOp, auth, processing, result, draft, existingEvent },
  ) => {
    const op = pendingOp.get();
    if (!op) return;

    processing.set(true);
    result.set(null);

    try {
      const client = new CalendarWriteClient(auth, { debugMode: true });
      let eventId: string | undefined;

      switch (op.operation) {
        case "create": {
          const created = await client.createEvent({
            calendarId: op.event.calendarId,
            summary: op.event.summary,
            start: op.event.start,
            end: op.event.end,
            description: op.event.description,
            location: op.event.location,
            attendees: op.event.attendees,
            sendUpdates: "all",
          });
          eventId = created.id;
          break;
        }
        case "update": {
          const updated = await client.updateEvent(
            op.event.calendarId,
            op.existingEventId!,
            {
              summary: op.event.summary,
              start: op.event.start,
              end: op.event.end,
              description: op.event.description,
              location: op.event.location,
              attendees: op.event.attendees,
            },
            "all",
          );
          eventId = updated.id;
          break;
        }
        case "delete": {
          await client.deleteEvent(
            op.event.calendarId,
            op.existingEventId!,
            "all",
          );
          break;
        }
        case "rsvp": {
          const rsvped = await client.rsvpToEvent(
            op.event.calendarId,
            op.existingEventId!,
            op.rsvpStatus!,
          );
          eventId = rsvped.id;
          break;
        }
      }

      result.set({
        success: true,
        operation: op.operation,
        eventId,
        timestamp: new Date().toISOString(),
      });

      pendingOp.set(null);

      // Clear draft on create success
      if (op.operation === "create") {
        draft.set({
          summary: "",
          start: "",
          end: "",
          calendarId: "primary",
          description: "",
          location: "",
          attendeesText: "",
        });
      }

      // Clear existing event on delete
      if (op.operation === "delete") {
        existingEvent.set(null);
      }
    } catch (error) {
      result.set({
        success: false,
        operation: op.operation,
        error: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString(),
      });
      // Close confirmation modal on error
      pendingOp.set(null);
    } finally {
      processing.set(false);
    }
  },
);

const dismissResult = handler<unknown, { result: Writable<OperationResult> }>(
  (_, { result }) => {
    result.set(null);
  },
);

// ============================================================================
// PATTERN
// ============================================================================

export default pattern<Input, Output>(({ draft, existingEvent }) => {
  // Auth via createGoogleAuth utility - handles discovery, validation, and UI
  const { auth, fullUI, isReady } = createGoogleAuth({
    requiredScopes: ["calendar", "calendarWrite"] as ScopeKey[],
  });
  const hasAuth = isReady;

  // UI state
  const pendingOp = Writable.of<PendingOperation>(null);
  const processing = Writable.of(false);
  const result = Writable.of<OperationResult>(null);

  // Computed helpers
  const hasExistingEvent = derive(existingEvent, (e) => !!e?.id);
  const canCreate = derive(
    { hasAuth, draft, processing },
    ({ hasAuth, draft, processing }) =>
      hasAuth &&
      draft.summary.trim() !== "" &&
      draft.start.trim() !== "" &&
      draft.end.trim() !== "" &&
      !processing,
  );

  return {
    [NAME]: "Calendar Manager",
    [UI]: (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "16px",
          padding: "20px",
          maxWidth: "700px",
        }}
      >
        <h2 style={{ fontSize: "24px", fontWeight: "bold", margin: "0" }}>
          Calendar Event Manager
        </h2>

        {/* Auth status - handled by createGoogleAuth utility */}
        {fullUI}

        {/* Result display */}
        {ifElse(
          derive(result, (r: OperationResult) => r?.success === true),
          <div
            style={{
              padding: "16px",
              background: "#d1fae5",
              borderRadius: "8px",
              border: "1px solid #10b981",
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "flex-start",
              }}
            >
              <div>
                <div
                  style={{
                    fontWeight: "bold",
                    marginBottom: "4px",
                    color: "#065f46",
                  }}
                >
                  {derive(result, (r: OperationResult) => {
                    switch (r?.operation) {
                      case "create":
                        return "Event Created!";
                      case "update":
                        return "Event Updated!";
                      case "delete":
                        return "Event Deleted!";
                      case "rsvp":
                        return "RSVP Sent!";
                      default:
                        return "Success!";
                    }
                  })}
                </div>
                {ifElse(
                  derive(result, (r: OperationResult) => !!r?.eventId),
                  <div style={{ fontSize: "12px", color: "#047857" }}>
                    Event ID:{" "}
                    {derive(result, (r: OperationResult) => r?.eventId)}
                  </div>,
                  null,
                )}
              </div>
              <button
                type="button"
                onClick={dismissResult({ result })}
                style={{
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  fontSize: "18px",
                  color: "#065f46",
                }}
              >
                ×
              </button>
            </div>
          </div>,
          null,
        )}

        {ifElse(
          derive(result, (r: OperationResult) => r?.success === false),
          <div
            style={{
              padding: "16px",
              background: "#fee2e2",
              borderRadius: "8px",
              border: "1px solid #ef4444",
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "flex-start",
              }}
            >
              <div>
                <div
                  style={{
                    fontWeight: "bold",
                    marginBottom: "4px",
                    color: "#991b1b",
                  }}
                >
                  Operation Failed
                </div>
                <div style={{ fontSize: "14px", color: "#b91c1c" }}>
                  {derive(result, (r: OperationResult) => r?.error)}
                </div>
              </div>
              <button
                type="button"
                onClick={dismissResult({ result })}
                style={{
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  fontSize: "18px",
                  color: "#991b1b",
                }}
              >
                ×
              </button>
            </div>
          </div>,
          null,
        )}

        {/* Event form */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "12px",
            padding: "16px",
            background: "#f9fafb",
            borderRadius: "8px",
            border: "1px solid #e5e7eb",
          }}
        >
          {/* Existing event indicator */}
          {ifElse(
            hasExistingEvent,
            <div
              style={{
                padding: "8px 12px",
                background: "#dbeafe",
                borderRadius: "6px",
                fontSize: "13px",
                color: "#1e40af",
              }}
            >
              Editing event:{" "}
              <strong>
                {derive(
                  existingEvent,
                  (e: ExistingEvent) => e?.summary || e?.id,
                )}
              </strong>
            </div>,
            null,
          )}

          <div>
            <label
              style={{
                display: "block",
                marginBottom: "4px",
                fontWeight: "500",
                fontSize: "14px",
              }}
            >
              Event Title <span style={{ color: "#ef4444" }}>*</span>
            </label>
            <ct-input
              type="text"
              $value={draft.summary}
              placeholder="Team Meeting"
              style="width: 100%; padding: 8px 12px;"
            />
          </div>

          <div style={{ display: "flex", gap: "12px" }}>
            <div style={{ flex: 1 }}>
              <label
                style={{
                  display: "block",
                  marginBottom: "4px",
                  fontWeight: "500",
                  fontSize: "14px",
                }}
              >
                Start <span style={{ color: "#ef4444" }}>*</span>
              </label>
              <ct-input
                type="datetime-local"
                $value={draft.start}
                style="width: 100%; padding: 8px 12px;"
              />
            </div>
            <div style={{ flex: 1 }}>
              <label
                style={{
                  display: "block",
                  marginBottom: "4px",
                  fontWeight: "500",
                  fontSize: "14px",
                }}
              >
                End <span style={{ color: "#ef4444" }}>*</span>
              </label>
              <ct-input
                type="datetime-local"
                $value={draft.end}
                style="width: 100%; padding: 8px 12px;"
              />
            </div>
          </div>

          <div>
            <label
              style={{
                display: "block",
                marginBottom: "4px",
                fontWeight: "500",
                fontSize: "14px",
              }}
            >
              Location
            </label>
            <ct-input
              type="text"
              $value={draft.location}
              placeholder="Conference Room A / Zoom link"
              style="width: 100%; padding: 8px 12px;"
            />
          </div>

          <div>
            <label
              style={{
                display: "block",
                marginBottom: "4px",
                fontWeight: "500",
                fontSize: "14px",
              }}
            >
              Description
            </label>
            <ct-input
              $value={draft.description}
              placeholder="Event details and agenda..."
              style="width: 100%; padding: 8px 12px; min-height: 80px;"
            />
          </div>

          <div>
            <label
              style={{
                display: "block",
                marginBottom: "4px",
                fontWeight: "500",
                fontSize: "14px",
              }}
            >
              Attendees (comma-separated emails)
            </label>
            <ct-input
              type="text"
              $value={draft.attendeesText}
              placeholder="alice@example.com, bob@example.com"
              style="width: 100%; padding: 8px 12px;"
            />
          </div>

          {/* Action buttons */}
          <div
            style={{ display: "flex", gap: "12px", flexWrap: "wrap" }}
          >
            {/* Create button (shown when no existing event) */}
            {ifElse(
              hasExistingEvent,
              null,
              <button
                type="button"
                onClick={prepareCreate({ draft, pendingOp })}
                disabled={derive(canCreate, (can) => !can)}
                style={{
                  padding: "12px 24px",
                  background: "#2563eb",
                  color: "white",
                  border: "none",
                  borderRadius: "6px",
                  fontSize: "14px",
                  fontWeight: "500",
                  cursor: "pointer",
                  opacity: derive(canCreate, (can) => (can ? 1 : 0.5)),
                }}
              >
                Create Event
              </button>,
            )}

            {/* Update/Delete/RSVP buttons (shown when existing event) */}
            {ifElse(
              hasExistingEvent,
              <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                <button
                  type="button"
                  onClick={prepareUpdate({ draft, existingEvent, pendingOp })}
                  disabled={derive(canCreate, (can) => !can)}
                  style={{
                    padding: "10px 20px",
                    background: "#2563eb",
                    color: "white",
                    border: "none",
                    borderRadius: "6px",
                    fontSize: "14px",
                    fontWeight: "500",
                    cursor: "pointer",
                    opacity: derive(canCreate, (can) => (can ? 1 : 0.5)),
                  }}
                >
                  Update Event
                </button>
                <button
                  type="button"
                  onClick={prepareDelete({ draft, existingEvent, pendingOp })}
                  disabled={processing}
                  style={{
                    padding: "10px 20px",
                    background: "#dc2626",
                    color: "white",
                    border: "none",
                    borderRadius: "6px",
                    fontSize: "14px",
                    fontWeight: "500",
                    cursor: "pointer",
                  }}
                >
                  Delete Event
                </button>
                <div
                  style={{
                    display: "flex",
                    gap: "4px",
                    marginLeft: "8px",
                    alignItems: "center",
                  }}
                >
                  <span
                    style={{
                      fontSize: "13px",
                      color: "#6b7280",
                      marginRight: "4px",
                    }}
                  >
                    RSVP:
                  </span>
                  <button
                    type="button"
                    onClick={prepareRsvp({
                      status: "accepted",
                      draft,
                      existingEvent,
                      pendingOp,
                    })}
                    disabled={processing}
                    style={{
                      padding: "8px 12px",
                      background: "#10b981",
                      color: "white",
                      border: "none",
                      borderRadius: "6px",
                      fontSize: "13px",
                      cursor: "pointer",
                    }}
                  >
                    Accept
                  </button>
                  <button
                    type="button"
                    onClick={prepareRsvp({
                      status: "tentative",
                      draft,
                      existingEvent,
                      pendingOp,
                    })}
                    disabled={processing}
                    style={{
                      padding: "8px 12px",
                      background: "#f59e0b",
                      color: "white",
                      border: "none",
                      borderRadius: "6px",
                      fontSize: "13px",
                      cursor: "pointer",
                    }}
                  >
                    Maybe
                  </button>
                  <button
                    type="button"
                    onClick={prepareRsvp({
                      status: "declined",
                      draft,
                      existingEvent,
                      pendingOp,
                    })}
                    disabled={processing}
                    style={{
                      padding: "8px 12px",
                      background: "#ef4444",
                      color: "white",
                      border: "none",
                      borderRadius: "6px",
                      fontSize: "13px",
                      cursor: "pointer",
                    }}
                  >
                    Decline
                  </button>
                </div>
              </div>,
              null,
            )}
          </div>
        </div>

        {/* CONFIRMATION DIALOG */}
        {ifElse(
          derive(pendingOp, (op: PendingOperation) => op !== null),
          <div
            style={{
              position: "fixed",
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              background: "rgba(0, 0, 0, 0.5)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              zIndex: 1000,
            }}
          >
            <div
              style={{
                background: "white",
                borderRadius: "12px",
                maxWidth: "600px",
                width: "90%",
                maxHeight: "90vh",
                overflow: "auto",
                boxShadow: "0 25px 50px -12px rgba(0, 0, 0, 0.25)",
              }}
            >
              {/* Header */}
              <div
                style={{
                  padding: "20px",
                  borderBottom: derive(
                    pendingOp,
                    (op: PendingOperation) =>
                      `2px solid ${
                        op?.operation === "delete" ? "#dc2626" : "#2563eb"
                      }`,
                  ),
                  display: "flex",
                  alignItems: "center",
                  gap: "12px",
                }}
              >
                <span style={{ fontSize: "24px" }}>
                  {derive(pendingOp, (op: PendingOperation) => {
                    switch (op?.operation) {
                      case "create":
                        return "📅";
                      case "update":
                        return "✏️";
                      case "delete":
                        return "🗑️";
                      case "rsvp":
                        return "📬";
                      default:
                        return "📅";
                    }
                  })}
                </span>
                <h3
                  style={{
                    margin: 0,
                    fontSize: "20px",
                    color: derive(
                      pendingOp,
                      (op: PendingOperation) =>
                        op?.operation === "delete" ? "#dc2626" : "#2563eb",
                    ),
                  }}
                >
                  {derive(pendingOp, (op: PendingOperation) => {
                    switch (op?.operation) {
                      case "create":
                        return "Create Event";
                      case "update":
                        return "Update Event";
                      case "delete":
                        return "Delete Event";
                      case "rsvp":
                        return "RSVP to Event";
                      default:
                        return "Confirm";
                    }
                  })}
                </h3>
              </div>

              {/* Content */}
              <div style={{ padding: "20px" }}>
                <div
                  style={{
                    background: "#f9fafb",
                    borderRadius: "8px",
                    padding: "16px",
                    marginBottom: "16px",
                  }}
                >
                  {/* Event summary */}
                  <div
                    style={{
                      fontSize: "18px",
                      fontWeight: "600",
                      marginBottom: "12px",
                    }}
                  >
                    {derive(
                      pendingOp,
                      (op: PendingOperation) => op?.event.summary || "Untitled",
                    )}
                  </div>

                  {/* Time */}
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "8px",
                      marginBottom: "8px",
                      color: "#4b5563",
                    }}
                  >
                    <span>🕐</span>
                    <span>
                      {derive(pendingOp, (op: PendingOperation) =>
                        op?.event.start
                          ? `${formatDateTime(op.event.start)} - ${
                            formatDateTime(op.event.end)
                          }`
                          : "")}
                    </span>
                  </div>

                  {/* Location */}
                  {ifElse(
                    derive(
                      pendingOp,
                      (op: PendingOperation) =>
                        !!op?.event.location,
                    ),
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "8px",
                        marginBottom: "8px",
                        color: "#4b5563",
                      }}
                    >
                      <span>📍</span>
                      <span>
                        {derive(pendingOp, (op: PendingOperation) =>
                          op?.event.location)}
                      </span>
                    </div>,
                    null,
                  )}

                  {/* Attendees */}
                  {ifElse(
                    derive(
                      pendingOp,
                      (op: PendingOperation) =>
                        op?.event.attendees && op.event.attendees.length > 0,
                    ),
                    <div
                      style={{
                        marginTop: "12px",
                        paddingTop: "12px",
                        borderTop: "1px solid #e5e7eb",
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: "8px",
                          fontWeight: "500",
                          marginBottom: "8px",
                        }}
                      >
                        <span>👥</span>
                        <span>
                          Attendees (
                          {derive(
                            pendingOp,
                            (op: PendingOperation) =>
                              op?.event.attendees?.length || 0,
                          )}
                          )
                        </span>
                      </div>
                      <div
                        style={{
                          display: "flex",
                          flexWrap: "wrap",
                          gap: "6px",
                        }}
                      >
                        {derive(pendingOp, (op: PendingOperation) =>
                          (op?.event.attendees || []).map((email) => (
                            <span
                              style={{
                                background: "white",
                                border: "1px solid #e5e7eb",
                                borderRadius: "16px",
                                padding: "4px 10px",
                                fontSize: "13px",
                              }}
                            >
                              {email}
                            </span>
                          )))}
                      </div>
                    </div>,
                    null,
                  )}

                  {/* RSVP status indicator */}
                  {ifElse(
                    derive(
                      pendingOp,
                      (op: PendingOperation) =>
                        op?.operation === "rsvp" && !!op?.rsvpStatus,
                    ),
                    <div
                      style={{
                        marginTop: "12px",
                        padding: "8px 12px",
                        borderRadius: "6px",
                        textAlign: "center",
                        background: derive(
                          pendingOp,
                          (op: PendingOperation) => {
                            switch (op?.rsvpStatus) {
                              case "accepted":
                                return "#d1fae5";
                              case "declined":
                                return "#fee2e2";
                              case "tentative":
                                return "#fef3c7";
                              default:
                                return "#f3f4f6";
                            }
                          },
                        ),
                      }}
                    >
                      Your response:{" "}
                      <strong>
                        {derive(
                          pendingOp,
                          (op: PendingOperation) =>
                            op?.rsvpStatus,
                        )}
                      </strong>
                    </div>,
                    null,
                  )}
                </div>

                {/* Warning */}
                <div
                  style={{
                    padding: "12px 16px",
                    borderRadius: "8px",
                    border: derive(
                      pendingOp,
                      (op: PendingOperation) =>
                        op?.operation === "delete"
                          ? "1px solid #ef4444"
                          : "1px solid #f59e0b",
                    ),
                    background: derive(
                      pendingOp,
                      (op: PendingOperation) =>
                        op?.operation === "delete" ? "#fee2e2" : "#fef3c7",
                    ),
                  }}
                >
                  <div
                    style={{
                      fontWeight: "600",
                      marginBottom: "4px",
                      color: derive(
                        pendingOp,
                        (op: PendingOperation) =>
                          op?.operation === "delete" ? "#991b1b" : "#92400e",
                      ),
                    }}
                  >
                    {derive(
                      pendingOp,
                      (op: PendingOperation) =>
                        getOperationWarning(op).title,
                    )}
                  </div>
                  <div
                    style={{
                      fontSize: "14px",
                      color: derive(
                        pendingOp,
                        (op: PendingOperation) =>
                          op?.operation === "delete" ? "#b91c1c" : "#78350f",
                      ),
                    }}
                  >
                    {derive(
                      pendingOp,
                      (op: PendingOperation) =>
                        getOperationWarning(op).desc,
                    )}
                  </div>
                </div>
              </div>

              {/* Footer */}
              <div
                style={{
                  padding: "16px 20px",
                  borderTop: "1px solid #e5e7eb",
                  display: "flex",
                  gap: "12px",
                  justifyContent: "flex-end",
                }}
              >
                <button
                  type="button"
                  onClick={cancelOperation({ pendingOp })}
                  disabled={processing}
                  style={{
                    padding: "10px 20px",
                    background: "white",
                    color: "#374151",
                    border: "1px solid #d1d5db",
                    borderRadius: "6px",
                    fontSize: "14px",
                    fontWeight: "500",
                    cursor: "pointer",
                  }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={confirmOperation({
                    pendingOp,
                    auth,
                    processing,
                    result,
                    draft,
                    existingEvent,
                  })}
                  disabled={processing}
                  style={{
                    padding: "10px 20px",
                    background: derive(
                      pendingOp,
                      (op: PendingOperation) =>
                        op?.operation === "delete" ? "#dc2626" : "#2563eb",
                    ),
                    color: "white",
                    border: "none",
                    borderRadius: "6px",
                    fontSize: "14px",
                    fontWeight: "500",
                    cursor: "pointer",
                    opacity: derive(processing, (p) => (p ? 0.7 : 1)),
                  }}
                >
                  {ifElse(
                    processing,
                    "Processing...",
                    derive(pendingOp, (op: PendingOperation) => {
                      switch (op?.operation) {
                        case "create":
                          return "Create Event";
                        case "update":
                          return "Update Event";
                        case "delete":
                          return "Delete Event";
                        case "rsvp":
                          return "Send RSVP";
                        default:
                          return "Confirm";
                      }
                    }),
                  )}
                </button>
              </div>
            </div>
          </div>,
          null,
        )}
      </div>
    ),
    draft,
    existingEvent,
    result,
  };
});
