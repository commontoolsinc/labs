import { h } from "@commontools/html";
import {
  cell,
  derive,
  handler,
  type JSONSchema,
  NAME,
  recipe,
  type Schema,
  UI,
} from "@commontools/builder/interface";

// README:
// sudo tailscale serve --https=443 localhost:8080
// you need OPERATOR_PASS set so that it doesn't default to "implicit trust"
// OPERATOR_PASS="common user" TOOLSHED_API_URL=https://toolshed.saga-castor.ts.net deno task start --spaceName discordstuff --cause 420 --recipeFile ../recipes/discord.tsx
// then you go to
// TOOLSHED_URL/discordstuff

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
    "thread_id",
  ],
} as const satisfies JSONSchema;
type MessageSchema = Schema<typeof MessageSchema>;

const InputSchema = {
  type: "object",
  properties: {
    requestor_id: {
      type: "string",
      description:
        "requestor id, discord api server keeps track of what messages were sent with this id",
      default: "420",
    },
  },
  required: ["requestor_id"],
  description: "Schema for Discord Messages input, just requestor_id",
} as const satisfies JSONSchema;

const ResultSchema = {
  type: "object",
  properties: {
    messages: {
      type: "array",
      items: MessageSchema,
    },
    requestor_id: {
      type: "string",
    },
    discordUpdater: { asStream: true, type: "object", properties: {} },
  },
} as const satisfies JSONSchema;

const discordUpdater = handler(
  {},
  // this is the state object
  {
    type: "object",
    properties: {
      messages: {
        type: "array",
        items: MessageSchema,
        default: [],
        asCell: true,
      },
      requestor_id: {
        type: "string",
        default: "420",
      },
    },
    required: ["messages", "requestor_id"],
  },
  async (_event, state) => {
    const requestor_id = state.requestor_id;
    const messages_data = await fetchMessages(requestor_id);
    console.log(
      "messages data ",
      messages_data,
      " length=",
      messages_data.length,
    );

    // this was set in the recipe export, see end of return object of recipe
    state.messages.push(...messages_data);
  },
);

export async function fetchMessages(requestor_id: string) {
  requestor_id = requestor_id || "421";
  const api_url =
    "https://macbookair.saga-castor.ts.net/api/messages?requestor_id=" +
    requestor_id;
  const messages_fetch = await fetch(api_url);
  return await messages_fetch.json();
}

export default recipe(
  InputSchema,
  ResultSchema,
  ({ requestor_id }) => {
    const messages = cell<MessageSchema[]>([]);
    derive(messages, (messages) => {
      console.log("REQUESTOR-ID is ", requestor_id);
    });

    return {
      [NAME]: "Discord Messages jake",
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
      messages, // this sets state.messages, we inspect in handler()
      requestor_id,
      bgUpdater: discordUpdater({ messages, requestor_id }),
    };
  },
);
