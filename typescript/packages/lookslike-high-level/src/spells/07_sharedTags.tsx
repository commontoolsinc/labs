import { h, behavior, $, Session, select } from "@commontools/common-system";
import {
  event,
  events,
  tags,
  each,
  render,
  field,
  defaultTo,
} from "../sugar.js";
import { CommonInputEvent } from "../../../common-ui/lib/components/common-input.js";
import { Messages } from "./06_chat.jsx";
import { articlePreview } from "./09_importer.jsx";
import { genImage } from "./04_tamagotchi.jsx";

export const source = { viewer: 1 };

const SharedDataEvents = events({
  onEditTag: "~/on/editTag",
});

const searchTag = field("searchTag", "#chat");

export const sharedDataViewer = behavior({
  init: {
    select: { self: $.self },
    where: [{ Not: { Case: [$.self, "searchTag", $._] } }],
    update: ({ self }) => {
      return [{ Assert: [self, "searchTag", "#chat"] }];
    },
  },

  empty: {
    select: {
      self: $.self,
      searchTag: $.searchTag,
    },
    where: [
      { Case: [$.self, "searchTag", $.searchTag] },
      { Not: { Case: [tags, $.searchTag, $.shared] } },
    ],
    update: ({ self, searchTag }) => {
      return [
        render({ self }, ({ self }) => (
          <div title="Shared">
            <fieldset>
              <common-input
                value={searchTag}
                type="text"
                oncommon-input={SharedDataEvents.onEditTag}
              />
            </fieldset>
          </div> as any
        )),
      ];
    },
  },

  creature: select({
    self: $.self,
    searchTag: $.searchTag,
    creature: [
      {
        self: $.creature,
        size: $.size,
        hunger: $.hunger,
        time: $.time,
        description: $.description,
        color: $.color,
      },
    ],
  })
    .clause({ Case: [$.self, "searchTag", $.searchTag] })
    .clause({ Case: [tags, $.searchTag, $.creature] })
    .match($.creature, "size", $.size)
    .match($.creature, "hunger", $.hunger)
    .match($.creature, "time", $.time)
    .clause(defaultTo($.creature, "llmDescription", $.description, ""))
    .clause(defaultTo($.creature, "color", $.color, ""))
    .render(({ searchTag, creature }) => {
      return (
        <div title="Shared">
          <fieldset>
            <common-input
              value={searchTag}
              type="text"
              oncommon-input={SharedDataEvents.onEditTag}
            />
          </fieldset>

          {creature.map(c => (
            <div
              key={c.self.toString()}
              style={{ display: "flex", flexDirection: "row" }}
            >
              <img width="100" height="100" src={genImage(c.description)} />
              {c.description}
            </div>
          ))}
        </div>
      );
    })
    .commit(),

  view: {
    select: {
      self: $.self,
      shared: [Messages.select],
      searchTag: $.searchTag,
    },
    where: [
      { Case: [$.self, "searchTag", $.searchTag] },
      { Case: [tags, $.searchTag, $.shared] },
      Messages.match($.shared),
    ],
    update: ({ self, shared, searchTag }) => {
      return [
        render({ self }, ({ self }) => (
          <div title="Shared">
            <fieldset>
              <common-input
                value={searchTag}
                type="text"
                oncommon-input={SharedDataEvents.onEditTag}
              />
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
          </div> as any
        )),
      ];
    },
  },

  articles: {
    select: {
      self: $.self,
      shared: [{ self: $.shared, url: $.url, content: $.content }],
      searchTag: $.searchTag,
    },
    where: [
      { Case: [$.self, "searchTag", $.searchTag] },
      { Case: [tags, $.searchTag, $.shared] },
      { Case: [$.shared, "url", $.url] },
      { Case: [$.shared, "content", $.content] },
    ],
    update: ({ self, shared, searchTag }) => {
      return [
        render({ self }, ({ self }) => (
          <div title="Shared">
            <fieldset>
              <common-input
                value={searchTag}
                type="text"
                oncommon-input={SharedDataEvents.onEditTag}
              />
            </fieldset>
            <div>
              {each(
                shared.map(s => s.self),
                articlePreview,
              )}
            </div>
          </div> as any
        )),
      ];
    },
  },

  editTag: event(SharedDataEvents.onEditTag)
    .update(({ self, event }) => {
      const ev = Session.resolve<CommonInputEvent>(event);
      return [{ Upsert: [self, "searchTag", ev.detail.value] }];
    })
    .commit(),
});

export const spawn = (input: {} = source) =>
  sharedDataViewer.spawn(input, "Shared Data");
