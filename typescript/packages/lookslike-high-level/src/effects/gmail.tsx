import {
  service,
  $,
  refer,
  Instruction,
  Session,
  Task,
  Fact,
  h,
} from "@commontools/common-system";
import { Reference } from "merkle-reference";
import { addTag } from "../sugar.js";

const provider = refer({
  effect: { gmail: { version: [0, 0, 1] } },
});

export const REQUEST = {
  STATUS: "request/status",
  STATUS_CODE: "request/status/code",
  STATUS_TEXT: "request/status/text",
};

export const RESPONSE = {
  JSON: "response/json",
};

type GmailAction =
  | { type: "listMessages"; userId: string; q?: string }
  | { type: "getMessage"; userId: string; id: string }
  | { type: "sendMessage"; userId: string; message: any }
  | { type: "createDraft"; userId: string; message: any };
// Add more Gmail actions as needed

type State =
  | { status: "Open"; source: Gmail }
  | { status: "Sending"; source: Gmail; response: Promise<any> }
  | { status: "Receiving"; source: Gmail; content: Promise<any[]> }
  | { status: "Complete"; source: Gmail; content: {} };
// Gmail API wrapper functions
async function getMessageDetails(userId: string, messageId: string) {
  const response = await gapi.client.gmail.users.messages.get({
    userId,
    id: messageId,
  });
  return parseEmailPreview(response.result);
}

async function listMessagesWithContent(userId: string, query?: string) {
  const response = await gapi.client.gmail.users.messages.list({
    userId,
    q: query,
    maxResults: 10,
  });

  const messages = response.result.messages;
  if (!messages || messages.length === 0) {
    return [];
  }

  const fullMessages = await Promise.all(
    messages.map(msg => getMessageDetails(userId, msg.id)),
  );

  return fullMessages;
}

export type GmailMessage = {
  id: string;
  threadId: string;
  labelIds: string[];
  snippet: string;
  historyId?: string;
  internalDate: string;
  payload: object;
  sizeEstimate: number;
  raw: string;
};

export type GmailMessagePart = {
  partId: string;
  mimeType: string;
  filename: string;
  headers: Array<{
    name: string;
    value: string;
  }>;
  body: {
    size: number;
    data: string;
    attachmentId?: string;
  };
  parts?: GmailMessagePart[];
};

export function makeEmail(
  to: string,
  subject: string,
  body: string,
): GmailMessage {
  const emailLines = ["To: " + to, "Subject: " + subject, "", body].join(
    "\r\n",
  );

  const raw = btoa(emailLines)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  return {
    id: "",
    threadId: "",
    labelIds: [],
    snippet: body.substring(0, 100),
    // historyId: "",
    internalDate: new Date().getTime().toString(),
    payload: {
      headers: [
        { name: "To", value: to },
        { name: "Subject", value: subject },
      ],
    },
    sizeEstimate: emailLines.length,
    raw,
  };
}

async function sendGmailMessage(userId: string, message: GmailMessage) {
  return await gapi.client.gmail.users.messages.send({
    userId,
    resource: message,
  });
}

async function createDraft(userId: string, message: any) {
  return await gapi.client.gmail.users.drafts.create({
    userId,
    resource: { message },
  });
}

