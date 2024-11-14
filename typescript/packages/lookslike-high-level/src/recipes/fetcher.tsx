import {
  h,
  behavior,
  $,
  Reference,
  select,
  View,
} from "@commontools/common-system";

import { fetch } from "../effects/fetch.js";

function subview(id: string) {
  return '~/common/ui/' + id
}

export default behavior({
  defaultUrl: select({ self: $.self })
    .not.match($.self, "url", $._)
    .assert(({ self }) => [self, 'url', "https://jsonplaceholder.typicode.com/todos/1"])
    .commit(),

  form: select({ self: $.self, url: $.url })
    .match($.self, "url", $.url)
    // name here is the subview id
    .view(subview('form'), ({ self, url }) => (
      <div>
        <common-input value={url} oncommon-input="~/on/change-url" />
        <button onclick="~/on/send-request">Fetch</button>
      </div>
    )),

  blankState: select({ self: $.self, url: $.url, form: $.form })
    .match($.self, "url", $.url)
    .match($.self, subview('form'), $.form)
    .not.match($.self, "my/request", $._)
    .render(({ self, url, form }) => (
      <div title="Effect Demo" entity={self}>
        {form}
        <h1>Ok</h1>
      </div>
    )),

  onSendRequest: select({ self: $.self, event: $.event, url: $.url })
    .match($.self, "~/on/send-request", $.event)
    .match($.self, "url", $.url)
    .update(({ self, url }: { self: Reference, url: string }) => {
      return [
        fetch(
          self,
          "my/request",
          new Request(url, {
            method: "GET",
            headers: {
              "Content-Type": "application/json",
            },
          }),
        ).json(),
      ];
    }),

  // annoying repetition between states
  pending: select({ self: $.self, request: $.request, status: $.status, url: $.url })
    .match($.self, "my/request", $.request)
    .match($.request, "request/status", $.status)
    .match($.self, "url", $.url)
    .not.match($.request, "response/json", $._)
    .render(({ self, status, url }) => (
      <div title="Effect Demo" entity={self}>
        <h1>Pending</h1>
        {status}
        <button onclick="~/on/reset">Reset</button>
      </div>
    )),

  display: select({ self: $.self, request: $.request, title: $.title, url: $.url })
    .match($.self, "my/request", $.request)
    .match($.request, "response/json", $.content)
    .match($.content, 'title', $.title)
    .match($.self, "url", $.url)
    .render(({ self, title, url }) => (
      <div title="Effect Demo" entity={self}>
        <h1>Response</h1>
        <pre>{title}</pre>
        <button onclick="~/on/reset">Reset</button>
      </div>
    )),

  onReset: select({ self: $.self, event: $.event, request: $.request })
    .match($.self, "~/on/reset", $.event)
    .match($.self, "my/request", $.request)
    .update(({ self, request }) => {
      return [{ Retract: [self, "my/request", request] }];
    }),

  onChangeUrl: select({ self: $.self, event: $.event })
    .match($.self, "~/on/change-url", $.event)
    .upsert(({ self, event }) => {
      // common-input gives us events with easy to read values
      return [self, 'url', event.detail.value]
    })
    .commit(),
});
