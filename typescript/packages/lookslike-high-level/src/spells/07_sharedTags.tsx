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
import { generateDescription, genImage } from "./04_tamagotchi.jsx";

export const source = { viewer: 1 };

const SharedDataEvents = events({
  onEditTag: "~/on/editTag",
});

const searchTag = field("searchTag", "#chat");

const TagSearch = ({ tag }: { tag: string }) => (
  <fieldset>
    <common-input
      value={tag}
      type="text"
      oncommon-blur={SharedDataEvents.onEditTag}
    />
  </fieldset>
);

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
            <TagSearch tag={searchTag} />
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
    .clause(defaultTo($.creature, "description", $.description, ""))
    .clause(defaultTo($.creature, "color", $.color, ""))
    .render(({ searchTag, creature }) => {
      const containerStyle = "display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 20px; padding: 20px;";
      const cardStyle = "border: 2px solid #444; border-radius: 8px; padding: 10px; background: #fff; box-shadow: 0 2px 5px rgba(0,0,0,0.2);";
      const imageStyle = "width: 100%; height: 180px; object-fit: cover; border-radius: 4px;";
      const statsStyle = "display: flex; gap: 10px; margin-top: 10px; font-size: 12px;";
      const statPipStyle = "padding: 4px 8px; background: #eee; border-radius: 12px;";

      return (
        <div title="Shared">
          <TagSearch tag={searchTag} />
          <div style={containerStyle}>
            {creature.map(c => (
              <div key={c.self.toString()} style={cardStyle}>
                <img
                  style={imageStyle}
                  src={genImage(generateDescription(c))}
                  alt={c.description}
                />
                <div style={statsStyle}>
                  <span style={statPipStyle}>Size: {c.size}</span>
                  <span style={statPipStyle}>Hunger: {c.hunger}</span>
                </div>
              </div>
            ))}
          </div>
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
            <TagSearch tag={searchTag} />
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
            <TagSearch tag={searchTag} />
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

  clips: {
    select: {
      self: $.self,
      shared: [{ self: $.shared, sourceUrl: $.sourceUrl }],
      searchTag: $.searchTag,
    },
    where: [
      { Case: [$.self, "searchTag", $.searchTag] },
      { Case: [tags, $.searchTag, $.shared] },
      { Case: [$.shared, "sourceUrl", $.sourceUrl] },
    ],
    update: ({ self, shared, searchTag }) => {
      return [
        render({ self }, ({ self }) => (
          <div title="Shared">
            <TagSearch tag={searchTag} />
            <div>
              <pre>{JSON.stringify(shared, null, 2)}</pre>
            </div>
          </div> as any
        )),
      ];
    },
  },

  emails: {
    select: {
      self: $.self,
      shared: [{ self: $.shared, from: $.from, subject: $.subject, snippet: $.snippet, threadId: $.threadId }],
      searchTag: $.searchTag,
    },
    where: [
      { Case: [$.self, "searchTag", $.searchTag] },
      { Case: [tags, $.searchTag, $.shared] },
      { Case: [$.shared, "from", $.from] },
      { Case: [$.shared, "subject", $.subject] },
      { Case: [$.shared, "snippet", $.snippet] },
      { Case: [$.shared, "threadId", $.threadId] },
    ],
    update: ({ self, shared, searchTag }) => {
      const tableStyle = "width: 100%; border-collapse: collapse;";
      const cellStyle = "padding: 12px; border-bottom: 1px solid #eee;";
      const headerStyle = "text-align: left; padding: 12px; border-bottom: 2px solid #ddd; background: #f9f9f9;";

      return [
        render({ self }, ({ self }) => (
          <div title="Shared">
            <TagSearch tag={searchTag} />
            <table style={tableStyle}>
              <thead>
                <tr>
                  <th style={headerStyle}>From</th>
                  <th style={headerStyle}>Subject</th>
                </tr>
              </thead>
              <tbody>
                {shared.map(email => (
                  <tr key={email.threadId}>
                    <td style={cellStyle}>{email.from}</td>
                    <td style={cellStyle}>{email.subject}</td>
                  </tr>
                ))}
              </tbody>
            </table>
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
