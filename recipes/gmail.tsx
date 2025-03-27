import { h } from "@commontools/html";
import {
  cell,
  derive,
  getRecipeEnvironment,
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
import TurndownService from "turndown";

// Initialize turndown service
const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  emDelimiter: "*",
});

const env = getRecipeEnvironment();

turndown.addRule("removeStyleTags", {
  filter: ["style"],
  replacement: function () {
    return "";
  },
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const EmailProperties = {
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
  to: { type: "string", title: "To", description: "Recipient's email address" },
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
    description:
      "Email content converted to Markdown format. Often best for processing email contents.",
  },
} as const;

const EmailSchema = {
  type: "object",
  properties: EmailProperties,
  required: Object.keys(EmailProperties),
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

const GmailImporterInputs = {
  type: "object",
  properties: {
    settings: {
      type: "object",
      properties: {
        gmailFilterQuery: {
          type: "string",
          description: "gmail filter query",
          default: "in:INBOX",
        },
        limit: {
          type: "number",
          description: "number of emails to import",
          default: 100,
        },
      },
      required: ["gmailFilterQuery", "limit"],
    },
    auth: AuthSchema,
  },
  required: ["settings", "auth"],
  description: "Gmail Importer",
} as const satisfies JSONSchema;

const ResultSchema = {
  type: "object",
  properties: {
    emails: {
      type: "array",
      items: {
        type: "object",
        properties: EmailProperties,
      },
    },
    googleUpdater: { asStream: true, type: "object", properties: {} },
  },
} as const satisfies JSONSchema;

const updateLimit = handler({
  type: "object",
  properties: {
    detail: {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
    },
  },
}, {
  type: "object",
  properties: { limit: { type: "number", asCell: true } },
  required: ["limit"],
}, ({ detail }, state) => {
  state.limit.set(parseInt(detail?.value ?? "100") || 0);
});

const refreshAuthToken = async (auth: Auth) => {
  const body = {
    refreshToken: auth.refreshToken,
  };

  console.log("refreshAuthToken", body);

  const refresh_response = await fetch(
    new URL("/api/integrations/google-oauth/refresh", env.apiUrl),
    {
      method: "POST",
      body: JSON.stringify(body),
    },
  ).then((res) => res.json());

  return refresh_response as Auth;
};

const googleUpdater = handler(
  {},
  {
    type: "object",
    properties: {
      emails: { type: "array", items: EmailSchema, default: [], asCell: true },
      auth: { ...AuthSchema, asCell: true },
      settings: GmailImporterInputs.properties.settings,
    },
    required: ["emails", "auth", "settings"],
  } as const satisfies JSONSchema,
  (_event, state) => {
    console.log("googleUpdater!");

    if (!state.auth.get().token) {
      console.warn("no token");
      return;
    }

    const gmailFilterQuery = state.settings.gmailFilterQuery;

    console.log("gmailFilterQuery", gmailFilterQuery);

    fetchEmail(
      state.auth,
      state.settings.limit,
      gmailFilterQuery,
      state,
    );
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

      // Generate markdown content from HTML or plainText
      let markdownContent = "";
      if (htmlContent) {
        try {
          // Convert HTML to markdown using our custom converter
          markdownContent = turndown.turndown(htmlContent);
        } catch (error) {
          console.error("Error converting HTML to markdown:", error);
          // Fallback to plainText if HTML conversion fails
          markdownContent = plainText;
        }
      } else {
        // Use plainText as fallback if no HTML content
        markdownContent = plainText;
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
        markdownContent,
      };
    } catch (error) {
      console.error("Error processing message part:", error);
      return null;
    }
  }).filter((message): message is Email => message !== null);
}

