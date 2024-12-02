import {
  h,
  behavior,
  $,
  Session,
  select,
  refer,
  Reference
} from "@commontools/common-system";
import { event, events, Collection, isEmpty, CollectionView, defaultTo, } from "../../sugar.js";
import { CommonFormSubmitEvent } from "../../../../common-ui/lib/components/common-form.js";
import { llm, RESPONSE } from "../../effects/fetch.jsx";

export const source = { chat: { v: 1 } };

// attribute names

export const ChatModel = {
  messages: "messages"
}

const CHAT_REQUEST = 'chat/request'

// events

export const ChatEvents = events({
  onSendMessage: '~/on/SendMessage',
  onDraftMessage: '~/on/DraftMessage',
  onBroadcastHistory: '~/on/BroadcastHistory',
  onClearChat: '~/on/ClearChat',
})

// queries

export const Messages = Collection.of({
  message: $.message,
  author: $.author,
  sentAt: $.sentAt
});

export const ChatResolver = select({
  self: $.self,
  messages: Messages.select
})
  .match($.self, "messages", $.messages)
  .clause(Messages.match($.messages));

export const ChatUiResolver = select({ chatView: $.chatView })
  .clause(defaultTo($.self, '~/common/ui/chat', $.chatView, null))

const Uninitialized = select({ self: $.self })
  .clause(isEmpty($.self, ChatModel.messages));

// behavior

export type ChatMessageEvent = {
  message: string;
}

export function sendMessage(self: Reference, message: ChatMessageEvent) {
  return Session.upsert([self, ChatEvents.onSendMessage, message as any])
}

export const ChatMessageList = ({ collection }: { collection: CollectionView<{ author: string, message: string, sentAt: number }> }) => {
  const items = [...collection]
  items.sort((a, b) => a.sentAt - b.sentAt)

  return (
    <ul style="list-style: none; padding: 0; margin: 0 0 20px 0; max-height: 400px; overflow-y: auto;">
      {items.map(item => <li key={item.author + item.message + item.sentAt} style={`
      padding: 12px;
      margin: 8px 0;
      border-radius: 8px;
      background: ${item.author === 'assistant' ? '#fff' : '#007bff'};
      color: ${item.author === 'assistant' ? '#000' : '#fff'};
      max-width: 80%;
      ${item.author === 'assistant' ? 'margin-right: auto;' : 'margin-left: auto;'}
    `}>
        <b>{item.author}</b>: {item.message}
        <sub style="opacity: 0.7; display: block; font-size: 0.8em; margin-top: 4px;">
          {new Date(item.sentAt).toLocaleTimeString()}
        </sub>
      </li>)}
    </ul>
  )
};

export const ChatSubmitForm = () => (
  <common-form reset oncommon-submit="~/on/submit">
    <fieldset style="border: none; padding: 0; margin: 0;">
      <label style="display: none;">Message</label>
      <div style="display: flex; gap: 8px;">
        <input
          name="message"
          type="text"
          placeholder="Type your message..."
          style="flex: 1; padding: 12px; border-radius: 20px; border: 1px solid #ddd; font-size: 16px;"
        />
        <button type="submit" style="padding: 12px 24px; border-radius: 20px; border: none; background: #007bff; color: white; cursor: pointer;">Send</button>
      </div>
    </fieldset>
  </common-form>
);

export const Chattable = (config: {
  greeting?: string,
  attributes?: string[],
  systemPrompt?: (values: Record<string, any>) => string
} = {}) => {
  const {
    greeting = "Hello! How can I help you today?",
    attributes = [],
    systemPrompt = () => ''
  } = config;

  return behavior({
    'chat/init': Uninitialized
      .update(({ self }) => {
        const collection = Messages.new({ messages: self, seed: refer({ v: Math.random() }) })
        return [
          ...collection.push({
            message: greeting,
            author: "assistant",
            sentAt: Date.now()
          })
        ];
      })
      .commit(),

    'chat/send': event(ChatEvents.onSendMessage)
      .with(ChatResolver)
      .select({
        ...Object.fromEntries(attributes.map(a => [a, $[a]]))
      })
      .matches(...attributes.map(a => [$.self, a, $[a]] as any))
      .update(({ self, event, messages, ...values }) => {
        const payload = Session.resolve<ChatMessageEvent>(event)
        const collection = Messages.from(messages)
        const userMessage = payload.message

        const newMessage = {
          message: userMessage,
          author: "user",
          sentAt: Date.now()
        };
        const msgs = [...collection, newMessage];
        msgs.sort((a, b) => a.sentAt - b.sentAt);
        const messageHistory = msgs.map(msg => ({
          role: msg.author,
          content: msg.message
        }))

        return [
          Session.retract([self, ChatEvents.onSendMessage, event]),
          llm(self, CHAT_REQUEST, {
            messages: messageHistory,
            system: systemPrompt(values),
          }).json(),
          ...collection.push(newMessage),
        ];
      })
      .commit(),

    "chat/complete": select({
      self: $.self,
      request: $.request,
      payload: $.payload,
      content: $.content,
    })
      .match($.self, CHAT_REQUEST, $.request)
      .match($.request, RESPONSE.JSON, $.payload)
      .match($.payload, "content", $.content)
      .with(ChatResolver)
      .update(({ self, request, content, messages, payload }) => {
        const collection = Messages.from(messages)
        return [
          { Retract: [self, CHAT_REQUEST, request] },
          { Retract: [request, RESPONSE.JSON, payload] },
          ...collection.push({
            message: content,
            author: "assistant",
            sentAt: Date.now()
          }),
        ];
      })
      .commit(),

    'chat/clear': event(ChatEvents.onClearChat)
      .select({ messages: $.messages })
      .match($.self, ChatModel.messages, $.messages)
      .update(({ self, messages }) => {
        return [
          { Retract: [self, "messages", messages] }
        ];
      })
      .commit(),

    onSubmit: event('~/on/chat/submit')
      .update(({ self, event }) => {
        const payload = Session.resolve<CommonFormSubmitEvent>(event)
        const userMessage = payload.detail.formData.get('message')

        return [
          sendMessage(self, { message: userMessage as string })
        ];
      })
      .commit(),

    'chat/view': ChatResolver
      .update(({ self, messages }) => {
        const collection = Messages.from(messages);

        return [
          {
            Upsert: [
              self,
              "~/common/ui/chat",
              <div style="max-width: 800px; margin: 20px auto; padding: 20px; background: #f5f5f5; border-radius: 12px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
                <ChatMessageList collection={collection} />
                <ChatSubmitForm />
                <button
                  type="button"
                  onclick={ChatEvents.onClearChat}
                  style="margin-top: 12px; padding: 8px 16px; border-radius: 8px; border: none; background: #dc3545; color: white; cursor: pointer;"
                >
                  Clear Chat
                </button>
              </div> as any,
            ],
          },
        ]
      })
      .commit(),
  });
};
