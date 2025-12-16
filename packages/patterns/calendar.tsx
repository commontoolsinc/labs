/// <cts-enable />
import {
  Cell,
  computed,
  Default,
  ifElse,
  lift,
  NAME,
  pattern,
  UI,
} from "commontools";

interface Event {
  title: string;
  date: string;      // YYYY-MM-DD
  time: Default<string, "">;  // HH:MM or empty for all-day
  notes: Default<string, "">;
}

interface Input {
  events: Cell<Default<Event[], []>>;
}

interface Output {
  events: Event[];
  todayDate: string;
}

// Get today's date as YYYY-MM-DD
const getTodayDate = (): string => {
  const now = new Date();
  return now.toISOString().split("T")[0];
};

// Format date for display
const formatDate = lift((date: string): string => {
  if (!date) return "";
  const d = new Date(date + "T00:00:00");
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
});

// Check if date is today
const isToday = lift((date: string): boolean => {
  return date === getTodayDate();
});

// Check if date is in the past
const isPast = lift((date: string): boolean => {
  return date < getTodayDate();
});

// Sort and group events by date
const groupEventsByDate = lift((events: Event[]): Record<string, Event[]> => {
  if (!Array.isArray(events)) return {};

  const sorted = [...events].sort((a, b) => {
    if (a.date !== b.date) return a.date.localeCompare(b.date);
    return (a.time || "").localeCompare(b.time || "");
  });

  const groups: Record<string, Event[]> = {};
  for (const event of sorted) {
    if (!groups[event.date]) groups[event.date] = [];
    groups[event.date].push(event);
  }
  return groups;
});

// Get sorted dates from grouped events
const getSortedDates = lift((grouped: Record<string, Event[]>): string[] => {
  return Object.keys(grouped).sort();
});

export default pattern<Input, Output>(({ events }) => {
  const todayDate = getTodayDate();

  // Form state
  const newTitle = Cell.of("");
  const newDate = Cell.of(todayDate);
  const newTime = Cell.of("");

  const eventCount = computed(() => events.get().length);
  const grouped = groupEventsByDate(events);
  const dates = getSortedDates(grouped);

  return {
    [NAME]: "Calendar",
    [UI]: (
      <ct-screen>
        <ct-vstack slot="header" gap="1">
          <ct-hstack justify="between" align="center">
            <ct-heading level={4}>Calendar ({eventCount})</ct-heading>
            <span style="font-size: 0.875rem; color: var(--ct-color-gray-500);">
              {todayDate}
            </span>
          </ct-hstack>
        </ct-vstack>

        <ct-vscroll flex showScrollbar fadeEdges>
          <ct-vstack gap="3" style="padding: 1rem;">
            {dates.map((date) => {
              const dateEvents = lift((args: { g: Record<string, Event[]>; d: string }) => args.g[args.d] || [])({ g: grouped, d: date });
              const dateIsToday = isToday(date);
              const dateIsPast = isPast(date);

              return (
                <ct-vstack gap="1">
                  <ct-hstack gap="2" align="center">
                    <span style={{
                      fontWeight: "600",
                      fontSize: "0.875rem",
                      color: ifElse(dateIsToday, "var(--ct-color-primary-500)",
                             ifElse(dateIsPast, "var(--ct-color-gray-400)", "var(--ct-color-gray-700)")),
                    }}>
                      {formatDate(date)}
                    </span>
                    {ifElse(dateIsToday,
                      <span style="font-size: 0.75rem; background: var(--ct-color-primary-100); color: var(--ct-color-primary-700); padding: 0.125rem 0.5rem; border-radius: 999px;">
                        Today
                      </span>,
                      null
                    )}
                  </ct-hstack>

                  {dateEvents.map((event) => (
                    <ct-card>
                      <ct-hstack gap="2" align="center">
                        {event.time && (
                          <span style="font-size: 0.875rem; color: var(--ct-color-gray-500); min-width: 50px;">
                            {event.time}
                          </span>
                        )}
                        <ct-vstack gap="0" style="flex: 1;">
                          <span style="font-weight: 500;">{event.title || "(untitled)"}</span>
                          {event.notes && (
                            <span style="font-size: 0.75rem; color: var(--ct-color-gray-500);">
                              {event.notes}
                            </span>
                          )}
                        </ct-vstack>
                        <ct-button
                          variant="ghost"
                          onClick={() => {
                            const current = events.get();
                            const idx = current.findIndex((e) => Cell.equals(event, e));
                            if (idx >= 0) {
                              events.set(current.toSpliced(idx, 1));
                            }
                          }}
                        >
                          ×
                        </ct-button>
                      </ct-hstack>
                    </ct-card>
                  ))}
                </ct-vstack>
              );
            })}

            {ifElse(
              computed(() => events.get().length === 0),
              <div style="text-align: center; color: var(--ct-color-gray-500); padding: 2rem;">
                No events yet. Add one below!
              </div>,
              null
            )}
          </ct-vstack>
        </ct-vscroll>

        <ct-vstack slot="footer" gap="2" style="padding: 1rem;">
          <ct-hstack gap="2">
            <ct-input $value={newTitle} placeholder="Event title..." style="flex: 1;" />
            <ct-input $value={newDate} type="date" style="width: 140px;" />
            <ct-input $value={newTime} type="time" style="width: 100px;" />
            <ct-button
              variant="primary"
              onClick={() => {
                const title = newTitle.get().trim();
                const date = newDate.get();
                if (title && date) {
                  events.push({
                    title,
                    date,
                    time: newTime.get(),
                    notes: "",
                  });
                  newTitle.set("");
                  newTime.set("");
                }
              }}
            >
              Add
            </ct-button>
          </ct-hstack>
        </ct-vstack>
      </ct-screen>
    ),
    events,
    todayDate,
  };
});
