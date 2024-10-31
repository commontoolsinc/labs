import { html } from "@commontools/common-html";
import { recipe, handler, UI, NAME, ifElse, lift } from "@commontools/common-builder";

interface CalendarEvent {
  datetime: string;
  title: string;
  calendar: string;
  hidden: boolean;
}

const dummyCalendarData: CalendarEvent[] = [
  {
    "datetime": "2024-09-01T10:00:00",
    "calendar": "Personal",
    "title": "Quantum Physics Book Club",
    "hidden": false
  },
  {
    "datetime": "2024-09-02T09:00:00",
    "calendar": "Personal",
    "title": "Yoga in the Park",
    "hidden": false
  },
  {
    "datetime": "2024-09-03T09:00:00",
    "calendar": "Work",
    "title": "Weekly check-in (1600-Shattuck-2-Common Space)",
    "hidden": false
  },
  {
    "datetime": "2024-09-03T18:30:00",
    "calendar": "Personal",
    "title": "Cooking Class: Italian Cuisine",
    "hidden": false
  },
  {
    "datetime": "2024-09-04T08:00:00",
    "calendar": "Work",
    "title": "Bi-weekly Sprint Planning",
    "hidden": false
  },
  {
    "datetime": "2024-09-04T19:00:00",
    "calendar": "Personal",
    "title": "Movie Night with Friends",
    "hidden": false
  },
  {
    "datetime": "2024-09-05T10:00:00",
    "calendar": "Personal",
    "title": "Art Gallery Opening",
    "hidden": false
  },
  {
    "datetime": "2024-09-05T15:00:00",
    "calendar": "Work",
    "title": "Sam / Taylor 1:1",
    "hidden": false
  },
  {
    "datetime": "2024-09-05T19:00:00",
    "calendar": "Personal",
    "title": "Date Night (VR Edition)",
    "hidden": false
  },
  {
    "datetime": "2024-09-06T12:30:00",
    "calendar": "Personal",
    "title": "Lunch Break: Mindfulness Session",
    "hidden": false
  },
  {
    "datetime": "2024-09-07T07:00:00",
    "calendar": "Personal",
    "title": "Morning Hike",
    "hidden": false
  },
  {
    "datetime": "2024-09-09T07:00:00",
    "calendar": "Work",
    "title": "Regional Convergence Time",
    "hidden": false
  },
  {
    "datetime": "2024-09-10T09:00:00",
    "calendar": "Work",
    "title": "Weekly check-in (1600-Shattuck-2-Common Space)",
    "hidden": false
  },
  {
    "datetime": "2024-09-11T08:00:00",
    "calendar": "Work",
    "title": "Bi-weekly Sprint Planning",
    "hidden": false
  },
  {
    "datetime": "2024-09-11T18:00:00",
    "calendar": "Personal",
    "title": "Community Garden Volunteering",
    "hidden": false
  },
  {
    "datetime": "2024-09-12T10:00:00",
    "calendar": "Personal",
    "title": "Guitar Lesson",
    "hidden": false
  },
  {
    "datetime": "2024-09-12T15:00:00",
    "calendar": "Work",
    "title": "Sam / Taylor 1:1: AI Ethics Discussion",
    "hidden": false
  },
  {
    "datetime": "2024-09-13T16:00:00",
    "calendar": "Personal",
    "title": "Local Food Festival",
    "hidden": false
  },
  {
    "datetime": "2024-09-16T07:00:00",
    "calendar": "Work",
    "title": "Weekly check-in (1600-Shattuck-2-Common Space)",
    "hidden": false
  },
  {
    "datetime": "2024-09-16T19:30:00",
    "calendar": "Personal",
    "title": "Stargazing Night",
    "hidden": false
  },
  {
    "datetime": "2024-09-17T09:00:00",
    "calendar": "Work",
    "title": "Strategic Planning Session",
    "hidden": false
  },
  {
    "datetime": "2024-09-17T20:00:00",
    "calendar": "Personal",
    "title": "Book Club Meeting",
    "hidden": false
  },
  {
    "datetime": "2024-09-18T08:00:00",
    "calendar": "Work",
    "title": "Bi-weekly Sprint Planning",
    "hidden": false
  },
  {
    "datetime": "2024-09-19T10:00:00",
    "calendar": "Personal",
    "title": "Photography Workshop",
    "hidden": false
  },
  {
    "datetime": "2024-09-19T15:00:00",
    "calendar": "Work",
    "title": "Sam / Taylor 1:1: Project Roadmap Review",
    "hidden": false
  },
  {
    "datetime": "2024-09-21T07:00:00",
    "calendar": "Personal",
    "title": "Farmers Market Visit",
    "hidden": false
  },
  {
    "datetime": "2024-09-23T07:00:00",
    "calendar": "Work",
    "title": "Regional Convergence Time",
    "hidden": false
  },
  {
    "datetime": "2024-09-23T18:00:00",
    "calendar": "Personal",
    "title": "Pottery Class",
    "hidden": false
  },
  {
    "datetime": "2024-09-24T09:00:00",
    "calendar": "Work",
    "title": "Weekly check-in (1600-Shattuck-2-Common Space)",
    "hidden": false
  },
  {
    "datetime": "2024-09-24T19:00:00",
    "calendar": "Personal",
    "title": "Virtual Reality Game Night",
    "hidden": false
  },
  {
    "datetime": "2024-09-25T08:00:00",
    "calendar": "Work",
    "title": "Bi-weekly Sprint Planning",
    "hidden": false
  },
  {
    "datetime": "2024-09-25T18:30:00",
    "calendar": "Personal",
    "title": "Salsa Dancing Class",
    "hidden": false
  },
  {
    "datetime": "2024-09-26T10:00:00",
    "calendar": "Personal",
    "title": "Volunteer at Local Animal Shelter",
    "hidden": false
  },
  {
    "datetime": "2024-09-26T15:00:00",
    "calendar": "Work",
    "title": "Sam / Taylor 1:1: Innovation Brainstorm",
    "hidden": false
  },
  {
    "datetime": "2024-09-27T16:00:00",
    "calendar": "Personal",
    "title": "Weekend Getaway Planning",
    "hidden": false
  },
  {
    "datetime": "2024-09-30T09:00:00",
    "calendar": "Work",
    "title": "Weekly check-in (1600-Shattuck-2-Common Space)",
    "hidden": false
  },
  {
    "datetime": "2024-09-30T18:00:00",
    "calendar": "Personal",
    "title": "Meditation and Wellness Workshop",
    "hidden": false
  }
];

