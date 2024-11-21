import {
  h,
  behavior,
  $,
  Variable,
  Constant,
  Clause,
  Reference,
  View,
  Instruction,
  Session
} from "@commontools/common-system";
import * as Collection from "../sugar/collections.js";
import { event } from "../sugar/event.js";
import { CommonInputEvent } from "../../../common-ui/lib/components/common-input.js";

export const source = { chat: { v: 1 } };

function transact<T extends Record<string, any>>(ref: Reference, fields: T, closure: (tx: T) => void): Instruction[] {
  const original = { ...fields };
  const proxy = { ...fields };
  closure(proxy);

  const instructions: Instruction[] = [];

  // Check for changed/new values
  Object.entries(proxy).forEach(([key, value]) => {
    if (!(key in original) || original[key] !== value) {
      instructions.push({ Upsert: [ref, key, value] } as Instruction);
    }
  });

  // Check for deleted values
  Object.keys(original).forEach(key => {
    if (!(key in proxy)) {
      instructions.push({ Retract: [ref, key, original[key]] } as Instruction);
    }
  });

  return instructions;
}

function upsert(self: Reference, fields: {}): Instruction[] {
  return Object.entries(fields).map(([k, v]) => ({ Upsert: [self, k, v] } as Instruction));
}

function retract(self: Reference, fields: {}): Instruction[] {
  return Object.entries(fields).map(([k, v]) => ({ Retract: [self, k, v] } as Instruction));
}

function render<T extends { self: Reference }>(
  props: T,
  view: (props: T) => View<T>,
): Instruction {
  const vnode = view(props);
  return {
    Assert: [(props as any).self, "~/common/ui", vnode as any] as const,
  };
}

function defaultTo(
  entity: Variable<any>,
  attribute: string,
  field: Variable<any>,
  defaultValue: Constant,
): Clause {
  return {
    Or: [
      {
        And: [
          { Not: { Case: [entity, attribute, $._] } },
          { Match: [defaultValue, "==", field] },
        ],
      },
      { Case: [entity, attribute, field] },
    ],
  };
}

const CommonChat = {
  draft: '~/draft',
  screenName: '~/screenName',
  messages: "messages"
}

const Messages = Collection.of({
  message: $.message,
  author: $.author,
  sentAt: $.sentAt
});

const ChatEvents = {
  onSendMessage: '~/on/onSendMessage',
  onDraftMessage: '~/on/onDraftMessage',
  onChangeScreenName: '~/on/onChangeScreenName',
}

export const chat = behavior({
  init: {
    select: {
      self: $.self,
    },
    where: [{ Not: { Case: [$.self, CommonChat.messages, $._] } }],
    update: ({ self }) => {
      return Messages.new({ messages: self }).push({ message: "hello world", author: "system", sentAt: Date.now() });
    },
  },

  sendMessage: event(ChatEvents.onSendMessage)
    .select({ draft: $.draft, screenName: $.screenName })
    .match($.self, CommonChat.draft, $.draft)
    .match($.self, CommonChat.screenName, $.screenName)
    .update(({ self, event, screenName, draft }) => {
      return [
        ...transact(self, { [CommonChat.draft]: draft }, tx => {
          delete tx[CommonChat.draft];
        }),
        ...Messages.new({ messages: self }).push({
          message: draft,
          author: screenName,
          sentAt: Date.now()
        })
      ];
    })
    .commit(),

  editMessage: event(ChatEvents.onDraftMessage)
    .update(({ self, event }) => {
      console.log(Session.resolve(event))

      return transact(self, { [CommonChat.draft]: '' }, tx => {
        tx[CommonChat.draft] = Session.resolve<CommonInputEvent>(event).detail.value;
      });
    })
    .commit(),

  changeName: event(ChatEvents.onChangeScreenName)
    .update(({ self, event }) => {
      console.log(Session.resolve(event))
      return transact(self, { [CommonChat.screenName]: '' }, tx => {
        tx[CommonChat.screenName] = Session.resolve<CommonInputEvent>(event).detail.value;
      });
    })
    .commit(),

  view: {
    select: {
      self: $.self,
      screenName: $.screenName,
      draft: $.draft,
      messages: Messages,
    },
    where: [
      defaultTo($.self, CommonChat.screenName, $.screenName, '<empty>'),
      defaultTo($.self, CommonChat.draft, $.draft, ''),
      { Case: [$.self, CommonChat.messages, $.messages] },
      Messages.match($.messages),
    ],
    update: ({ self, messages, screenName, draft }) => {
      console.log(messages);
      const collection = Messages.from(messages);

      return [
        render({ self }, ({ self }) => (
          <div title="Common Chat">
            <ul>{...[...collection].map(item => <li key={item.author + item.message}>
              {item.author}: {item.message} <sub style="opacity: 0.5;">{new Date(item.sentAt).toLocaleTimeString()}</sub>
            </li>)}</ul>
            <fieldset>
              <label>Name</label>
              <common-input type="text" value={screenName} oncommon-input={ChatEvents.onChangeScreenName} />
              <label>Message</label>
              <common-input type="text" value={draft} placeholder="say something!" oncommon-input={ChatEvents.onDraftMessage} />
              <button onclick={ChatEvents.onSendMessage}>Add</button>
            </fieldset>
          </div>
        )),
      ];
    },
  },
});

export const spawn = (input: {} = source) => chat.spawn(input);
