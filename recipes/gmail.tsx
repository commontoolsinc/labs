import {
  Cell,
  cell,
  derive,
  getRecipeEnvironment,
  h,
  handler,
  ID,
  JSONSchema,
  Mutable,
  NAME,
  recipe,
  Schema,
  str,
  UI,
} from "commontools";
import TurndownService from "turndown";

const Classification = {
  Unclassified: "unclassified",
  Confidential: "confidential",
  Secret: "secret",
  TopSecret: "topsecret",
} as const;

const ClassificationSecret = "secret";

// This is used by the various Google tokens created with tokenToAuthData
export const AuthSchema = {
  type: "object",
  properties: {
    token: {
      type: "string",
      default: "",
      ifc: { classification: [ClassificationSecret] },
    },
    tokenType: { type: "string", default: "" },
    scope: { type: "array", items: { type: "string" }, default: [] },
    expiresIn: { type: "number", default: 0 },
    expiresAt: { type: "number", default: 0 },
    refreshToken: {
      type: "string",
      default: "",
      ifc: { classification: [ClassificationSecret] },
    },
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
  ifc: { classification: [Classification.Confidential] },
} as const satisfies JSONSchema;
type Email = Mutable<Schema<typeof EmailSchema>>;

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
        historyId: {
          type: "string",
          description: "Gmail history ID for incremental sync",
          default: "",
        },
      },
      required: ["gmailFilterQuery", "limit", "historyId"],
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

interface GmailClientConfig {
  // How many times the client will retry after an HTTP failure
  retries?: number;
  // In milliseconds, the delay between making any subsequent requests due to failure.
  delay?: number;
  // In milliseconds, the amount to permanently increment to the `delay` on every 429 response.
  delayIncrement?: number;
}

class GmailClient {
  private auth: Cell<Auth>;
  private retries: number;
  private delay: number;
  private delayIncrement: number;

  constructor(
    auth: Cell<Auth>,
    { retries = 3, delay = 1000, delayIncrement = 100 }: GmailClientConfig = {},
  ) {
    this.auth = auth;
    this.retries = retries;
    this.delay = delay;
    this.delayIncrement = delayIncrement;
  }

  private async refreshAuth() {
    const body = {
      refreshToken: this.auth.get().refreshToken,
    };

    console.log("refreshAuthToken", body);

    const res = await fetch(
      new URL("/api/integrations/google-oauth/refresh", env.apiUrl),
      {
        method: "POST",
        body: JSON.stringify(body),
      },
    );
    if (!res.ok) {
      throw new Error("Could not acquire a refresh token.");
    }
    const json = await res.json();
    const authData = json.tokenInfo as Auth;
    this.auth.update(authData);
  }

  async getProfile(): Promise<{
    emailAddress: string;
    messagesTotal: number;
    threadsTotal: number;
    historyId: string;
  }> {
    const url = new URL(
      "https://gmail.googleapis.com/gmail/v1/users/me/profile",
    );
    const res = await this.googleRequest(url);
    const json = await res.json();
    return json;
  }

  async fetchHistory(
    startHistoryId: string,
    labelId?: string,
    maxResults: number = 100,
  ): Promise<{
    history?: Array<{
      id: string;
      messages?: Array<{ id: string; threadId: string }>;
      messagesAdded?: Array<{
        message: { id: string; threadId: string; labelIds: string[] };
      }>;
      messagesDeleted?: Array<{ message: { id: string; threadId: string } }>;
      labelsAdded?: Array<{ message: { id: string }; labelIds: string[] }>;
      labelsRemoved?: Array<{ message: { id: string }; labelIds: string[] }>;
    }>;
    historyId: string;
    nextPageToken?: string;
  }> {
    const url = new URL(
      "https://gmail.googleapis.com/gmail/v1/users/me/history",
    );
    url.searchParams.set("startHistoryId", startHistoryId);
    url.searchParams.set("maxResults", maxResults.toString());
    if (labelId) {
      url.searchParams.set("labelId", labelId);
    }

    console.log("[GmailClient] Fetching history from:", url.toString());
    const res = await this.googleRequest(url);
    const json = await res.json();
    console.log("[GmailClient] History API returned:", {
      historyId: json.historyId,
      historyCount: json.history?.length || 0,
      hasNextPageToken: !!json.nextPageToken,
    });
    return json;
  }

