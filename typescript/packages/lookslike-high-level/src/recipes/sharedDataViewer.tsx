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
  Session,
  refer
} from "@commontools/common-system";
import * as Collection from "../sugar/collections.js";
import { event } from "../sugar/event.js";
import { CommonInputEvent } from "../../../common-ui/lib/components/common-input.js";
import * as DB from 'datalogia'
import { CommonChat, Messages } from "./chat.jsx";
import { chatHistory, inbox, tags } from "../sugar/inbox.js";

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

const SharedData = {
}

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
  onEditTag: 'onEditTag'
})

export const sharedDataViewer = behavior({
  init: {
    select: { self: $.self },
    where: [
      { Not: { Case: [$.self, 'searchTag', $._] } }
    ],
    update: (({ self }) => {
      return [
        { Assert: [self, 'searchTag', '#chat'] }
      ]
    })
  },

  empty: {
    select: {
      self: $.self,
      searchTag: $.searchTag,
    },
    where: [
      { Case: [$.self, 'searchTag', $.searchTag] },
      { Not: { Case: [tags, $.searchTag, $.shared] } },
    ],
    update: ({ self, searchTag }) => {
      return [render({ self }, ({ self }) => (
        <div title="Shared">
          <fieldset>
            <common-input value={searchTag} type="text" oncommon-input={events.onEditTag.dispatch()} />
          </fieldset>
        </div>
      ))]
    },
  },

  creature: {
    select: {
      self: $.self,
      shared: [{
        hunger: $.hunger,
        size: $.size,
        time: $.time,
      }],
      searchTag: $.searchTag,
    },
    where: [
      { Case: [$.self, 'searchTag', $.searchTag] },
      { Case: [tags, $.searchTag, $.shared] },
      { Case: [$.shared, 'hunger', $.hunger] },
      { Case: [$.shared, 'size', $.size] },
      { Case: [$.shared, 'time', $.time] },
    ],
    update: ({ self, shared, searchTag }) => {
      return [render({ self }, ({ self }) => (
        <div title="Shared">
          <fieldset>
            <common-input value={searchTag} type="text" oncommon-input={events.onEditTag.dispatch()} />
          </fieldset>
          <pre>{JSON.stringify(shared, null, 2)}</pre>
        </div>
      ))]
    }
  },

  view: {
    select: {
      self: $.self,
      shared: [Messages],
      searchTag: $.searchTag,
    },
    where: [
      { Case: [$.self, 'searchTag', $.searchTag] },
      { Case: [tags, $.searchTag, $.shared] },
      Messages.match($.shared),
    ],
    update: ({ self, shared, searchTag }) => {
      return [render({ self }, ({ self }) => (
        <div title="Shared">
          <fieldset>
            <common-input value={searchTag} type="text" oncommon-input={events.onEditTag.dispatch()} />
          </fieldset>
          <div>
            {...shared.map((sharedItem, tableIndex) => {
              const collection = Messages.from(sharedItem);
              const messages = [...collection];
              return (
                <table key={tableIndex}>
                  <thead>
                    <tr>
                      <th>Author</th>
                      <th>Message</th>
                      <th>Sent at</th>
                    </tr>
                  </thead>
                  <tbody>
                    {...messages.map((message, index) => (
                      <tr key={index}>
                        <td>{message.author}</td>
                        <td>{message.message}</td>
                        <td>{message.sentAt}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              );
            })}
          </div>
        </div>
      ))]
    },
  },


  editTag: events.onEditTag.subscribe()
    .update(({ self, event }) => {
      const ev = Session.resolve<CommonInputEvent>(event)
      return [
        { Upsert: [self, 'searchTag', ev.detail.value] }
      ]
    })
    .commit(),
});

export const spawn = (input: {} = source) => sharedDataViewer.spawn(input);
