import { h, behavior, $, Reference, select, Session, refer } from "@commontools/common-system";
import { fetch, REQUEST, RESPONSE } from "../effects/fetch.js";
import { CommonInputEvent } from "../../../common-ui/lib/components/common-input.js";
import { addTag, event, Transact } from "../sugar.js";
import { Likeable, LikeButton, resolveLikes } from "./stickers/like.jsx";
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

const resolveArticle = select({ url: $.url, content: $.content })
  .match($.self, 'url', $.url)
  .match($.self, 'content', $.content)

export const articlePreview = behavior({
  ...mixin(Likeable),

  view: resolveArticle
    .with(resolveLikes)
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

const resolveUrl = select({ self: $.self, url: $.url }).match($.self, "url", $.url)
const resolveRequest = select({ self: $.self, request: $.request, status: $.status })
  .match($.self, IMPORT_REQUEST, $.request)
  .match($.request, REQUEST.STATUS, $.status)
const resolveRequestContent = select({ content: $.content })
  .match($.request, RESPONSE.TEXT, $.content)

function importRequest(url: string, content: string) {
  const data = { url, content }
  const id = refer(data)
  return {
    id, changes: [
      { Import: data }
    ]
  }
}

export const importer = behavior({
  defaultUrl: select({ self: $.self })
    .not(q => q.match($.self, "url", $._))
    .update(({ self }) => Transact.assert(self, { url: 'https://bf.wtf' }))
    .commit(),

  viewForm: resolveUrl
    .not(q => q.match($.self, IMPORT_REQUEST, $._))
    .render(({ self, url }) => (
      <div entity={self} title="Fetcher Form" style={containerStyles}>
        <common-input value={url} oncommon-blur="~/on/change-url" style={searchBoxStyles} />
        <button onclick="~/on/send-request" style={buttonStyles}>Fetch</button>
      </div>
    )).commit(),

  onSendRequest: event('~/on/send-request')
    .with(resolveUrl)
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

  viewInFlight: resolveRequest.with(resolveUrl)
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

  viewResult: resolveRequest
    .with(resolveRequestContent)
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

  onComplete: resolveRequest
    .with(resolveUrl)
    .with(resolveRequestContent)
    .match($.request, REQUEST.STATUS, 'Complete')
    .update(({ self, content, url }) => {
      const { changes, id } = importRequest(url, content)
      return [
        ...changes,
        ...Transact.assert(self, { clippedItems: id }),
        ...addTag(id, '#import')
      ]
    })
    .commit(),

  onReset: event('~/on/reset')
    .with(resolveRequest)
    .update(({ self, request }) => {
      return Transact.remove(self, {
        [IMPORT_REQUEST]: request
      })
    })
    .commit(),

  onChangeUrl: event('~/on/change-url')
    .update(({ self, event }) => {
      return Transact.set(self, {
        url: Session.resolve<CommonInputEvent>(event).detail.value
      })
    })
    .commit(),
});

export const spawn = (source: {} = { importer: 1 }) => importer.spawn(source, "Importer");