const startImport = handler<{}, { importing: boolean; progress: number, importedEvents: CalendarEvent[] }>(
  (_, state) => {
    state.importing = true;
    state.progress = 0;

    const importEvent = (index: number) => {
      if (index < dummyCalendarData.length) {
        setTimeout(() => {
          state.importedEvents.push(dummyCalendarData[index]);
          state.progress = ((index + 1) / dummyCalendarData.length) * 100;
          importEvent(index + 1);
        }, 25 + Math.random() * 50); // Simulate delay for each event import
      } else {
        state.importing = false;
      }
    };

    importEvent(0);
  }
);

const formatDateTime = lift((dateTimeString: string): string => {
  const date = new Date(dateTimeString);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${year}-${month}-${day} ${hours}:${minutes}`;
});

const lastEvent = lift((events: CalendarEvent[]): CalendarEvent | undefined => {
  return events[0];
});

const anyEvents = lift((events: CalendarEvent[]): boolean => {
  return events.length > 0;
});

const countEvents = lift((events: CalendarEvent[]): number => {
  return events.length;
});

export const importCalendar = recipe<{ importing: boolean, progress: number, importedEvents: CalendarEvent[] }>("Import Calendar", ({ importing, progress, importedEvents}) => {
  importing.setDefault(false)
  progress.setDefault(0)
  importedEvents.setDefault([])

  return {
    [NAME]: "Import Calendar",
    [UI]: html`
      <div>
          <label>ben@common.tools</label>
          ${ifElse(
            importing,
            html`
                <div>
                </div>
              `,
            html`
                <common-button
                  onclick=${startImport({ importing, progress, importedEvents })}
                >Import Calendar</common-button>
              `
          )}


        <div>
          <h3>Imported Events:</h3>
          <common-vstack gap="sm">
            ${ifElse(
              anyEvents(importedEvents),
              html`
                  <div>
                <div>Number of events imported: ${countEvents(importedEvents)}</div>
                  </div>
              `,
              html`<div>No events imported yet.</div>`
            )}
          </common-vstack>
        </div>
        <table>
          <thead>
            <tr>
              <th>DateTime</th>
              <th>Title</th>
              <th>Calendar</th>
            </tr>
          </thead>
          <tbody>
            ${importedEvents.map(event => html`
              <tr>
                <td>${formatDateTime(event.datetime)}</td>
                <td>${event.title}</td>
                <td>${event.calendar}</td>
              </tr>
            `)}
          </tbody>
        </table>
      </div>
    `,
    importedEvents,
  };
});
