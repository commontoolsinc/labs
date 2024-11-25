import {
  h,
  behavior,
  $,
  Session,
} from "@commontools/common-system";
import { event, events } from "../sugar/event.js";
import { CommonInputEvent } from "../../../common-ui/lib/components/common-input.js";
import { tags } from "../sugar/inbox.js";
import { render } from "../sugar/render.jsx";
import { Messages } from "./06_chat.jsx";

export const source = { chat: { v: 1 } };

const SharedDataEvents = events({
  onEditTag: '~/on/editTag'
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
            <common-input value={searchTag} type="text" oncommon-input={SharedDataEvents.onEditTag} />
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
            <common-input value={searchTag} type="text" oncommon-input={SharedDataEvents.onEditTag} />
          </fieldset>
          <pre>{JSON.stringify(shared, null, 2)}</pre>
        </div>
      ))]
    }
  },

  view: {
    select: {
      self: $.self,
      shared: [Messages.select],
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
            <common-input value={searchTag} type="text" oncommon-input={SharedDataEvents.onEditTag} />
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

  editTag: event(SharedDataEvents.onEditTag)
    .update(({ self, event }) => {
      const ev = Session.resolve<CommonInputEvent>(event)
      return [
        { Upsert: [self, 'searchTag', ev.detail.value] }
      ]
    })
    .commit(),
});

export const spawn = (input: {} = source) => sharedDataViewer.spawn(input);
