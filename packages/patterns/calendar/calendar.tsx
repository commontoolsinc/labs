/// <cts-enable />
import {
  action,
  computed,
  Default,
  equals,
  NAME,
  navigateTo,
  pattern,
  Stream,
  UI,
  type VNode,
  Writable,
} from "commontools";

import EventDetail, { type Event } from "./event-detail.tsx";

// Re-export for consumers and tests
export type { Event };

interface CalendarInput {
  events?: Writable<Default<Event[], []>>;
}

interface CalendarOutput {
  [NAME]: string;
  [UI]: VNode;
  events: Event[];
  todayDate: string;
  addEvent: Stream<{ title: string; date: string; time: string }>;
  removeEvent: Stream<{ event: Event }>;
}

const getTodayDate = (): string => {
  const now = new Date();
  return now.toISOString().split("T")[0];
};

const formatDate = (date: string): string => {
  if (!date) return "";
  const d = new Date(date + "T00:00:00");
  return d.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
};

const isToday = (date: string): boolean => date === getTodayDate();
const isPast = (date: string): boolean => date < getTodayDate();

export default pattern<CalendarInput, CalendarOutput>(({ events }) => {
  const todayDate = getTodayDate();

  const newTitle = Writable.of("");
  const newDate = Writable.of(todayDate);
  const newTime = Writable.of("");

  const eventCount = computed(() => events.get().length);

  const sortedEvents = computed((): Event[] => {
    const all = events.get();
    if (!Array.isArray(all)) return [];
    return [...all].sort((a, b) => {
      const aDate = a.date.get();
      const bDate = b.date.get();
      if (aDate !== bDate) return aDate.localeCompare(bDate);
      return (a.time.get() || "").localeCompare(b.time.get() || "");
    });
  });

  const addEvent = action(
    ({ title, date, time }: { title: string; date: string; time: string }) => {
      const trimmed = title.trim();
      if (trimmed && date) {
        events.push({ title: trimmed, date, time, notes: "" });
        newTitle.set("");
        newTime.set("");
      }
    },
  );

  const removeEvent = action(({ event }: { event: Event }) => {
    const current = events.get();
    const idx = current.findIndex((e) => equals(event, e));
    if (idx >= 0) {
      events.set(current.toSpliced(idx, 1));
    }
  });

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
            {computed(() => {
              const sorted = sortedEvents;
              if (sorted.length === 0) {
                return (
                  <div style="text-align: center; color: var(--ct-color-gray-500); padding: 2rem;">
                    No events yet. Add one below!
                  </div>
                );
              }

              let lastDate = "";
              return sorted.flatMap((event) => {
                const date = event.date.get();
                const items = [];

                if (date !== lastDate) {
                  lastDate = date;
                  const dateIsToday = isToday(date);
                  const dateIsPast = isPast(date);
                  items.push(
                    <ct-hstack gap="2" align="center">
                      <span
                        style={{
                          fontWeight: "600",
                          fontSize: "0.875rem",
                          color: dateIsToday
                            ? "var(--ct-color-primary-500)"
                            : dateIsPast
                              ? "var(--ct-color-gray-400)"
                              : "var(--ct-color-gray-700)",
                        }}
                      >
                        {formatDate(date)}
                      </span>
                      {dateIsToday
                        ? (
                          <span style="font-size: 0.75rem; background: var(--ct-color-primary-100); color: var(--ct-color-primary-700); padding: 0.125rem 0.5rem; border-radius: 999px;">
                            Today
                          </span>
                        )
                        : null}
                    </ct-hstack>,
                  );
                }

                items.push(
                  <ct-card
                    style="cursor: pointer;"
                    onClick={() => {
                      const detail = EventDetail({ event });
                      return navigateTo(detail);
                    }}
                  >
                    <ct-hstack gap="2" align="center">
                      {event.time && (
                        <span style="font-size: 0.875rem; color: var(--ct-color-gray-500); min-width: 50px;">
                          {event.time}
                        </span>
                      )}
                      <span style="flex: 1; font-weight: 500;">
                        {event.title || "(untitled)"}
                      </span>
                      <ct-button
                        variant="ghost"
                        onClick={() => removeEvent.send({ event })}
                      >
                        ×
                      </ct-button>
                    </ct-hstack>
                  </ct-card>,
                );

                return items;
              });
            })}
          </ct-vstack>
        </ct-vscroll>

        <ct-vstack slot="footer" gap="2" style="padding: 1rem;">
          <ct-hstack gap="2">
            <ct-input
              $value={newTitle}
              placeholder="Event title..."
              style="flex: 1;"
            />
            <ct-input $value={newDate} type="date" style="width: 140px;" />
            <ct-input $value={newTime} type="time" style="width: 100px;" />
            <ct-button
              variant="primary"
              onClick={() =>
                addEvent.send({
                  title: newTitle.get(),
                  date: newDate.get(),
                  time: newTime.get(),
                })}
            >
              Add
            </ct-button>
          </ct-hstack>
        </ct-vstack>
      </ct-screen>
    ),
    events,
    todayDate,
    addEvent,
    removeEvent,
  };
});
