import {
  h,
  behavior,
  $,
  Session,
  select,
  refer
} from "@commontools/common-system";
import { event, events, Collection, defaultTo, isEmpty, Transact, addTag, render } from "../sugar.js";
import { CommonInputEvent } from "../../../common-ui/lib/components/common-input.js";
import { CommonFormSubmitEvent } from "../../../common-ui/lib/components/common-form.js";
import { llm, RESPONSE } from "../effects/fetch.jsx";

export const source = { chat: { v: 1 } };

// attribute names

export const ChatModel = {
  messages: "messages"
}

const CHAT_REQUEST = 'chat/request'

// events

const ChatEvents = events({
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

const MessageHistoryLink = select({ messages: $.messages })
  .match($.self, "messages", $.messages)

const Chat = select({
  self: $.self,
  messages: Messages.select
})
  .match($.self, "messages", $.messages)
  .clause(Messages.match($.messages));

const Uninitialized = select({ self: $.self })
  .clause(isEmpty($.self, ChatModel.messages));

// behavior

export const chatRules = behavior({
  init: Uninitialized
    .update(({ self }) => {
      const collection = Messages.new({ messages: self, seed: refer({ v: Math.random() }) })
      return [
        ...collection.push({
          message: "Hello! How can I help you today?",
          author: "assistant",
          sentAt: Date.now()
        })
      ];
    })
    .commit(),

  on: event('~/on/submit')
    .with(Chat)
    .update(({ self, event, messages }) => {
      const payload = Session.resolve<CommonFormSubmitEvent>(event)
      const collection = Messages.from(messages)
      const userMessage = payload.detail.formData.get('message')

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
        llm(self, CHAT_REQUEST, {
          messages: messageHistory,
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
    .with(Chat)
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

  broadcast: event(ChatEvents.onBroadcastHistory)
    .with(MessageHistoryLink)
    .update(({ messages }) => {
      return [
        ...addTag(messages, '#chat')
      ]
    })
    .commit(),

  clear: event(ChatEvents.onClearChat)
    .select({ messages: $.messages })
    .match($.self, ChatModel.messages, $.messages)
    .update(({ self, messages }) => {
      return [
        { Retract: [self, "messages", messages] }
      ];
    })
    .commit(),

  view: Chat
    .render(({ self, messages }) => {
      const collection = Messages.from(messages);
      const items = [...collection]
      console.log('chat', items)
      items.sort((a, b) => a.sentAt - b.sentAt)

      return <div title="Common Chat" style="max-width: 800px; margin: 20px auto; padding: 20px; background: #f5f5f5; border-radius: 12px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
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
        <button
          type="button"
          onclick={ChatEvents.onClearChat}
          style="margin-top: 12px; padding: 8px 16px; border-radius: 8px; border: none; background: #dc3545; color: white; cursor: pointer;"
        >
          Clear Chat
        </button>
      </div>
    })
    .commit(),
});

console.log(chatRules)

export const spawn = (input: {} = source) => chatRules.spawn(input, "Chat");
