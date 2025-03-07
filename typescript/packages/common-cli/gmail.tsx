import { h } from "@commontools/html";
import {
  cell,
  derive,
  handler,
  JSONSchema,
  NAME,
  recipe,
  Schema,
  UI,
} from "@commontools/builder";

const EmailSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    threadId: { type: "string" },
    labelIds: { type: "array", items: { type: "string" } },
    snippet: { type: "string" },
    subject: { type: "string" },
    from: { type: "string" },
    date: { type: "string" },
    to: { type: "string" },
    plainText: { type: "string" },
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
  ],
} as const as JSONSchema;
type Email = Schema<typeof EmailSchema>;

const AuthSchema = {
  type: "object",
  properties: {
    token: { type: "string" },
    tokenType: { type: "string" },
    scope: { type: "array", items: { type: "string" } },
    expiresIn: { type: "number" },
    expiresAt: { type: "number" },
    refreshToken: { type: "string" },
    user: {
      type: "object",
      properties: {
        email: { type: "string" },
        name: { type: "string" },
        picture: { type: "string" },
      },
      required: ["email", "name", "picture"],
    },
  },
  required: [
    "token",
    "tokenType",
    "scope",
    "expiresIn",
    "expiresAt",
    "refreshToken",
    "user",
  ],
} as const satisfies JSONSchema;
type Auth = Schema<typeof AuthSchema>;

const Recipe = {
  type: "object",
  properties: {
    settings: {
      type: "object",
      properties: {
        labels: {
          type: "string",
          description: "comma separated list of labels",
          default: "INBOX",
        },
        limit: {
          type: "number",
          description: "number of emails to import",
          default: 10,
        },
      },
      required: ["labels", "limit"],
    },
  },
  required: ["settings"],
  default: { settings: { labels: "INBOX", limit: 10 } },
  description: "fake gmail",
} as const satisfies JSONSchema;

const ResultSchema = {
  type: "object",
  properties: {
    emails: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          threadId: { type: "string" },
          labelIds: { type: "array", items: { type: "string" } },
          snippet: { type: "string" },
          subject: { type: "string" },
          from: { type: "string" },
          date: { type: "string" },
          to: { type: "string" },
          plainText: { type: "string" },
        },
      },
    },
    googleUpdater: { asStream: true, type: "object", properties: {} },
    auth: {
      type: "object",
      properties: {
        token: { type: "string" },
        tokenType: { type: "string" },
        scope: { type: "array", items: { type: "string" } },
        expiresIn: { type: "number" },
        expiresAt: { type: "number" },
        refreshToken: { type: "string" },
      },
    },
  },
} as const satisfies JSONSchema;

const updateLimit = handler<{ detail: { value: string } }, { limit: number }>(
  ({ detail }, state) => {
    state.limit = parseInt(detail?.value ?? "10") || 0;
  },
);

const googleUpdater = handler<
  NonNullable<unknown>,
  { emails: Email[]; auth: Auth; settings: { labels: string; limit: number } }
>((_event, state) => {
  console.log("googleUpdater!");

  if (!state.auth.token) {
    console.log("no token");
    return;
  }
  if (state.auth.expiresAt && state.auth.expiresAt < Date.now()) {
    console.log("token expired at ", state.auth.expiresAt);
    return;
  }

  // Get the set of existing email IDs for efficient lookup
  const existingEmailIds = new Set(
    (state.emails || []).map((email) => email.id),
  );

  console.log("existing email ids", existingEmailIds);

  const labels = state.settings.labels
    .split(",")
    .map((label) => label.trim())
    .filter(Boolean);

  console.log("labels", labels);

  fetchEmail(state.auth.token, state.settings.limit, labels, existingEmailIds)
    .then((emails) => {
      // Filter out any duplicates by ID
      const newEmails = emails.messages.filter((email) =>
        !existingEmailIds.has(email.id)
      );

      if (newEmails.length > 0) {
        console.log(`Adding ${newEmails.length} new emails`);
        state.emails.push(...newEmails);
      } else {
        console.log("No new emails found");
      }
    });
});

// Helper function to decode base64 encoded email parts
function decodeBase64(data: string) {
  // Replace URL-safe characters back to their original form
  const sanitized = data.replace(/-/g, "+").replace(/_/g, "/");
  // Decode the base64 string
  return atob(sanitized);
}

