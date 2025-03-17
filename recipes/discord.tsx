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

const MessageSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    timestamp: { type: "string" },
    user_id: { type: "string" },
    user_name: { type: "string" },
    channel_id: { type: "string" },
    content: { type: "string" },
    message_id: { type: "string" },
    guild_id: { type: "string" },
    mentions: { type: "array", items: { type: "string" }, default: [] },
    referenced_message_id: { type: "string" },
    thread_id: { type: "string" },
  },
  required: [
    "id",
    "timestamp",
    "user_id",
    "user_name",
    "channel_id",
    "content",
    "message_id",
    "guild_id",
    "mentions",
    "referenced_message_id",
    "thread_id"
  ],
} as const as JSONSchema;
type MessageSchema = Schema<typeof MessageSchema>;

const InputSchema = {
  type: "object",
  properties: {
    type: "object",
    properties: {
      requestor_id: {
        type: "string",
        description: "requestor id, discord api server keeps track of what messages were sent with this id",
        default: "420",
      },
    },
    required: ["requestor_id"],
  },
  description: "Schema for Discord Messages input, just requestor_id",
} as const satisfies JSONSchema;

const ResultSchema = {
  type: "object",
  properties: {
    messages: {
      type: "array",
      items: MessageSchema,
    },
    discordUpdater: { asStream: true, type: "object", properties: {} },
  },
} as const satisfies JSONSchema;

const discordUpdater = handler(
  {},
  {
    type: "object",
    properties: {
      messages: { type: "array", items: MessageSchema, default: [], asCell: true },
    },
    required: ["messages"],
  },
  async (_event, state) => {
    console.log("discordUpdater!");

      const requestor_id = state.requestor_id;
      const messages_data = await fetchMessages(requestor_id);
      console.log("messages data ", messages_data, " length=", messages_data.length);
      // console.log("before: state messages length=", state.messages.length);
      state.messages.push(...messages_data);
      // console.log("after: state messages length=", state.messages.length);
  },
);

// Helper function for sleeping
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchMessages(requestor_id: string) {
  const api_url = "https://macbookair.saga-castor.ts.net/api/messages?requestor_id=" + requestor_id;
  const messages_fetch = await fetch(api_url);
  return await messages_fetch.json();
}

export default recipe(
  InputSchema,
  ResultSchema,
  ({ requestor_id, messages }) => {
//    const messages = cell<MessageSchema[]>([]);
    derive(messages, (messages) => {
      console.log("trying to call a handler!!!");
      discordUpdater();
    });

    return {
      [NAME]: "Discord Messages",
      [UI]: (
        <div>
          <h1>Discord Messages</h1>
          <pre>
            {derive(messages, (messages) => {
              return JSON.stringify(messages, null, 2);
            })}
          </pre>  
        </div>
      ),
      discordUpdater: discordUpdater({}),
    };
  },
);



