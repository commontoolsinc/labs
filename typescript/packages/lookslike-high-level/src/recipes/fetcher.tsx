import {
  h,
  behavior,
  $,
  Reference,
  select,
  View,
} from "@commontools/common-system";

import { fetch } from "../effects/fetch.js";

export default behavior({
  request: select({ self: $.self })
    .not.match($.self, "~/request", $._)
    .update(({ self }: { self: Reference }) => {
      return [
        fetch(
          self,
          "my/request",
          new Request("http://localhost:5173/test", {
            method: "GET",
            headers: {
              "Content-Type": "application/json",
            },
          }),
        ).text(),
      ];
    }),
  blank: select({ self: $.self })
    .not.match($.self, "my/request", $._)
    .render(({ self }) => (
      <div title="Effect Demo" entity={self}>
        Request Pending
      </div>
    )),

  pending: select({ self: $.self, request: $.request, status: $.status })
    .match($.self, "my/request", $.request)
    .match($.request, "request/status", $.status)
    .not.match($.request, "response/text", $._)
    .render(({ self, status }) => (
      <div title="Effect Demo" entity={self}>
        {status}
      </div>
    )),
  display: select({ self: $.self, request: $.request, text: $.text })
    .match($.self, "my/request", $.request)
    .match($.request, "response/text", $.text)
    .render(({ self, text }) => (
      <div title="Effect Demo" entity={self}>
        <p>Response</p>
        <pre>{text}</pre>
      </div>
    )),
});