export default service({
  "gmail/send": {
    select: {
      request: $.request,
    },
    where: [{ Case: [provider, `~/send`, $.request] }],
    *perform({ request }: { request: Reference }): Task.Task<Instruction[]> {
      const effect = Session.resolve<State>(request);
      if (effect?.status === "Open") {
        const gmailAction = effect.source.action;
        let response: Promise<any> = Promise.resolve();

        switch (gmailAction.type) {
          case "listMessages":
            response = listMessagesWithContent(
              gmailAction.userId,
              gmailAction.q,
            );
            break;
          case "getMessage":
            response = getMessageDetails(gmailAction.userId, gmailAction.id);
            break;
          case "sendMessage":
            response = sendGmailMessage(
              gmailAction.userId,
              gmailAction.message,
            );
            break;
          case "createDraft":
            response = createDraft(gmailAction.userId, gmailAction.message);
            break;
        }

        const state = {
          status: "Sending",
          source: effect.source,
          response,
        };

        return [
          { Retract: [provider, "~/send", request] },
          { Upsert: [provider, "~/receive", state as any] },
          {
            Upsert: [
              effect.source.consumer,
              effect.source.port,
              effect.source.id,
            ],
          },
          { Upsert: [effect.source.id, REQUEST.STATUS, "Sending"] },
        ];
      }
      return [];
    },
  },

  "gmail/receive": {
    select: {
      request: $.request,
    },
    where: [{ Case: [provider, `~/receive`, $.request] }],
    *perform({ request }: { request: Reference }) {
      const effect = Session.resolve<State>(request);
      if (effect?.status === "Sending") {
        const response = yield* Task.wait(effect.response);
        const content = response;

        const state = {
          status: "Receiving",
          source: effect.source,
          content: Promise.resolve(content),
        };

        return [
          { Retract: [provider, "~/receive", request] },
          { Upsert: [provider, `~/complete`, state as any] },
          { Upsert: [effect.source.id, REQUEST.STATUS, "Receiving"] },
          { Upsert: [effect.source.id, REQUEST.STATUS_CODE, 200] },
        ];
      }
      return [];
    },
  },

  "gmail/complete": {
    select: {
      request: $.request,
    },
    where: [{ Case: [provider, `~/complete`, $.request] }],
    *perform({ request }: { request: Reference }) {
      const effect = Session.resolve<State>(request);
      if (effect?.status === "Receiving") {
        const content = yield* Task.wait(effect.content);
        const id = refer(content);

        const instructionList = [
          { Retract: [provider, `~/complete`, request] },
          { Assert: [provider, "effect/log", request] },
          { Upsert: [effect.source.id, REQUEST.STATUS, "Complete"] },
          { Upsert: [effect.source.id, RESPONSE.JSON, id] },
        ];

        if (effect.source.action.type === "listMessages") {
          return [
            ...instructionList,
            { Import: content },
            ...content.flatMap(i => [
              { Import: i },
              ...addTag(refer(i), "#email"),
            ]),
          ];
        }

        return instructionList;
      }
      return [];
    },
  },

  "gmail/idle": {
    select: {
      self: $.self,
    },
    where: [{ Not: { Case: [provider, `effect/log`, $._] } }],
    *perform({ self }: { self: Reference }) {
      return [
        {
          Upsert: [
            self,
            "~/common/ui",
            (
              <div title="Gmail Effect UI" entity={self}>
                📧 Idle
              </div>
            ) as any,
          ],
        },
      ];
    },
  },

  "gmail/active": {
    select: {
      self: $.self,
      requests: [{ request: $.request, state: $.state }],
    },
    where: [
      { Case: [provider, "effect/log", $.request] },
      { Case: [$.request, `request/status`, $.state] },
    ],
    *perform({
      self,
      requests,
    }: {
      self: Reference;
      requests: { request: Reference; state: string }[];
    }) {
      return [
        {
          Upsert: [
            self,
            "~/common/ui",
            (
              <div title="Gmail Effect UI" entity={self}>
                <ul>
                  {...requests.map(({ request, state }) => (
                    <li>
                      📧 {state} {String(request)}
                    </li>
                  ))}
                </ul>
              </div>
            ) as any,
          ],
        },
      ];
    },
  },
});

export class Gmail {
  consumer: Reference;
  port: string;
  action: GmailAction;
  id: Reference;

  constructor(consumer: Reference, port: string, action: GmailAction) {
    this.consumer = consumer;
    this.port = port;
    this.action = action;
    this.id = refer({
      provider,
      consumer: this.consumer,
      port: this.port,
      action: this.action,
    });
  }

  get Assert(): Fact {
    return [provider, `~/send`, { status: "Open", source: this } as any];
  }
}

// Helper functions to create Gmail actions
export const listMessages = (
  consumer: Reference,
  port: string,
  userId: string,
  query?: string,
) => new Gmail(consumer, port, { type: "listMessages", userId, q: query });

export const getMessage = (
  consumer: Reference,
  port: string,
  userId: string,
  messageId: string,
) => new Gmail(consumer, port, { type: "getMessage", userId, id: messageId });

export const sendMessage = (
  consumer: Reference,
  port: string,
  userId: string,
  message: GmailMessage,
) => new Gmail(consumer, port, { type: "sendMessage", userId, message });

type EmailPreview = {
  id: string;
  threadId: string;
  snippet: string;
  date: Date;
  from: string;
  subject: string;
};

type RichEmail = {
  id: string;
  threadId: string;
  snippet: string;
  date: number;
  from: string;
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  body: string;
};

function parseEmailPreview(message: any): RichEmail {
  const headers = message.payload.headers;
  const getHeader = (name: string) =>
    headers.find((h: any) => h.name.toLowerCase() === name.toLowerCase())
      ?.value || "";

  let body = "";
  if (message.payload.body.data) {
    body = atob(
      message.payload.body.data.replace(/-/g, "+").replace(/_/g, "/"),
    );
  } else if (message.payload.parts) {
    const textPart = message.payload.parts.find(
      (part: any) =>
        part.mimeType === "text/plain" || part.mimeType === "text/html",
    );
    if (textPart?.body?.data) {
      body = atob(textPart.body.data.replace(/-/g, "+").replace(/_/g, "/"));
    }
  }

  return {
    id: message.id,
    threadId: message.threadId,
    snippet: message.snippet,
    date: message.internalDate,
    from: getHeader("from"),
    to: getHeader("to"),
    cc: getHeader("cc"),
    bcc: getHeader("bcc"),
    subject: getHeader("subject"),
    body,
  };
}
