/// <cts-enable />
/**
 * Calendar Viewer
 *
 * View your Calendar events synced via apple-sync CLI.
 * Events are stored in the `events` input cell.
 *
 * To sync events, run:
 *   ./tools/apple-sync.ts calendar
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

type CFC<T, C extends string> = T;
type Confidential<T> = CFC<T, "confidential">;

/**
 * A calendar event
 */
export type CalendarEvent = {
  id: string;
  title: string;
  startDate: string;
  endDate: string;
  location: string | null;
  notes: string | null;
  calendarName: string;
  isAllDay: boolean;
};

// Format a date for display
function formatDate(dateStr: string): string {
  try {
    const date = new Date(dateStr);
    return date.toLocaleDateString([], {
      weekday: "short",
      month: "short",
      day: "numeric",
    });
  } catch {
    return dateStr;
  }
}

// Format time for display
function formatTime(dateStr: string): string {
  try {
    const date = new Date(dateStr);
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

// Get relative date label
function getRelativeLabel(dateStr: string): string {
  try {
    const date = new Date(dateStr);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const eventDate = new Date(date);
    eventDate.setHours(0, 0, 0, 0);

    const diffDays = Math.round(
      (eventDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24),
    );

    if (diffDays === 0) return "Today";
    if (diffDays === 1) return "Tomorrow";
    if (diffDays === -1) return "Yesterday";
    if (diffDays > 1 && diffDays < 7) return formatDate(dateStr);
    return formatDate(dateStr);
  } catch {
    return dateStr;
  }
}

// Calendar color based on name
function getCalendarColor(calendarName: string): string {
  const colors: Record<string, string> = {
    Work: "#007AFF",
    Personal: "#34C759",
    Family: "#FF9500",
    Health: "#FF2D55",
    Home: "#5856D6",
  };
  return colors[calendarName] || "#8E8E93";
}

// Handler to toggle calendar visibility
const toggleCalendar = handler<
  unknown,
  { calendarName: string; hiddenCalendars: Writable<string[]> }
>((_, { calendarName, hiddenCalendars }) => {
  const current = hiddenCalendars.get() || [];
  if (current.includes(calendarName)) {
    hiddenCalendars.set(current.filter((c) => c !== calendarName));
  } else {
    hiddenCalendars.set([...current, calendarName]);
  }
});

export default pattern<{
  events: Default<Confidential<CalendarEvent[]>, []>;
}>(({ events }) => {
  const hiddenCalendars = Writable.of<string[]>([]);

  const eventCount = derive(
    events,
    (evts: CalendarEvent[]) => evts?.length ?? 0,
  );

  // Extract unique calendar names for the filter bar
  // Refactored to use filter/map after CT-1102 fix
  const uniqueCalendars = derive(
    events,
    (evts: CalendarEvent[]) =>
      [
        ...new Set(
          (evts || []).filter((evt) => evt?.calendarName).map((evt) =>
            evt.calendarName
          ),
        ),
      ].sort(),
  );

  // Upcoming events (sorted by start date)
  const upcomingEvents = derive(events, (evts: CalendarEvent[]) => {
    const now = new Date();
    return [...(evts || [])]
      .filter((e: CalendarEvent) =>
        e?.startDate && new Date(e.startDate) >= now
      )
      .sort((a: CalendarEvent, b: CalendarEvent) =>
        new Date(a.startDate).getTime() - new Date(b.startDate).getTime()
      );
  });

  const totalUpcoming = derive(
    upcomingEvents,
    (evts: CalendarEvent[]) => evts.length,
  );

  return {
    [NAME]: derive(eventCount, (count: number) => `Calendar (${count} events)`),
    [UI]: (
      <ct-screen
        style={{
          display: "flex",
          flexDirection: "column",
          backgroundColor: "#f5f5f5",
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: "12px 16px",
            backgroundColor: "#fff",
            borderBottom: "1px solid #e0e0e0",
            display: "flex",
            alignItems: "center",
            gap: "12px",
          }}
        >
          <span style={{ fontSize: "24px" }}>Calendar</span>
        </div>

        {/* Calendar Filter Bar */}
        {ifElse(
          derive(eventCount, (c: number) => c > 0),
          <div
            style={{
              padding: "8px 16px",
              backgroundColor: "#fff",
              borderBottom: "1px solid #e0e0e0",
              display: "flex",
              gap: "8px",
              flexWrap: "wrap",
            }}
          >
            {derive(
              { uniqueCalendars, hiddenCalendars },
              ({
                uniqueCalendars: calendars,
                hiddenCalendars: hiddenList,
              }: {
                uniqueCalendars: string[];
                hiddenCalendars: string[];
              }) =>
                (calendars || []).map((name: string) => {
                  const isHidden = (hiddenList || []).includes(name);
                  const color = getCalendarColor(name);
                  return (
                    <button
                      // Pass the Cell from outer scope, not the destructured value
                      onClick={toggleCalendar({
                        calendarName: name,
                        hiddenCalendars,
                      })}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "6px",
                        padding: "4px 10px",
                        borderRadius: "16px",
                        border: "1px solid #ddd",
                        backgroundColor: isHidden ? "#f5f5f5" : "#fff",
                        opacity: isHidden ? 0.5 : 1,
                        cursor: "pointer",
                        fontSize: "13px",
                      }}
                    >
                      <span
                        style={{
                          width: "8px",
                          height: "8px",
                          borderRadius: "4px",
                          backgroundColor: color,
                        }}
                      />
                      {name}
                    </button>
                  );
                }),
            )}
          </div>,
          <></>,
        )}

        {/* Content */}
        <div style={{ flex: 1, overflow: "auto" }}>
          {ifElse(
            derive(eventCount, (c: number) => c === 0),
            // Empty state
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                height: "100%",
                color: "#666",
                padding: "20px",
                textAlign: "center",
              }}
            >
              <div style={{ fontSize: "48px", marginBottom: "16px" }}>
                Calendar
              </div>
              <div
                style={{
                  fontSize: "18px",
                  fontWeight: "bold",
                  marginBottom: "8px",
                }}
              >
                No Events Yet
              </div>
              <div style={{ fontSize: "14px", maxWidth: "300px" }}>
                Run the apple-sync CLI to import your calendar events:
                <pre
                  style={{
                    backgroundColor: "#e0e0e0",
                    padding: "8px 12px",
                    borderRadius: "4px",
                    marginTop: "12px",
                    fontSize: "12px",
                  }}
                >
                  ./tools/apple-sync.ts calendar
                </pre>
              </div>
            </div>,
            /*
             * Paginated event preview - showing 10 events at a time.
             *
             * NOTE: This pagination is intentional due to performance limitations.
             * Rendering 200+ events with reactive cells causes Chrome CPU to spike
             * to 100% for extended periods. Ideally we'd show all events at once,
             * but until the framework supports virtualization or more efficient
             * rendering, we paginate to keep the UI responsive.
             *
             * See: https://linear.app/common-tools/issue/CT-1111/performance-derive-inside-map-causes-8x-more-calls-than-expected-never
             *
             * The full event data is still available via the `events` output for
             * other patterns to access via linking.
             */
            <div style={{ padding: "20px" }}>
              <div
                style={{
                  fontSize: "18px",
                  fontWeight: "bold",
                  marginBottom: "8px",
                }}
              >
                Upcoming Events ({totalUpcoming} total)
              </div>

              {derive(upcomingEvents, (evts: CalendarEvent[]) => {
                if (!evts || evts.length === 0) {
                  return (
                    <div style={{ color: "#999" }}>No upcoming events</div>
                  );
                }

                // Show first 10 events (simplified - no pagination)
                const displayEvents = evts.slice(0, 10);

                return (
                  <div>
                    {displayEvents.map((evt: CalendarEvent, idx: number) => (
                      <div
                        key={idx}
                        style={{
                          padding: "12px 16px",
                          backgroundColor: "#fff",
                          borderBottom: "1px solid #f0f0f0",
                          display: "flex",
                          gap: "12px",
                        }}
                      >
                        <div
                          style={{
                            width: "4px",
                            backgroundColor: getCalendarColor(evt.calendarName),
                            borderRadius: "2px",
                            flexShrink: 0,
                          }}
                        />
                        <div style={{ flex: 1 }}>
                          <div style={{ fontWeight: "600" }}>{evt.title}</div>
                          <div style={{ fontSize: "14px", color: "#666" }}>
                            {getRelativeLabel(evt.startDate)} {evt.isAllDay
                              ? "(All day)"
                              : formatTime(evt.startDate)}
                          </div>
                          {evt.location
                            ? (
                              <div style={{ fontSize: "13px", color: "#999" }}>
                                {evt.location}
                              </div>
                            )
                            : <></>}
                        </div>
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>,
          )}
        </div>
      </ct-screen>
    ),
    events,
  };
});
