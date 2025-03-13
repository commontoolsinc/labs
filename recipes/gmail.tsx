import { h } from "@commontools/html";
import {
  cell,
  derive,
  handler,
  ID,
  JSONSchema,
  NAME,
  recipe,
  Schema,
  str,
  UI,
} from "@commontools/builder";
import { Cell } from "@commontools/runner";

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
    htmlContent: { type: "string" },
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
  ],
} as const as JSONSchema;
type Email = Schema<typeof EmailSchema>;

const AuthSchema = {
  type: "object",
  properties: {
    token: { type: "string", default: "" },
    tokenType: { type: "string", default: "" },
    scope: { type: "array", items: { type: "string" }, default: [] },
    expiresIn: { type: "number", default: 0 },
    expiresAt: { type: "number", default: 0 },
    refreshToken: { type: "string", default: "" },
    user: {
      type: "object",
      properties: {
        email: { type: "string", default: "" },
        name: { type: "string", default: "" },
        picture: { type: "string", default: "" },
      },
    },
  },
} as const satisfies JSONSchema;
type Auth = Schema<typeof AuthSchema>;

const LabelSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    name: { type: "string" },
  },
} as const satisfies JSONSchema;
type Label = Schema<typeof LabelSchema>;

const GmailImporterInputs = {
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
    auth: AuthSchema,
  },
  required: ["settings", "auth"],
  description: "Gmail Importer",
} as const satisfies JSONSchema;

const ResultSchema = {
  type: "object",
  properties: {
    labels: {
      type: "array",
      items: LabelSchema,
      default: [{ id: "INBOX", name: "INBOX" }],
    },
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
          htmlContent: { type: "string" },
        },
      },
    },
    googleUpdater: { asStream: true, type: "object", properties: {} },
  },
} as const satisfies JSONSchema;

const updateLimit = handler(
  {
    type: "object",
    properties: {
      detail: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
      },
    },
  },
  {
    type: "object",
    properties: { limit: { type: "number", asCell: true } },
    required: ["limit"],
  },
  ({ detail }, state) => {
    state.limit.set(parseInt(detail?.value ?? "10") || 0);
  },
);

const googleUpdater = handler(
  {},
  {
    type: "object",
    properties: {
      emails: { type: "array", items: EmailSchema, default: [], asCell: true },
      auth: AuthSchema,
      settings: GmailImporterInputs.properties.settings,
      labels: { type: "array", items: LabelSchema, default: [], asCell: true },
    },
    required: ["emails", "auth", "settings", "labels"],
  },
  (_event, state) => {
    console.log("googleUpdater!");

    if (!state.auth.token) {
      console.warn("no token");
      return;
    }
    if (state.auth.expiresAt && state.auth.expiresAt < Date.now()) {
      console.warn("token expired at ", state.auth.expiresAt);
      return;
    }

    const labels = state.settings.labels
      .split(",")
      .map((label) => label.trim())
      .filter(Boolean);

    console.log("labels", labels);

    fetchEmail(
      state.auth.token,
      state.settings.limit,
      labels,
      state,
    );

    fetchLabels(state.auth.token, state);
  },
);

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

async function processBatch(
  messages: { id: string }[],
  accessToken: string,
): Promise<Email[]> {
  const boundary = `batch_${Math.random().toString(36).substring(2)}`;
  console.log("Processing batch with boundary", boundary);

  const batchBody = messages.map((message, index) => `
--${boundary}
Content-Type: application/http
Content-ID: <batch-${index}+${message.id}>

GET /gmail/v1/users/me/messages/${message.id}?format=full
Authorization: Bearer ${accessToken}
Accept: application/json

`).join("") + `--${boundary}--`;

  console.log("Sending batch request for", messages.length, "messages");

  const batchResponse = await fetch(
    "https://gmail.googleapis.com/batch/gmail/v1",
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Content-Type": `multipart/mixed; boundary=${boundary}`,
      },
      body: batchBody,
    },
  );

  const responseText = await batchResponse.text();
  console.log("Received batch response of length:", responseText.length);

  const parts = responseText.split(`--batch_`)
    .slice(1, -1)
    .map((part) => {
      try {
        const jsonStart = part.indexOf("\n{");
        if (jsonStart === -1) return null;
        const jsonContent = part.slice(jsonStart).trim();
        return JSON.parse(jsonContent);
      } catch (error) {
        console.error("Error parsing part:", error);
        return null;
      }
    })
    .filter((part) => part !== null);

  console.log("Found", parts.length, "parts in response");

  return parts.map((messageData) => {
    try {
      if (!messageData.payload?.headers) {
        console.log("Missing required message data:", messageData);
        return null;
      }

      const messageHeaders = messageData.payload.headers;
      const subject = getHeader(messageHeaders, "Subject");
      const from = getHeader(messageHeaders, "From");
      const to = getHeader(messageHeaders, "To");
      const date = getHeader(messageHeaders, "Date");

      let plainText = "";
      let htmlContent = "";

      if (
        messageData.payload.parts && Array.isArray(messageData.payload.parts)
      ) {
        // Look for plainText part
        const textPart = messageData.payload.parts.find(
          (part: any) => part.mimeType === "text/plain",
        );
        if (textPart?.body?.data) {
          plainText = decodeBase64(textPart.body.data);
        }

        // Look for HTML part
        const htmlPart = messageData.payload.parts.find(
          (part: any) => part.mimeType === "text/html",
        );
        if (htmlPart?.body?.data) {
          htmlContent = decodeBase64(htmlPart.body.data);
        }

        // Handle multipart messages - check for nested parts
        if (htmlContent === "") {
          for (const part of messageData.payload.parts) {
            if (part.parts && Array.isArray(part.parts)) {
              const nestedHtmlPart = part.parts.find(
                (nestedPart: any) => nestedPart.mimeType === "text/html",
              );
              if (nestedHtmlPart?.body?.data) {
                htmlContent = decodeBase64(nestedHtmlPart.body.data);
                break;
              }
            }
          }
        }
      } else if (messageData.payload.body?.data) {
        // Handle single part messages
        const bodyData = decodeBase64(messageData.payload.body.data);
        if (messageData.payload.mimeType === "text/html") {
          htmlContent = bodyData;
        } else {
          plainText = bodyData;
        }
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
        htmlContent,
      };
    } catch (error) {
      console.error("Error processing message part:", error);
      return null;
    }
  }).filter((message): message is Email => message !== null);
}

