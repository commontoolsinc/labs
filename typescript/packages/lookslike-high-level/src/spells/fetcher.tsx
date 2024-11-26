import {
  h,
  behavior,
  $,
  Reference,
  select,
  Session,
} from "@commontools/common-system";

import { fetch, REQUEST, RESPONSE } from "../effects/fetch.js";
import { CommonInputEvent } from "../../../common-ui/lib/components/common-input.js";

const TODO_REQUEST = 'todo/request'

export default behavior({
  defaultUrl: select({ self: $.self })
    .not(q => q.match($.self, "url", $._))
    .assert(({ self }) => [self, 'url', "https://jsonplaceholder.typicode.com/todos/1"])
    .commit(),

  form: select({ self: $.self, url: $.url })
    .match($.self, "url", $.url)
    .not(q => q.match($.self, TODO_REQUEST, $._))
    // name here is the subview id
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
          TODO_REQUEST,
          new Request(url, {
            method: "GET",
            headers: {
              "Content-Type": "application/json",
            },
          }),
        ).json(),
      ];
    }).commit(),

  inFlight: select({ self: $.self, request: $.request, status: $.status, url: $.url })
    .match($.self, TODO_REQUEST, $.request)
    .match($.request, REQUEST.STATUS, $.status)
    .match($.self, "url", $.url)
    .not(q => q.match($.request, RESPONSE.JSON, $._))
    .render(({ self, status, url }) => (
      <div title="Effect Demo" entity={self}>
        <h1>{status} - <i>{url}</i></h1>
        <button onclick="~/on/reset">Reset</button>
      </div>
    )).commit(),

  showResult: select({ self: $.self, request: $.request, content: $.content, title: $.title })
    .match($.self, TODO_REQUEST, $.request)
    .match($.request, RESPONSE.JSON, $.content)
    .match($.content, 'title', $.title)
    .render(({ self, title }) => (
      <div title="Effect Demo" entity={self}>
        <h1>Response</h1>
        <pre>{JSON.stringify({ title })}</pre>
        <button onclick="~/on/reset">Reset</button>
      </div>
    ))
    .commit(),

  onReset: select({ self: $.self, event: $.event, request: $.request })
    .match($.self, "~/on/reset", $.event)
    .match($.self, TODO_REQUEST, $.request)
    .update(({ self, request }) => {
      return [{ Retract: [self, TODO_REQUEST, request] }];
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
