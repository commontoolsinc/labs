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
import * as DB from 'datalogia'

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

function isEmpty(self: Variable<Reference>, attribute: string): Clause {
  return { Not: { Case: [self, attribute, $._] } };
}

const CommonChat = {
  draft: '~/draft',
  screenName: '~/screenName',
  messages: "messages"
}

// Adopt datalogia patterns?
// const CommonChatModel = DB.entity({
//   '~/draft': DB.string,
//   '~/screenName': DB.string,
// })

// const chat = {
//   draft: DB.string,
//   screenName: DB.string,
// }

const Messages = Collection.of({
  message: $.message,
  author: $.author,
  sentAt: $.sentAt
});

class EventDeclaration {
  name: string;

  constructor(name: string) {
    this.name = name;
  }

  subscribe() {
    return event(this.name);
  }

  dispatch() {
    return this.name.startsWith('~/on/') ? this.name : `~/on/${this.name}`;
  }
}

function declareEvents<T extends Record<string, string>>(events: T): { [K in keyof T]: EventDeclaration } {
  const declarations = {} as { [K in keyof T]: EventDeclaration };
  for (const [name, path] of Object.entries(events)) {
    declarations[name as keyof T] = new EventDeclaration(path);
  }
  return declarations;
}

const events = declareEvents({
  onSendMessage: 'onSendMessage',
  onDraftMessage: 'onDraftMessage',
  onChangeScreenName: 'onChangeScreenName',
})

export const chatRules = behavior({
  init: {
    select: {
      self: $.self,
    },
    where: [isEmpty($.self, CommonChat.messages)],
    update: ({ self }) => {
      return Messages.new({ messages: self }).push({ message: "hello world", author: "system", sentAt: Date.now() });
    },
  },

  // sendMessage:
  //   events.onSendMessage
  //     .subscribe()
  //     .select({ draft: $.draft, screenName: $.screenName }) // .include(CommonChat.select({ draft, screenName }))
  //     .match($.self, CommonChat.draft, $.draft)
  //     .match($.self, CommonChat.screenName, $.screenName)
  //     .update(({ self, event, screenName, draft }) => {
  //       return [
  //         ...transact(self, { [CommonChat.draft]: draft }, tx => {
  //           delete tx[CommonChat.draft];
  //         }),
  //         ...Messages.new({ messages: self }).push({
  //           message: draft,
  //           author: screenName,
  //           sentAt: Date.now()
  //         })
  //       ];
  //     })
  //     .commit(),

  sendMessage: events.onSendMessage.subscribe()
    .select({
      draft: $.draft,
      screenName: $.screenName,
      messages: Messages
    })
    .match($.self, '~/draft', $.draft)
    .match($.self, '~/screenName', $.screenName)
    .match($.self, "messages", $.messages)
    .clause(Messages.match($.messages))
    .update(({ self, event, screenName, messages, draft }) => {
      const collection = Messages.from(messages)
      const allMessages = [...collection];

      return [
        ...retract(self, { '~/draft': draft }),
        ...collection.push({ message: draft, author: screenName, sentAt: Date.now() })
      ];
    })
    .commit(),

  editMessage: events.onDraftMessage
    .subscribe()
    .update(({ self, event }) => {
      return transact(self, { [CommonChat.draft]: '' }, tx => {
        tx[CommonChat.draft] = Session.resolve<CommonInputEvent>(event).detail.value;
      });
    })
    .commit(),

  // events.onChangeScreenName
  //   .listen(({ self, event }) => {}))
  changeName: events.onChangeScreenName
    .subscribe()
    .update(({ self, event }) => {
      return transact(self, { [CommonChat.screenName]: '' }, tx => {
        tx[CommonChat.screenName] = Session.resolve<CommonInputEvent>(event).detail.value;
      });
    })
    .commit(),


  // CommonChat.select({ draft, screenName, messages })
  //  .default({ draft: '', screenName: '<empty>' })
  view: {
    select: {
      self: $.self,
      screenName: $.screenName,
      draft: $.draft,
      messages: Messages,
    },
    where: [
      defaultTo($.self, CommonChat.screenName, $.screenName, '<empty>'), // include($.self, CommonChat.screenName, '<empty>')
      defaultTo($.self, CommonChat.draft, $.draft, ''), // include($.self, CommonChat.draft, '')
      { Case: [$.self, CommonChat.messages, $.messages] }, // includeCollection($.self, $.messages, CommonChat.messages, Messages)
      Messages.match($.messages),
    ],
    update: ({ self, messages, screenName, draft }) => {
      const collection = Messages.from(messages);

      return [
        render({ self }, ({ self }) => (
          <div title="Common Chat">
            <ul>{...[...collection].map(item => <li key={item.author + item.message}>
              <b>{item.author}</b>: {item.message} <sub style="opacity: 0.5;">{new Date(item.sentAt).toLocaleTimeString()}</sub>
            </li>)}</ul>
            <fieldset>
              <label>Name</label>
              <common-input type="text" value={screenName} oncommon-input={events.onChangeScreenName.dispatch()} />
              <label>Message</label>
              <common-input type="text" value={draft} placeholder="say something!" oncommon-input={events.onDraftMessage.dispatch()} />
              <button onclick={events.onSendMessage.dispatch()}>Send</button>
            </fieldset>
          </div>
        )),
      ];
    },
  },
});

export const spawn = (input: {} = source) => chatRules.spawn(input);
