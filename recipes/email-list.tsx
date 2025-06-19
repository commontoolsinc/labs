import { derive, h, JSONSchema, NAME, recipe, str, UI } from "commontools";

// Reuse email schema from email-summarizer.tsx
const EmailSchema = {
  type: "object",
  properties: {
    id: {
      type: "string",
      title: "Email ID",
      description: "Unique identifier for the email",
    },
    threadId: {
      type: "string",
      title: "Thread ID",
      description: "Identifier for the email thread",
    },
    labelIds: {
      type: "array",
      items: { type: "string" },
      title: "Labels",
      description: "Gmail labels assigned to the email",
    },
    snippet: {
      type: "string",
      title: "Snippet",
      description: "Brief preview of the email content",
    },
    subject: {
      type: "string",
      title: "Subject",
      description: "Email subject line",
    },
    from: {
      type: "string",
      title: "From",
      description: "Sender's email address",
    },
    date: {
      type: "string",
      title: "Date",
      description: "Date and time when the email was sent",
    },
    to: {
      type: "string",
      title: "To",
      description: "Recipient's email address",
    },
    plainText: {
      type: "string",
      title: "Plain Text Content",
      description: "Email content in plain text format (often empty)",
    },
    htmlContent: {
      type: "string",
      title: "HTML Content",
      description: "Email content in HTML format",
    },
    markdownContent: {
      type: "string",
      title: "Markdown Content",
      description: "Email content converted to Markdown format",
    },
  },
  required: [
    "id",
    "threadId",
    "labelIds",
    "snippet",
    "subject",
    "from",
    "date",
    "to",
    "plainText",
    "htmlContent",
    "markdownContent",
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
    // Include the original email as metadata
    email: EmailSchema,
  },
  required: ["title", "email"],
} as const satisfies JSONSchema;

// Input Schema
const EmailListInputSchema = {
  type: "object",
  properties: {
    emails: {
      type: "array",
      items: EmailSchema,
      default: [],
    },
    settings: {
      type: "object",
      properties: {
        titleFormat: {
          type: "string",
          enum: ["subject", "subject-from", "from-subject", "subject-date"],
          default: "subject",
          description: "Format for the list item title",
        },
        includeSnippet: {
          type: "boolean",
          default: false,
          description: "Include email snippet in the title",
        },
      },
      default: {
        titleFormat: "subject",
        includeSnippet: false,
      },
      required: ["titleFormat", "includeSnippet"],
    },
  },
  required: ["emails", "settings"],
  description: "Email List - Transforms emails into a standard list format",
} as const satisfies JSONSchema;

// Output Schema
const EmailListOutputSchema = {
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

export default recipe(
  EmailListInputSchema,
  EmailListOutputSchema,
  ({ emails, settings }) => {
    // Transform emails into list items with title field
    // NOTE(@bf): without derive I get a "Error loading and compiling recipe: Error: Can't read value during recipe creation."
    const items = derive(emails, (e) =>
      e.map((email) => {
        // Build title based on settings
        const titleParts = [];

        // Format title based on selected format
        switch (settings.titleFormat) {
          case "subject":
            titleParts.push(email.subject);
            break;
          case "subject-from":
            titleParts.push(email.subject);
            titleParts.push(`(from ${email.from})`);
            break;
          case "from-subject":
            titleParts.push(email.from);
            titleParts.push("-");
            titleParts.push(email.subject);
            break;
          case "subject-date":
            titleParts.push(email.subject);
            titleParts.push(`[${email.date}]`);
            break;
        }

        // Optionally add snippet
        if (settings.includeSnippet && email.snippet) {
          titleParts.push("-");
          titleParts.push(email.snippet);
        }

        const title = titleParts.join(" ");

        return {
          title,
          email, // Include full email as metadata
        };
      }));

    // Count emails
    const emailCount = derive(emails, (emails) => emails?.length || 0);

    // Create list title
    const listTitle = derive(
      emailCount,
      (count) => `Email List (${count} emails)`,
    );

    // NOTE(@bf): Claude Opus continues to use inline ternary by default
    const snippetLabel = derive(settings.includeSnippet, (includeSnippet) => {
      if (includeSnippet) {
        return "Yes";
      } else {
        return "No";
      }
    });

    return {
      [NAME]: listTitle,
      [UI]: (
        <os-container>
          <h2>Email List</h2>

          <div>
            <p>
              Transforms emails into a standard list format with a "title" field
              for compatibility with other list-based recipes.
            </p>
          </div>

          <div>
            <h3>Settings</h3>
            <div>
              <label>Title Format:</label>
              <span>{str`${settings.titleFormat}`}</span>
            </div>
            <div>
              <label>Include Snippet:</label>
              <span>{snippetLabel}</span>
            </div>
          </div>

          <div>
            <h3>Transformed Items ({emailCount})</h3>
            <table>
              <thead>
                <tr>
                  <th>Title</th>
                  <th>Original Subject</th>
                  <th>From</th>
                  <th>Date</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr>
                    <td>{str`${item.title}`}</td>
                    <td>{str`${item.email.subject}`}</td>
                    <td>{str`${item.email.from}`}</td>
                    <td>{str`${item.email.date}`}</td>
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
