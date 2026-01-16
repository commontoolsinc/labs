/// <cts-enable />
import { computed, Default, NAME, pattern, UI, Writable } from "commontools";

interface Event {
  title: Writable<string>;
  date: Writable<string>;
  time: Writable<Default<string, "">>;
  notes: Writable<Default<string, "">>;
}

interface Input {
  event: Event;
}

/** #event */
interface Output {
  event: Event;
}

export default pattern<Input, Output>(({ event }) => {
  return {
    [NAME]: computed(() => `Event: ${event.title}`),
    [UI]: (
      <ct-screen>
        <ct-vstack slot="header">
          <ct-heading level={4}>{event.title || "New Event"}</ct-heading>
        </ct-vstack>

        <ct-vscroll flex showScrollbar fadeEdges>
          <ct-vstack gap="3" style="padding: 1rem;">
            <ct-card>
              <ct-vstack gap="2">
                <ct-vstack gap="1">
                  <label style="font-size: 0.75rem; font-weight: 500; color: var(--ct-color-gray-500);">
                    Title
                  </label>
                  <ct-input $value={event.title} placeholder="Event title" />
                </ct-vstack>

                <ct-hstack gap="2">
                  <ct-vstack gap="1" style="flex: 1;">
                    <label style="font-size: 0.75rem; font-weight: 500; color: var(--ct-color-gray-500);">
                      Date
                    </label>
                    <ct-input $value={event.date} type="date" />
                  </ct-vstack>

                  <ct-vstack gap="1" style="flex: 1;">
                    <label style="font-size: 0.75rem; font-weight: 500; color: var(--ct-color-gray-500);">
                      Time
                    </label>
                    <ct-input $value={event.time} type="time" />
                  </ct-vstack>
                </ct-hstack>
              </ct-vstack>
            </ct-card>

            <ct-card>
              <ct-vstack gap="1">
                <label style="font-size: 0.75rem; font-weight: 500; color: var(--ct-color-gray-500);">
                  Notes
                </label>
                <ct-textarea
                  $value={event.notes}
                  placeholder="Add details about this event..."
                  rows={6}
                />
              </ct-vstack>
            </ct-card>
          </ct-vstack>
        </ct-vscroll>
      </ct-screen>
    ),
    event,
  };
});
