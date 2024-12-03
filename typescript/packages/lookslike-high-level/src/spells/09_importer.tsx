import { h, behavior, $, Reference, select, Session, refer } from "@commontools/common-system";
import { fetch, REQUEST, RESPONSE } from "../effects/fetch.js";
import { CommonInputEvent } from "../../../common-ui/lib/components/common-input.js";
import { addTag } from "../sugar.js";
import { Likeable, LikeButton, LikeEvents } from "./stickers/like.jsx";
import { mixin } from "../sugar/mixin.js";

const IMPORT_REQUEST = 'import/request'

const getMarkdown =
  (url: string) => `/api/reader/${url}`

const articlePreviewStyles = {
  container: 'background: #f8f9fa; border-radius: 8px; border: 1px solid #dfe1e5; padding: 16px; margin: 8px 0; box-shadow: 0 1px 6px rgba(32,33,36,.28)',
  url: 'color: #4285f4; font-style: italic; text-decoration: none; font-size: 14px',
  content: 'color: #202124; font-size: 16px; margin: 12px 0',
  actions: 'margin-top: 12px'
};

export const articlePreview = behavior({
  ...mixin(Likeable),

  defaultView: select({ self: $.self, url: $.url, content: $.content, likes: $.likes })
    .match($.self, 'url', $.url)
    .match($.self, 'content', $.content)
    .match($.self, 'likes', $.likes)
    .render(({ url, content, likes }) => (
      <div style={articlePreviewStyles.container}>
        <div><a href={url} style={articlePreviewStyles.url}>{url}</a></div>
        <div style={articlePreviewStyles.content}>
          <common-markdown markdown={content.substring(0, 320)} />
        </div>
        <div style={articlePreviewStyles.actions}>
          <LikeButton likes={likes} />
        </div>
      </div>
    ))
    .commit(),
})

const containerStyles = 'display: flex; flex-direction: column; align-items: center; padding: 24px; font-family: arial, sans-serif';
const searchBoxStyles = 'width: 500px; border-radius: 24px; border: 1px solid #dfe1e5; padding: 12px 24px; margin: 16px 0; box-shadow: 0 1px 6px rgba(32,33,36,.28)';
const statusTextStyles = 'color: #4285f4; font-size: 14px';
const urlTextStyles = 'color: #202124; font-size: 14px';
const buttonStyles = 'background: #f8f9fa; border: 1px solid #f8f9fa; border-radius: 4px; color: #3c4043; padding: 8px 16px; margin-top: 16px; cursor: pointer';
const readerStyles = 'max-width: 680px; margin: 0 auto; line-height: 1.6; font-size: 18px';

export const importer = behavior({
  defaultUrl: select({ self: $.self })
    .not(q => q.match($.self, "url", $._))
    .assert(({ self }) => [self, 'url', 'https://bf.wtf'])
    .commit(),

  form: select({ self: $.self, url: $.url })
    .match($.self, "url", $.url)
    .not(q => q.match($.self, IMPORT_REQUEST, $._))
    .render(({ self, url }) => (
      <div title="Fetcher Form" style={containerStyles}>
        <common-input value={url} oncommon-input="~/on/change-url" style={searchBoxStyles} />
        <button onclick="~/on/send-request" style={buttonStyles}>Fetch</button>
      </div>
    )).commit(),

  onSendRequest: select({ self: $.self, event: $.event, url: $.url })
    .match($.self, "~/on/send-request", $.event)
    .match($.self, "url", $.url)
    .update(({ self, url }: { self: Reference, url: string }) => {
      return [
        fetch(
          self,
          IMPORT_REQUEST,
          new Request(getMarkdown(url), {
            method: "GET",
            headers: {
              "Content-Type": "application/json",
            },
          }),
        ).text(),
      ];
    }).commit(),

  inFlight: select({ self: $.self, request: $.request, status: $.status, url: $.url })
    .match($.self, IMPORT_REQUEST, $.request)
    .match($.request, REQUEST.STATUS, $.status)
    .match($.self, "url", $.url)
    .not(q => q.match($.request, RESPONSE.TEXT, $._))
    .render(({ self, status, url }) => (
      <div title="Effect Demo" entity={self} style={containerStyles}>
        <div>
          <span style={statusTextStyles}>{status}</span>
          {' - '}
          <i style={urlTextStyles}>{url}</i>
        </div>
        <input type="text" value={url} disabled style={searchBoxStyles} />
        <button onclick="~/on/reset" style={buttonStyles}>Reset</button>
      </div>
    )).commit(),

  showResult: select({ self: $.self, request: $.request, content: $.content })
    .match($.self, IMPORT_REQUEST, $.request)
    .match($.request, RESPONSE.TEXT, $.content)
    .render(({ self, content }) => (
      <div title="Effect Demo" entity={self} style={containerStyles}>
        <button onclick="~/on/reset" style={buttonStyles}>Reset</button>
        <div style={readerStyles}>
          <common-markdown markdown={content} />
          <details>
            <pre>{content}</pre>
          </details>
        </div>
      </div>
    ))
    .commit(),

  onComplete: select({ self: $.self, request: $.request, content: $.content, url: $.url })
    .match($.self, IMPORT_REQUEST, $.request)
    .match($.self, "url", $.url)
    .match($.request, REQUEST.STATUS, 'Complete')
    .match($.request, RESPONSE.TEXT, $.content)
    .update(({ self, content, url }) => {
      const data = { url, content }
      const id = refer(data)
      return [
        { Import: data },
        { Assert: [self, 'clippedItems', id] },
        ...addTag(id, '#import')
      ]
    })
    .commit(),

  onReset: select({ self: $.self, event: $.event, request: $.request })
    .match($.self, "~/on/reset", $.event)
    .match($.self, IMPORT_REQUEST, $.request)
    .update(({ self, request }) => {
      return [{ Retract: [self, IMPORT_REQUEST, request] }];
    })
    .commit(),

  onChangeUrl: select({ self: $.self, event: $.event })
    .match($.self, "~/on/change-url", $.event)
    .upsert(({ self, event }) => {
      // common-input gives us events with easy to read values
      return [self, 'url', Session.resolve<CommonInputEvent>(event).detail.value]
    })
    .commit(),
});

export const spawn = (source: {} = { importer: 1 }) => importer.spawn(source, "Importer");
