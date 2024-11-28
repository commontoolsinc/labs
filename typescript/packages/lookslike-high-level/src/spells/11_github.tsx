import {
  h,
  behavior,
  $,
  Reference,
  select,
  Session,
  refer,
} from "@commontools/common-system";

import { fetch, REQUEST, RESPONSE } from "../effects/fetch.js";
import { CommonInputEvent } from "../../../common-ui/lib/components/common-input.js";
import { addTag } from "../sugar/tags.js";

const IMPORT_REQUEST = 'import/request'

const getCommits =
  (url: string) => `https://api.github.com/repos${new URL(url).pathname}/commits?per_page=50`

export default behavior({
  defaultUrl: select({ self: $.self })
    .not(q => q.match($.self, "url", $._))
    .assert(({ self }) => [self, 'url', 'https://github.com/user/repo'])
    .commit(),

  form: select({ self: $.self, url: $.url })
    .match($.self, "url", $.url)
    .not(q => q.match($.self, IMPORT_REQUEST, $._))
    .render(({ self, url }) => (
      <div title="Github Commits Fetcher">
        <common-input value={url} oncommon-input="~/on/change-url" />
        <button onclick="~/on/send-request">Fetch Commits</button>
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
          new Request(getCommits(url), {
            method: "GET",
            headers: {
              "Accept": "application/vnd.github.v3+json",
              "Content-Type": "application/json",
            },
          }),
        ).json(),
      ];
    }).commit(),

  inFlight: select({ self: $.self, request: $.request, status: $.status, url: $.url })
    .match($.self, IMPORT_REQUEST, $.request)
    .match($.request, REQUEST.STATUS, $.status)
    .match($.self, "url", $.url)
    .not(q => q.match($.request, RESPONSE.JSON, $._))
    .render(({ self, status, url }) => (
      <div title="Github Commits" entity={self}>
        <h1>{status} - Fetching commits from <i>{url}</i></h1>
        <button onclick="~/on/reset">Reset</button>
      </div>
    )).commit(),

  showResult: select({ self: $.self, request: $.request, content: $.content })
    .match($.self, IMPORT_REQUEST, $.request)
    .match($.request, RESPONSE.JSON, $.content)
    .render(({ self, content }) => (
      <div title="Github Commits" entity={self}>
        <h1>Commit History</h1>
        <pre>{JSON.stringify(content)}</pre>
        <button onclick="~/on/reset">Reset</button>
      </div>
    ))
    .commit(),

  onComplete: select({ self: $.self, request: $.request, content: $.content })
    .match($.self, IMPORT_REQUEST, $.request)
    .match($.request, REQUEST.STATUS, 'Complete')
    .match($.request, RESPONSE.JSON, $.content)
    .update(({ self, content }) => {
      return [
        ...addTag(content, '#github-commits')
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