  async fetchEmail(
    maxResults: number = 100,
    gmailFilterQuery: string = "in:INBOX",
  ): Promise<any[]> {
    const url = new URL(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${
        encodeURIComponent(gmailFilterQuery)
      }&maxResults=${maxResults}`,
    );

    const res = await this.googleRequest(url);
    const json = await res.json();
    if (
      !json || !("messages" in json) || !Array.isArray(json.messages)
    ) {
      console.log(`No messages found in response: ${JSON.stringify(json)}`);
      return [];
    }
    return json.messages;
  }

  async fetchBatch(
    messages: { id: string }[],
  ): Promise<any[]> {
    const boundary = `batch_${Math.random().toString(36).substring(2)}`;
    console.log("Processing batch with boundary", boundary);

    const batchBody = messages.map((message, index) => `
--${boundary}
Content-Type: application/http
Content-ID: <batch-${index}+${message.id}>

GET /gmail/v1/users/me/messages/${message.id}?format=full
Authorization: Bearer $PLACEHOLDER
Accept: application/json

`).join("") + `--${boundary}--`;

    console.log("Sending batch request for", messages.length, "messages");

    const batchResponse = await this.googleRequest(
      new URL(
        "https://gmail.googleapis.com/batch/gmail/v1",
      ),
      {
        method: "POST",
        headers: {
          "Content-Type": `multipart/mixed; boundary=${boundary}`,
        },
        body: batchBody,
      },
    );

    const responseText = await batchResponse.text();
    console.log("Received batch response of length:", responseText.length);

    const HTTP_RES_REGEX = /HTTP\/\d\.\d (\d\d\d) ([^\n]*)/;
    const parts = responseText.split(`--batch_`)
      .slice(1, -1)
      .map((part) => {
        const httpResIndex = part.search(HTTP_RES_REGEX);
        const httpResMatch = part.match(HTTP_RES_REGEX);
        let httpStatus = httpResMatch && httpResMatch.length >= 2
          ? Number(httpResMatch[1])
          : 0;
        const httpMessage = httpResMatch && httpResMatch.length >= 3
          ? httpResMatch[2]
          : "";
        try {
          const jsonStart = part.indexOf(`\n{`);
          if (jsonStart === -1) return null;
          // If we have an HTTP status, ensure its a successful one,
          // Otherwise ignore.
          if (httpResIndex > 0) {
            // If we have an HTTP status for this part, ensure it's not
            // in the JSON data and that it's OK
            if (jsonStart <= httpResIndex) {
              httpStatus = 0;
            }
            if (httpStatus > 0 && httpStatus >= 400) {
              console.warn(
                `Non-successful HTTP status code (${httpStatus}) returned in multipart response: ${httpMessage}`,
              );
              return null;
            }
          }
          const jsonContent = part.slice(jsonStart).trim();
          return JSON.parse(jsonContent);
        } catch (error) {
          console.error("Error parsing part:", error);
          return null;
        }
      })
      .filter((part) => part !== null);

    console.log("Found", parts.length, "parts in response");
    return parts;
  }

  async fetchMessagesByIds(messageIds: string[]): Promise<any[]> {
    if (messageIds.length === 0) return [];

    // Use batch API for efficiency
    return await this.fetchBatch(messageIds.map((id) => ({ id })));
  }

  private async googleRequest(
    url: URL,
    _options?: RequestInit,
    _retries?: number,
  ): Promise<Response> {
    const token = this.auth.get().token;
    if (!token) {
      throw new Error("No authorization token.");
    }

    const retries = _retries ?? this.retries;
    const options = _options ?? {};
    options.headers = new Headers(options.headers);
    options.headers.set("Authorization", `Bearer ${token}`);

    if (options.body && typeof options.body === "string") {
      // Rewrite the authorization in the body here in case reauth was necessary
      options.body = options.body.replace(
        /Authorization: Bearer [^\n]*/g,
        `Authorization: Bearer ${token}`,
      );
    }

    const res = await fetch(url, options);
    let { ok, status, statusText } = res;

    // Batch requests expect a text response on success, but upon error, we get a 200 status code
    // with error details in the json response.
    if (options.method === "POST") {
      // `body` can only be consumed once. Clone the body before consuming as json.
      try {
        const json = await res.clone().json();
        if (json?.error?.code) {
          ok = false;
          status = json.error.code;
          statusText = json.error?.message;
        }
      } catch (e) {
        // If parsing as json failed, then this is probably a real 200 scenario
      }
    }

    // Allow all 2xx status
    if (ok) {
      console.log(`${url}: ${status} ${statusText}`);
      return res;
    }

    console.warn(
      `${url}: ${status} ${statusText}`,
      `Remaining retries: ${retries}`,
    );
    if (retries === 0) {
      throw new Error("Too many failed attempts.");
    }

    await sleep(this.delay);

    if (status === 401) {
      await this.refreshAuth();
    } else if (status === 429) {
      this.delay += this.delayIncrement;
      console.log(`Incrementing delay to ${this.delay}`);
      await sleep(this.delay);
    }
    return this.googleRequest(url, _options, retries - 1);
  }
}

const googleUpdater = handler(
  {},
  {
    type: "object",
    properties: {
      emails: { type: "array", items: EmailSchema, default: [], asCell: true },
      auth: { ...AuthSchema, asCell: true },
      settings: { ...GmailImporterInputs.properties.settings, asCell: true },
    },
    required: ["emails", "auth", "settings"],
  } as const satisfies JSONSchema,
  async (_event, state) => {
    console.log("googleUpdater!");

    if (!state.auth.get().token) {
      console.warn("no token found in auth cell");
      return;
    }

    const settings = state.settings.get();
    const gmailFilterQuery = settings.gmailFilterQuery;

    console.log("gmailFilterQuery", gmailFilterQuery);

    const result = await process(
      state.auth,
      settings.limit,
      gmailFilterQuery,
      { emails: state.emails, settings: state.settings },
    );

    if (!result) return;

    // Handle deleted emails
    if (result.deletedEmailIds && result.deletedEmailIds.length > 0) {
      console.log(`Removing ${result.deletedEmailIds.length} deleted messages`);
      const deleteSet = new Set(result.deletedEmailIds);
      const currentEmails = state.emails.get();
      const remainingEmails = currentEmails.filter((email) =>
        !deleteSet.has(email.id)
      );
      state.emails.set(remainingEmails);
    }

    // Add new emails
    if (result.newEmails && result.newEmails.length > 0) {
      console.log(`Adding ${result.newEmails.length} new emails`);
      state.emails.push(...result.newEmails);
    }

    // Update historyId
    if (result.newHistoryId) {
      const currentSettings = state.settings.get();
      console.log("=== UPDATING HISTORY ID ===");
      console.log("Previous historyId:", currentSettings.historyId || "none");
      console.log("New historyId:", result.newHistoryId);
      state.settings.set({
        ...currentSettings,
        historyId: result.newHistoryId,
      });
      console.log("HistoryId updated successfully");
      console.log("==========================");
    }
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

function messageToEmail(
  parts: any[],
): Email[] {
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
    } catch (error: any) {
      console.error(
        "Error processing message part:",
        "message" in error ? error.message : error,
      );
      return null;
    }
  }).filter((message): message is Email => message !== null);
}

export async function process(
  auth: Cell<Auth>,
  maxResults: number = 100,
  gmailFilterQuery: string = "in:INBOX",
  state: {
    emails: Cell<Email[]>;
    settings: Cell<
      { gmailFilterQuery: string; limit: number; historyId: string }
    >;
  },
): Promise<
  | { newHistoryId?: string; newEmails?: Email[]; deletedEmailIds?: string[] }
  | void
> {
  if (!auth.get()) {
    console.warn("no token");
    return;
  }

  const client = new GmailClient(auth);
  const currentHistoryId = state.settings.get().historyId;

  let newHistoryId: string | null = null;
  let messagesToFetch: string[] = [];
  const messagesToDelete: string[] = [];
  let useFullSync = false;

  // Get existing email IDs and create a map for efficient updates
  const existingEmails = state.emails.get();
  const existingEmailIds = new Set(existingEmails.map((email) => email.id));
  const emailMap = new Map(existingEmails.map((email) => [email.id, email]));

  // Try incremental sync if we have a historyId
  if (currentHistoryId) {
    console.log("=== INCREMENTAL SYNC MODE ===");
    console.log("Current historyId:", currentHistoryId);
    console.log("Existing emails count:", existingEmails.length);

    try {
      console.log("Calling Gmail History API...");
      const historyResponse = await client.fetchHistory(
        currentHistoryId,
        undefined,
        maxResults,
      );

      console.log("History API Response:");
      console.log("- New historyId:", historyResponse.historyId);
      console.log("- Has history records:", !!historyResponse.history);
      console.log(
        "- History records count:",
        historyResponse.history?.length || 0,
      );

      if (historyResponse.history) {
        console.log(
          `Processing ${historyResponse.history.length} history records`,
        );

        // Process history records
        for (let i = 0; i < historyResponse.history.length; i++) {
          const record = historyResponse.history[i];
          console.log(`\nHistory Record ${i + 1}:`);
          console.log("- History ID:", record.id);
          console.log("- Messages added:", record.messagesAdded?.length || 0);
          console.log(
            "- Messages deleted:",
            record.messagesDeleted?.length || 0,
          );
          console.log("- Labels added:", record.labelsAdded?.length || 0);
          console.log("- Labels removed:", record.labelsRemoved?.length || 0);

          // Handle added messages
          if (record.messagesAdded) {
            console.log(
              `  Processing ${record.messagesAdded.length} added messages`,
            );
            for (const item of record.messagesAdded) {
              if (!existingEmailIds.has(item.message.id)) {
                console.log(`    - New message to fetch: ${item.message.id}`);
                messagesToFetch.push(item.message.id);
              } else {
                console.log(`    - Message already exists: ${item.message.id}`);
              }
            }
          }

          // Handle deleted messages
          if (record.messagesDeleted) {
            console.log(
              `  Processing ${record.messagesDeleted.length} deleted messages`,
            );
            for (const item of record.messagesDeleted) {
              console.log(`    - Message to delete: ${item.message.id}`);
              messagesToDelete.push(item.message.id);
            }
          }

          // Handle label changes
          if (record.labelsAdded) {
            console.log(
              `  Processing ${record.labelsAdded.length} label additions`,
            );
            for (const item of record.labelsAdded) {
              const email = emailMap.get(item.message.id);
              if (email) {
                console.log(
                  `    - Adding labels to ${item.message.id}:`,
                  item.labelIds,
                );
                // Add new labels
                const newLabels = new Set(email.labelIds);
                item.labelIds.forEach((label) => newLabels.add(label));
                email.labelIds = Array.from(newLabels);
              }
            }
          }

          if (record.labelsRemoved) {
            console.log(
              `  Processing ${record.labelsRemoved.length} label removals`,
            );
            for (const item of record.labelsRemoved) {
              const email = emailMap.get(item.message.id);
              if (email) {
                console.log(
                  `    - Removing labels from ${item.message.id}:`,
                  item.labelIds,
                );
                // Remove labels
                const labelSet = new Set(email.labelIds);
                item.labelIds.forEach((label) => labelSet.delete(label));
                email.labelIds = Array.from(labelSet);
              }
            }
          }
        }

        newHistoryId = historyResponse.historyId;
        console.log("\n=== INCREMENTAL SYNC SUMMARY ===");
        console.log(`Messages to fetch: ${messagesToFetch.length}`);
        console.log(`Messages to delete: ${messagesToDelete.length}`);
        console.log(`Old historyId: ${currentHistoryId}`);
        console.log(`New historyId: ${newHistoryId}`);
        console.log("================================\n");
      } else {
        console.log("No history changes found");
        console.log(
          `Updating historyId from ${currentHistoryId} to ${historyResponse.historyId}`,
        );
        newHistoryId = historyResponse.historyId;
      }
    } catch (error: any) {
      if (
        error.message &&
        (error.message.includes("404") || error.message.includes("410"))
      ) {
        console.log("History ID expired, falling back to full sync");
        useFullSync = true;
      } else {
        console.error("Error fetching history:", error);
        throw error;
      }
    }
  } else {
    console.log("=== FULL SYNC MODE ===");
    console.log("No historyId found, performing full sync");
    useFullSync = true;
  }

  // Perform full sync if needed
  if (useFullSync) {
    console.log("Getting user profile to obtain current historyId...");
    // Get current profile to get latest historyId
    const profile = await client.getProfile();
    newHistoryId = profile.historyId;
    console.log("Profile received:");
    console.log("- Email:", profile.emailAddress);
    console.log("- Current historyId:", profile.historyId);
    console.log("- Total messages:", profile.messagesTotal);
    console.log("- Total threads:", profile.threadsTotal);

    console.log(
      `\nFetching messages with query: "${gmailFilterQuery}", limit: ${maxResults}`,
    );
    const messages = await client.fetchEmail(maxResults, gmailFilterQuery);
    console.log(`Received ${messages.length} messages from API`);

    messagesToFetch = messages
      .filter((message: { id: string }) => !existingEmailIds.has(message.id))
      .map((message: { id: string }) => message.id);

    console.log(
      `After filtering existing: ${messagesToFetch.length} new messages to fetch`,
    );
    console.log("======================\n");
  }

  // Collect all new emails to return
  const allNewEmails: Email[] = [];

  // Fetch new messages in batches
  if (messagesToFetch.length > 0) {
    console.log(`Fetching ${messagesToFetch.length} new messages`);
    const batchSize = 100;

    for (let i = 0; i < messagesToFetch.length; i += batchSize) {
      const batchIds = messagesToFetch.slice(i, i + batchSize);
      console.log(
        `Processing batch ${i / batchSize + 1} of ${
          Math.ceil(messagesToFetch.length / batchSize)
        }`,
      );

      try {
        await sleep(1000);
        const fetched = await client.fetchMessagesByIds(batchIds);
        const emails = messageToEmail(fetched);

        if (emails.length > 0) {
          console.log(`Adding ${emails.length} new emails`);
          emails.forEach((email) => {
            email[ID] = email.id;
          });
          allNewEmails.push(...emails);
        }
      } catch (error: any) {
        console.error(
          "Error processing batch:",
          "message" in error ? error.message : error,
        );
      }
    }
  }

  console.log("Sync completed successfully");

  // Return the results instead of directly updating cells
  return {
    newHistoryId: newHistoryId || undefined,
    newEmails: allNewEmails.length > 0 ? allNewEmails : undefined,
    deletedEmailIds: messagesToDelete.length > 0 ? messagesToDelete : undefined,
  };
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

          <h2>historyId: {settings.historyId}</h2>

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
          <common-google-oauth
            $auth={auth}
            scopes={[
              "email",
              "profile",
              "https://www.googleapis.com/auth/gmail.readonly",
            ]}
          />
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
                        (email) => email?.labelIds?.join(", "),
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
