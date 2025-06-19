import {
  derive,
  h,
  ifElse,
  JSONSchema,
  NAME,
  recipe,
  str,
  UI,
} from "commontools";

// Reuse calendar event schema from gcal.tsx
const CalendarEventSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    summary: { type: "string", default: "" },
    description: { type: "string", default: "" },
    start: { type: "string" },
    end: { type: "string" },
    location: { type: "string", default: "" },
    eventType: { type: "string", default: "" },
    hangoutLink: { type: "string", default: "" },
    attendees: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          email: { type: "string" },
          displayName: { type: "string" },
          organizer: { type: "boolean" },
          self: { type: "boolean" },
          resource: { type: "boolean" },
          optional: { type: "boolean" },
          responseStatus: { type: "string" },
          comment: { type: "string" },
          additionalGuests: { type: "integer" },
        },
        required: ["email"],
      },
      default: [],
    },
  },
  required: [
    "id",
    "start",
    "end",
    "summary",
    "description",
    "location",
    "eventType",
    "hangoutLink",
    "attendees",
  ],
} as const satisfies JSONSchema;

// Define the list item schema that matches the general pattern
const ListItemSchema = {
  type: "object",
  properties: {
    title: {
      type: "string",
      description: "The title of the list item",
    },
    // Include the original event as metadata
    event: CalendarEventSchema,
  },
  required: ["title", "event"],
} as const satisfies JSONSchema;

// Input Schema
const CalendarListInputSchema = {
  type: "object",
  properties: {
    events: {
      type: "array",
      items: CalendarEventSchema,
      default: [],
    },
  },
  required: ["events"],
  description:
    "Calendar List - Transforms calendar events into a standard list format",
} as const satisfies JSONSchema;

// Output Schema
const CalendarListOutputSchema = {
  type: "object",
  properties: {
    title: {
      type: "string",
      description: "Title of the list",
    },
    items: {
      type: "array",
      items: ListItemSchema,
      description: "List items with title field",
    },
  },
  required: ["title", "items"],
} as const satisfies JSONSchema;

// Helper function to format date/time
function formatDateTime(
  dateStr: string,
  format: string,
  includeTime: boolean,
): string {
  if (!dateStr) return "";

  try {
    const date = new Date(dateStr);

    if (format === "iso") {
      return includeTime
        ? date.toISOString()
        : date.toISOString().split("T")[0];
    }

    const options: Intl.DateTimeFormatOptions = {
      year: format === "long" ? "numeric" : "2-digit",
      month: format === "long" ? "long" : "short",
      day: "numeric",
    };

    if (includeTime) {
      options.hour = "numeric";
      options.minute = "2-digit";
    }

    return date.toLocaleString("en-US", options);
  } catch {
    return dateStr;
  }
}

export default recipe(
  CalendarListInputSchema,
  CalendarListOutputSchema,
  ({ events }) => {
    // Transform calendar events into list items with title field
    // NOTE(@bf): without derive I get a "Error loading and compiling recipe: Error: Can't read value during recipe creation."
    const items = derive(events, (evts) =>
      evts.map((event) => {
        return {
          title: event.summary || event.description,
          event, // Include full event as metadata
        };
      }));

    // Count events
    const eventCount = derive(events, (events) => events?.length || 0);

    // Create list title
    const listTitle = derive(
      eventCount,
      (count) => `Calendar List (${count} events)`,
    );

    return {
      [NAME]: listTitle,
      [UI]: (
        <os-container>
          <h2>Calendar List</h2>

          <div>
            <p>
              Transforms calendar events into a standard list format with a
              "title" field for compatibility with other list-based recipes.
            </p>
          </div>

          <div>
            <h3>Transformed Items ({eventCount})</h3>
            <table>
              <thead>
                <tr>
                  <th>Title</th>
                  <th>Original Summary</th>
                  <th>Start</th>
                  <th>End</th>
                  <th>Location</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr>
                    <td>{item.title}</td>
                    <td>{str`${item.event.summary || "Untitled"}`}</td>
                    <td>{str`${item.event.start}`}</td>
                    <td>{str`${item.event.end}`}</td>
                    <td>{str`${item.event.location || "-"}`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </os-container>
      ),
      title: listTitle,
      items,
    };
  },
);
