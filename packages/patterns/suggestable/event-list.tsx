/// <cts-enable />
import { computed, NAME, pattern, UI, type VNode, wish } from "commontools";

// ===== Types =====

type EventListInput = Record<string, never>;

type Event = {
  title: string;
  date: string;
  time: string;
  notes: string;
};

type EventListOutput = {
  [NAME]: string;
  [UI]: VNode;
  events: Event[];
};

// ===== Pattern =====

const EventList = pattern<EventListInput, EventListOutput>(() => {
  const events = wish<Event>({ query: "#event", scope: [".", "~"] });

  return {
    [NAME]: computed(() =>
      events.candidates?.length
        ? `Events: ${events.candidates?.length}`
        : "Events"
    ),
    [UI]: (
      <ct-vstack gap="2" style="padding: 1.5rem;">
        <div>
          {events.candidates.map((event) => (
            <ct-vstack
              gap="1"
              style="border: 1px solid #e0e0e0; border-radius: 8px; padding: 1rem; margin-bottom: 1rem;"
            >
              <ct-hstack gap="2" align="center">
                <strong style="font-size: 1.1em;">{event.title}</strong>
              </ct-hstack>
              <ct-hstack gap="2" align="center">
                <span style="color: #666;">📅 {event.date}</span>
                <span style="color: #666;">🕐 {event.time}</span>
              </ct-hstack>
              {event.notes && (
                <div style="color: #555; margin-top: 0.5rem;">
                  {event.notes}
                </div>
              )}
            </ct-vstack>
          ))}
        </div>
      </ct-vstack>
    ),
    events: events.candidates,
  };
});

export default EventList;