export async function fetchEmail(
  auth: Cell<Auth>,
  maxResults: number = 100,
  gmailFilterQuery: string = "in:INBOX",
  state: {
    emails: Cell<Email[]>;
  },
) {
  let cur = auth.get();

  if (cur.expiresAt && Date.now() > cur.expiresAt) {
    const resp = await refreshAuthToken(auth);
    auth.set(resp);
    console.log("refresh_data", resp);
  }

  cur = auth.get();

  if (!cur.token) {
    console.warn("no token");
    return;
  }

  const existingEmailIds = new Set(
    state.emails.get().map((email) => email.id),
  );

  const listResponse = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${
      encodeURIComponent(gmailFilterQuery)
    }&maxResults=${maxResults}`,
    {
      headers: {
        Authorization: `Bearer ${cur.token}`,
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
      const emails = await processBatch(batchMessages, cur.token);

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

const updateGmailFilterQuery = handler<
  { detail: { value: string } },
  { gmailFilterQuery: string }
>(
  ({ detail }, state) => {
    state.gmailFilterQuery = detail?.value ?? "in:INBOX";
  },
);

export default recipe(
  GmailImporterInputs,
  ResultSchema,
  ({ settings, auth }) => {
    const emails = cell<Email[]>([]);

    derive(emails, (emails) => {
      console.log("emails", emails.length);
    });

    return {
      [NAME]: str`GMail Importer ${
        derive(auth, (auth) => auth?.user?.email || "unauthorized")
      }`,
      [UI]: (
        <div style="display: flex; gap: 10px; flex-direction: column; padding: 25px;">
          <h2 style="font-size: 20px; font-weight: bold;">
            {auth?.user?.email}
          </h2>
          <h2 style="font-size: 20px; font-weight: bold;">
            Imported email count: {derive(emails, (emails) => emails.length)}
          </h2>

          <common-hstack gap="sm">
            <common-vstack gap="sm">
              <div>
                <label>Import Limit</label>
                <common-input
                  customStyle="border: 1px solid black; padding: 15px 10px; border-radius: 25px; min-width: 650px;"
                  value={settings.limit}
                  placeholder="count of emails to import"
                  oncommon-input={updateLimit({ limit: settings.limit })}
                />
              </div>

              <div>
                <label>Gmail Filter Query</label>
                <common-input
                  customStyle="border: 1px solid black; padding: 15px 10px; border-radius: 25px; min-width: 650px;"
                  value={settings.gmailFilterQuery}
                  placeholder="in:INBOX"
                  oncommon-input={updateGmailFilterQuery({
                    gmailFilterQuery: settings.gmailFilterQuery,
                  })}
                />
              </div>
              <button
                type="button"
                onClick={googleUpdater({
                  emails,
                  auth,
                  settings,
                })}
              >
                Fetch Emails
              </button>
            </common-vstack>
          </common-hstack>
          <common-google-oauth $auth={auth} />
          <div>
            <table>
              <thead>
                <tr>
                  <th style="padding: 10px;">DATE</th>
                  <th style="padding: 10px;">SUBJECT</th>
                  <th style="padding: 10px;">LABEL</th>
                  <th style="padding: 10px;">CONTENT</th>
                </tr>
              </thead>
              <tbody>
                {emails.map((email) => (
                  <tr>
                    <td style="border: 1px solid black; padding: 10px;">
                      &nbsp;{email.date}&nbsp;
                    </td>
                    <td style="border: 1px solid black; padding: 10px;">
                      &nbsp;{email.subject}&nbsp;
                    </td>
                    <td style="border: 1px solid black; padding: 10px;">
                      &nbsp;{derive(
                        email,
                        (email) => email.labelIds.join(", "),
                      )}&nbsp;
                    </td>
                    <td style="border: 1px solid black; padding: 10px;">
                      <details>
                        <summary>Show Markdown</summary>
                        <pre style="white-space: pre-wrap; max-height: 300px; overflow-y: auto;">
                          {email.markdownContent}
                        </pre>
                      </details>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ),
      emails,
      bgUpdater: googleUpdater({ emails, auth, settings }),
    };
  },
);
