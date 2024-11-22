import {
  h,
  behavior,
  $,
  Session,
  select
} from "@commontools/common-system";
import * as Collection from "../sugar/collections.js";
import { event, Events } from "../sugar/event.js";
import { CommonInputEvent } from "../../../common-ui/lib/components/common-input.js";
import { defaultTo, isEmpty } from "../sugar/default.js";
import * as Transact from "../sugar/transact.js";
import { addTag } from "../sugar/tags.js";
import { render } from "../sugar/render.js";

export const source = { chat: { v: 1 } };

// attribute names

export const ChatModel = {
  draft: '~/draft',
  screenName: '~/screenName',
  messages: "messages"
}

// events

const events: Events = {
  onSendMessage: '~/on/SendMessage',
  onDraftMessage: '~/on/DraftMessage',
  onChangeScreenName: '~/on/ChangeScreenName',
  onBroadcastHistory: '~/on/BroadcastHistory',
}

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
  draft: $.draft,
  screenName: $.screenName,
  messages: Messages.select
})
  .clause(defaultTo($.self, ChatModel.draft, $.draft, ''))
  .clause(defaultTo($.self, ChatModel.screenName, $.screenName, '<empty>'))
  .match($.self, "messages", $.messages)
  .clause(Messages.match($.messages));

const Uninitialized = select({ self: $.self })
  .clause(isEmpty($.self, ChatModel.messages));

// behavior

export const chatRules = behavior({
  init: Uninitialized
    .update(({ self }) => {
      const collection = Messages.new({ messages: self })
      return [
        ...collection.push({
          message: "hello world",
          author: "system",
          sentAt: Date.now()
        })
      ];
    })
    .commit(),

  sendMessage: event(events.onSendMessage)
    .with(Chat)
    .update(({ self, event, screenName, messages, draft }) => {
      const collection = Messages.from(messages)
      const allMessages = [...collection];

      return [
        ...Transact.remove(self, { '~/draft': draft }),
        ...collection.push({ message: draft, author: screenName, sentAt: Date.now() })
      ];
    })
    .commit(),

  editMessage: event(events.onDraftMessage)
    .update(({ self, event }) => {
      return Transact.set(self, {
        [ChatModel.draft]: Session.resolve<CommonInputEvent>(event).detail.value
      })
    })
    .commit(),

  changeName: event(events.onChangeScreenName)
    .update(({ self, event }) => {
      return Transact.set(self, {
        [ChatModel.screenName]: Session.resolve<CommonInputEvent>(event).detail.value
      })
    })
    .commit(),

  broadcast: event(events.onBroadcastHistory)
    .with(MessageHistoryLink)
    .update(({ messages }) => {
      return [
        addTag(messages, '#chat')
      ]
    })
    .commit(),

  // CommonChat.select({ draft, screenName, messages })
  //  .default({ draft: '', screenName: '<empty>' })
  view: Chat
    .update(({ self, messages, screenName, draft }) => {
      const collection = Messages.from(messages);

      return [
        render({ self }, ({ self }) => (
          <div title="Common Chat">
            <ul>{...[...collection].map(item => <li key={item.author + item.message}>
              <b>{item.author}</b>: {item.message} <sub style="opacity: 0.5;">{new Date(item.sentAt).toLocaleTimeString()}</sub>
            </li>)}</ul>
            <fieldset style="border-radius: 8px;">
              <label>Name</label>
              <common-input type="text" value={screenName} oncommon-input={events.onChangeScreenName} />
              <label>Message</label>
              <common-input type="text" value={draft} placeholder="say something!" oncommon-input={events.onDraftMessage} />
              <button onclick={events.onSendMessage}>Send</button>
            </fieldset>
            <button onclick={events.onBroadcastHistory}>Broadcast History</button>
          </div>
        )),
      ];
    })
    .commit(),
});

console.log(chatRules)

export const spawn = (input: {} = source) => chatRules.spawn(input);