// Helper function to extract email address from a header value
function extractEmailAddress(header: string): string {
  const emailMatch = header.match(/<([^>]*)>/);
  if (emailMatch && emailMatch[1]) {
    return emailMatch[1];
  }
  return header;
}

// Helper function to extract header value from message headers
function getHeader(headers: any[], name: string): string {
  const header = headers.find((h) =>
    h.name.toLowerCase() === name.toLowerCase()
  );
  return header ? header.value : "";
}

export async function fetchEmail(
  accessToken: string,
  maxResults: number = 10,
  labelIds: string[] = ["INBOX"],
  existingEmailIds: Set<string>,
) {
  // First, get the list of message IDs from the inbox
  const listResponse = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?labelIds=${
      labelIds.join(
        ",",
      )
    }&maxResults=${maxResults}`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
  );

  const listData = await listResponse.json();

  if (!listData.messages || !Array.isArray(listData.messages)) {
    return { messages: [] };
  }

  // Fetch full details for each message
  const detailedMessages = await Promise.all(
    listData.messages
      .filter((message: { id: string }) => !existingEmailIds.has(message.id))
      .map(async (message: { id: string }) => {
        const messageResponse = await fetch(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${message.id}?format=full`,
          {
            headers: {
              Authorization: `Bearer ${accessToken}`,
            },
          },
        );

        const messageData = await messageResponse.json();

        // Extract email details from the message data
        const headers = messageData.payload.headers;
        const subject = getHeader(headers, "Subject");
        const from = getHeader(headers, "From");
        const to = getHeader(headers, "To");
        const date = getHeader(headers, "Date");

        // Extract plain text content if available
        let plainText = "";
        if (
          messageData.payload.parts && Array.isArray(messageData.payload.parts)
        ) {
          const textPart = messageData.payload.parts.find(
            (part: any) => part.mimeType === "text/plain",
          );
          if (textPart && textPart.body && textPart.body.data) {
            plainText = decodeBase64(textPart.body.data);
          }
        } else if (messageData.payload.body && messageData.payload.body.data) {
          plainText = decodeBase64(messageData.payload.body.data);
        }

        return {
          id: messageData.id,
          threadId: messageData.threadId,
          labelIds: messageData.labelIds || ["INBOX"],
          snippet: messageData.snippet || "",
          subject,
          from: extractEmailAddress(from),
          date,
          to: extractEmailAddress(to),
          plainText,
        };
      }),
  );

  return { messages: detailedMessages };
}

const updateLabels = handler<{ detail: { value: string } }, { labels: string }>(
  ({ detail }, state) => {
    state.labels = detail?.value ?? "INBOX";
  },
);

export default recipe(Recipe, ResultSchema, ({ settings }) => {
  const auth = cell<Auth>({
    token: "",
    tokenType: "",
    scope: [],
    expiresIn: 0,
    expiresAt: 0,
    refreshToken: "",
    user: {
      email: "",
      name: "",
      picture: "",
    },
  });

  const emails = cell<Email[]>([]);

  derive(emails, (emails) => {
    console.log("emails", emails.length);
  });

  return {
    [NAME]: "gmail importer",
    [UI]: (
      <div>
        <h1>Gmail Importer</h1>
        <common-hstack>
          <label>Import Limit</label>
          <common-input
            value={settings.limit}
            placeholder="count of emails to import"
            oncommon-input={updateLimit({ limit: settings.limit })}
          />
        </common-hstack>
        <common-hstack>
          <label>Import Labels</label>
          <common-input
            value={settings.labels}
            placeholder="comma separated list of labels"
            oncommon-input={updateLabels({ labels: settings.labels })}
          />
        </common-hstack>
        <common-google-oauth $authCell={auth} auth={auth} />
        <div>
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Subject</th>
                <th>Label</th>
              </tr>
            </thead>
            <tbody>
              {emails.map((email) => (
                <tr>
                  <td>&nbsp;{email.date}&nbsp;</td>
                  <td>&nbsp;{email.subject}&nbsp;</td>
                  <td>
                    &nbsp;{derive(
                      email,
                      (email) => email.labelIds.join(", "),
                    )}&nbsp;
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    ),
    emails,
    auth,
    googleUpdater: googleUpdater({ emails, auth, settings }),
  };
});
