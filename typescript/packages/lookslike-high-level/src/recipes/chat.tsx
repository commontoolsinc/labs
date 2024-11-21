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

export const source = { keywords: { v: 1 } };

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

const Messages = Collection.of({
  message: $.message,
  author: $.author,
  sentAt: $.sentAt
});

const Events = {
  onSendMessage: '~/on/onSendMessage',
  onDraftMessage: '~/on/onDraftMessage',
  onChangeScreenName: '~/on/onChangeScreenName',
}

export const chat = behavior({
  init: {
    select: {
      self: $.self,
    },
    where: [{ Not: { Case: [$.self, "messages", $._] } }],
    update: ({ self }) => {
      return Messages.new({ messages: self }).push({ message: "hello world", author: "system", sentAt: Date.now() });
    },
  },

  sendMessage: event('onSendMessage')
    .select({ draft: $.draft, screenName: $.screenName })
    .match($.self, '~/draft', $.draft)
    .match($.self, '~/screenName', $.screenName)
    .update(({ self, event, screenName, draft }) => {
      return [
        ...retract(self, { '~/draft': draft }),
        ...Messages.new({ messages: self }).push({ message: draft, author: screenName, sentAt: Date.now() })
      ];
    })
    .commit(),

  editMessage: event('onDraftMessage')
    .update(({ self, event }) => {
      console.log(Session.resolve(event))
      return upsert(self, { '~/draft': Session.resolve<CommonInputEvent>(event).detail.value });
    })
    .commit(),

  changeName: event('onChangeScreenName')
    .update(({ self, event }) => {
      console.log(Session.resolve(event))
      return upsert(self, { '~/screenName': Session.resolve<CommonInputEvent>(event).detail.value });
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
      defaultTo($.self, '~/screenName', $.screenName, '<empty>'),
      defaultTo($.self, '~/draft', $.draft, ''),
      { Case: [$.self, "messages", $.messages] },
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
              <common-input type="text" value={screenName} oncommon-input={Events.onChangeScreenName} />
              <label>Message</label>
              <common-input type="text" value={draft} placeholder="say something!" oncommon-input={Events.onDraftMessage} />
              <button onclick={Events.onSendMessage}>Add</button>
            </fieldset>
          </div>
        )),
      ];
    },
  },
});

export const spawn = (input: {} = source) => chat.spawn(input);
