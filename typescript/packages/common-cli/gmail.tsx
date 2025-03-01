import { h } from "@commontools/html";
import { recipe, handler, UI, NAME, cell, derive } from "@commontools/builder";
import { z } from "zod";

const Email = z.object({
  id: z.string(),
  threadId: z.string(),
  labelIds: z.array(z.string()),
  snippet: z.string(),
  subject: z.string(),
  from: z.string(),
  date: z.string(),
  to: z.string(),
  plainText: z.string(),
});
type Email = z.infer<typeof Email>;

const Auth = z.object({
  token: z.string(),
  tokenType: z.string(),
  scope: z.array(z.string()),
  expiresIn: z.number(),
  expiresAt: z.number(),
  refreshToken: z.string(),
});
type Auth = z.infer<typeof Auth>;

const Recipe = z.object({}).describe("fake gmail");

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
    updater: { asCell: true, type: "action" },
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
};

const EventSchema = z.object({
  auth: { asCell: true },
});

const updater = handler<{}, { emails: Email[]; auth: Auth }>((_event, state) => {
  if (!state.auth.token) {
    console.log("no token");
    return;
  }
  if (state.auth.expiresAt && state.auth.expiresAt < Date.now()) {
    console.log("token expired at ", state.auth.expiresAt);
    return;
  }
  fetchInboxEmails(state.auth.token).then((emails) => {
    emails.messages.forEach((email) => {
      console.log("adding email", email.subject);
      state.emails.push(email);
    });
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
  const header = headers.find((h) => h.name.toLowerCase() === name.toLowerCase());
  return header ? header.value : "";
}

export async function fetchInboxEmails(
  accessToken: string,
  maxResults: number = 10,
  labelIds: string[] = ["INBOX"],
) {
  // First, get the list of message IDs from the inbox
  const listResponse = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?labelIds=${labelIds.join(
      ",",
    )}&maxResults=${maxResults}`,
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
    listData.messages.map(async (message: { id: string }) => {
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
      if (messageData.payload.parts && Array.isArray(messageData.payload.parts)) {
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

export default recipe(Recipe, ResultSchema, () => {
  const auth = cell<Auth>({
    token: "",
    tokenType: "",
    scope: [],
    expiresIn: 0,
    expiresAt: 0,
    refreshToken: "",
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
        <common-google-oauth $authCell={auth} auth={auth} />
        <div>
          {emails.map((email) => (
            <div>
              <h3>{email.subject}</h3>
              <p>
                <em>{email.date}</em> {email.plainText}
              </p>
            </div>
          ))}
        </div>
      </div>
    ),
    emails,
    auth,
    updater: updater({ emails, auth }),
  };
});