// Add this helper function for sleeping
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchLabels(
  accessToken: string,
  state: {
    labels: Cell<Label[]>;
  },
) {
  const existingLabels = new Set(
    state.labels.get().map((label) => label.id),
  );

  try {
    console.log("Fetching Gmail labels...");
    const response = await fetch(
      "https://gmail.googleapis.com/gmail/v1/users/me/labels",
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      },
    );

    const data = await response.json();

    const labelData = data.labels.map((
      label: { id: string; name: string },
    ) => ({
      id: label.id,
      name: label.name,
    }));

    const newLabels = labelData.filter(
      (label: { id: string }) => !existingLabels.has(label.id),
    );

    if (newLabels.length === 0) {
      console.log("No new labels to fetch");
      return { labels: [] };
    }
    state.labels.push(...newLabels);

    return state.labels || [];
  } catch (error) {
    console.error("Error fetching Gmail labels:", error);
    return [];
  }
}

export async function fetchEmail(
  accessToken: string,
  maxResults: number = 10,
  labelIds: string[] = ["INBOX"],
  state: {
    emails: Cell<Email[]>;
  },
) {
  const existingEmailIds = new Set(
    state.emails.get().map((email) => email.id),
  );

  const query = labelIds
    .map((label) => `label:${label}`)
    .join(" OR ");

  const listResponse = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${
      encodeURIComponent(query)
    }&maxResults=${maxResults}`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
  );

  const listData = await listResponse.json();

  if (!listData.messages || !Array.isArray(listData.messages)) {
    console.log("No messages found in response");
    return { messages: [] };
  }

  // Filter out existing messages
  const newMessages = listData.messages.filter(
    (message: { id: string }) => !existingEmailIds.has(message.id),
  );

  if (newMessages.length === 0) {
    console.log("No new messages to fetch");
    return { messages: [] };
  }

  const batchSize = 100;
  const allDetailedMessages: Email[] = [];

  // Process messages in batches with delay
  for (let i = 0; i < newMessages.length; i += batchSize) {
    const batchMessages = newMessages.slice(i, i + batchSize);
    console.log(
      `Processing batch ${i / batchSize + 1} of ${
        Math.ceil(newMessages.length / batchSize)
      }`,
    );

    try {
      const emails = await processBatch(batchMessages, accessToken);

      // Filter out any duplicates by ID
      const newEmails = emails.filter((email) =>
        !existingEmailIds.has(email.id)
      );

      if (newEmails.length > 0) {
        console.log(`Adding ${newEmails.length} new emails`);
        newEmails.forEach((email) => {
          email[ID] = email.id;
        });
        state.emails.push(...newEmails);
      } else {
        console.log("No new emails found");
      }

      // Add 1 second delay between batches, but not after the last batch
      if (i + batchSize < newMessages.length) {
        console.log("Waiting 1 second before next batch...");
        await sleep(1000);
      }
    } catch (error) {
      console.error("Error processing batch:", error);
      // Optional: add longer delay and retry logic here if needed
    }
  }

  console.log(
    "Successfully parsed",
    allDetailedMessages.length,
    "messages total",
  );
  return { messages: allDetailedMessages };
}

const updateLabels = handler<{ detail: { value: string } }, { labels: string }>(
  ({ detail }, state) => {
    state.labels = detail?.value ?? "INBOX";
  },
);

export default recipe(
  GmailImporterInputs,
  ResultSchema,
  ({ settings, auth }) => {
    const emails = cell<Email[]>([]);
    const labels = cell<Label[]>([]);

    derive(emails, (emails) => {
      console.log("emails", emails.length);
    });

    derive(labels, (labels) => {
      console.log("labels results", labels.length);
    });

    return {
      [NAME]: str`GMail Importer ${
        derive(auth, (auth) => auth?.user?.email || "unauthorized")
      }`,
      [UI]: (
        <div>
          <h1>
            Gmail Importer: {derive(emails, (emails) => emails.length)} emails
          </h1>
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
          <common-google-oauth $auth={auth} />
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
      labels,
      googleUpdater: googleUpdater({ emails, auth, settings, labels }),
    };
  },
);
