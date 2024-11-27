import { h, behavior, $, Reference, select, Session, refer } from "@commontools/common-system";
import { fetch, REQUEST, RESPONSE } from "../effects/fetch.js";
import { CommonInputEvent } from "../../../common-ui/lib/components/common-input.js";
import { addTag } from "../sugar.js";

const IMPORT_REQUEST = 'import/request'

const getMarkdown =
  (url: string) => `/api/reader/${url}`

export const articlePreview = behavior({
  defaultLikes: select({ self: $.self })
    .not(q => q.match($.self, 'likes', $._))
    .assert(({ self }) => [self, 'likes', 0])
    .commit(),

  defaultView: select({ self: $.self, url: $.url, content: $.content, likes: $.likes })
    .match($.self, 'url', $.url)
    .match($.self, 'content', $.content)
    .match($.self, 'likes', $.likes)
    .render(({ url, content, likes, self }) => (
      <div style="background: grey; border-radius: 16px; color: white; padding: 16px;">
        <div><a href={url} style="color: darkgrey; font-style: italic; text-decoration: none;">{url}</a></div>
        <div><common-markdown markdown={content.substring(0, 255)} /></div>
        <div>
          Likes: {likes}
          <button onclick="~/on/like">👍</button>
        </div>
      </div>
    ))
    .commit(),

  onLike: select({ self: $.self, event: $.event, likes: $.likes })
    .match($.self, "~/on/like", $.event)
    .match($.self, "likes", $.likes)
    .update(({ self, likes }) => {
      return [
        { Upsert: [self, 'likes', Number(likes) + 1] }
      ];
    })
    .commit(),
})

export const importer = behavior({
  defaultUrl: select({ self: $.self })
    .not(q => q.match($.self, "url", $._))
    .assert(({ self }) => [self, 'url', 'https://bf.wtf'])
    .commit(),

  form: select({ self: $.self, url: $.url })
    .match($.self, "url", $.url)
    .not(q => q.match($.self, IMPORT_REQUEST, $._))
    .render(({ self, url }) => (
      <div title="Fetcher Form">
        <common-input value={url} oncommon-input="~/on/change-url" />
        <button onclick="~/on/send-request">Fetch</button>
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
      <div title="Effect Demo" entity={self}>
        <h1>{status} - <i>{url}</i></h1>
        <button onclick="~/on/reset">Reset</button>
      </div>
    )).commit(),

  showResult: select({ self: $.self, request: $.request, content: $.content })
    .match($.self, IMPORT_REQUEST, $.request)
    .match($.request, RESPONSE.TEXT, $.content)
    .render(({ self, content }) => (
      <div title="Effect Demo" entity={self}>
        <h1>Response</h1>
        <common-markdown markdown={content} />
        <details>
          <pre>{content}</pre>
        </details>
        <button onclick="~/on/reset">Reset</button>
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

export const spawn = (source: {} = { importer: 1 }) => importer.spawn(source);
export const spawn = (source: {} = { importer: 1 }) => importer.spawn(source, "Importer");
