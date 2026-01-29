/// <cts-enable />
import {
  action,
  computed,
  Default,
  NAME,
  pattern,
  Stream,
  UI,
  type VNode,
  Writable,
} from "commontools";

/** Input for creating a new event detail piece */
interface EventDetailInput {
  title?: Writable<Default<string, "">>;
  date?: Writable<Default<string, "">>;
  time?: Writable<Default<string, "">>;
  notes?: Writable<Default<string, "">>;
}

/**
 * Output shape of the event piece - this is what gets stored in calendars
 * #event
 */
interface EventDetailOutput {
  [NAME]: string;
  [UI]: VNode;
  title: string;
  date: string;
  time: string;
  notes: string;
  setTitle: Stream<{ title: string }>;
  setDate: Stream<{ date: string }>;
  setTime: Stream<{ time: string }>;
  setNotes: Stream<{ notes: string }>;
}

// Re-export the Output type as EventPiece for use in collections
export type EventPiece = EventDetailOutput;

export default pattern<EventDetailInput, EventDetailOutput>(
  ({ title, date, time, notes }) => {
    const setTitle = action(({ title: newTitle }: { title: string }) => {
      title.set(newTitle);
    });

    const setDate = action(({ date: newDate }: { date: string }) => {
      date.set(newDate);
    });

    const setTime = action(({ time: newTime }: { time: string }) => {
      time.set(newTime);
    });

    const setNotes = action(({ notes: newNotes }: { notes: string }) => {
      notes.set(newNotes);
    });

    return {
      [NAME]: computed(() => `Event: ${title.get()}`),
      [UI]: (
        <ct-screen>
          <ct-vstack slot="header">
            <ct-heading level={4}>{title || "New Event"}</ct-heading>
          </ct-vstack>

          <ct-vscroll flex showScrollbar fadeEdges>
            <ct-vstack gap="3" style="padding: 1rem;">
              <ct-card>
                <ct-vstack gap="2">
                  <ct-vstack gap="1">
                    <label style="font-size: 0.75rem; font-weight: 500; color: var(--ct-color-gray-500);">
                      Title
                    </label>
                    <ct-input $value={title} placeholder="Event title" />
                  </ct-vstack>

                  <ct-hstack gap="2">
                    <ct-vstack gap="1" style="flex: 1;">
                      <label style="font-size: 0.75rem; font-weight: 500; color: var(--ct-color-gray-500);">
                        Date
                      </label>
                      <ct-input $value={date} type="date" />
                    </ct-vstack>

                    <ct-vstack gap="1" style="flex: 1;">
                      <label style="font-size: 0.75rem; font-weight: 500; color: var(--ct-color-gray-500);">
                        Time
                      </label>
                      <ct-input $value={time} type="time" />
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
                    $value={notes}
                    placeholder="Add details about this event..."
                    rows={6}
                  />
                </ct-vstack>
              </ct-card>
            </ct-vstack>
          </ct-vscroll>
        </ct-screen>
      ),
      title,
      date,
      time,
      notes,
      setTitle,
      setDate,
      setTime,
      setNotes,
    };
  },
);
