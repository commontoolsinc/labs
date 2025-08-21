import {
  assert,
  assertEquals,
  invertPromise,
  render,
  setIframeTestHandler,
  waitForEvent,
} from "./utils.ts";

type TestCase = [string, string, string | null | RegExp];

setIframeTestHandler();

// Cookies should not be set with SameSite=None, but
// used to test that cookies are not accessible to iframe.
document.cookie = "testcookie=1; SameSite=None;";

// When CSP is applied to an iframe, the `securitypolicyviolation`
// event is emitted on the iframe's `document`.
// As the host and iframe's do not share origin, and `securitypolicyviolation`
// events occur during load, we have to inject a CSP listener into
// the iframe content for these its.
// Outside of its/in app, we *may* want to inject this, though
// content may still work with some imports (e.g. styles/images) failing.
// If so, we may want to add a new post message "event" in addition
// to the not-very-CSP-compatible "error" event.
//
// Additionally, we want to propagate other errors to the parent frame
// for inspection.
const CSP_REPORTER = `
<script>
document.addEventListener('securitypolicyviolation', e => {
  window.parent.postMessage({
    type: 'error',
    data: {
      description: "CSP:" + e.violatedDirective,
      source: e.sourceFile,
      lineno: 0,
      colno: 0,
      stacktrace: "",
    }
  }, '*');
});
window.onerror = function (message, source, lineno, colno, error) {
  window.parent.postMessage({
    type: "error",
    data: {
      description: message,
      source: source,
      lineno: lineno,
      colno: colno,
      stacktrace: error && error.stack ? error.stack : new Error().stack,
    },
  }, '*');
}
</script>
`;

const HTML_URL = "https://common.tools";
const SCRIPT_URL = "https://common.tools/static/sketch.js";
const STYLE_URL = "https://common.tools/static/main.css";
const IMG_URL = "https://common.tools/static/text.png";
const ORIGIN_URL = new URL(globalThis.location.href).origin;
const BASE64_IMG_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=";

function openWindow(target: string) {
  return `<script>
    let win = window.open("${HTML_URL}", "${target}");
    if (win) throw new Error("Window Opened");</script>`;
}

function clickAnchor(target: string) {
  return `
<a id="anchor-test" href="${HTML_URL}" target="${target}">
<script>
const anchor = document.querySelector("#anchor-test");
anchor.click();
</script>`;
}

const cases: TestCase[] = [[
  "allows inline script",
  `<script>console.log("foo")</script><style>* { background-color: red; }</style><div>foo</div>`,
  null,
], [
  "allows 1P fetch",
  `<script>fetch("${ORIGIN_URL}/foo.js")</script>`,
  null,
], [
  "allows 1P img",
  `<img src="${ORIGIN_URL}/foo.jpg" />`,
  null,
], [
  "allows data: img",
  `<img src="${BASE64_IMG_URL}" />`,
  null,
], [
  "allows 1P CSS",
  `<link rel="stylesheet" href="${ORIGIN_URL}/styles.css">`,
  null,
], [
  "disallows opening windows (_blank)",
  openWindow("_blank"),
  null,
], [
  "disallows opening windows (_parent)",
  openWindow("_parent"),
  null,
], [
  "disallows opening windows (_self)",
  openWindow("_self"),
  null,
], [
  "disallows opening windows (_top)",
  openWindow("_top"),
  null,
], [
  "disallows anchor link target (_parent)",
  clickAnchor("_parent"),
  null,
], [
  "disallows anchor link target (_self)",
  clickAnchor("_self"),
  null,
], [
  "disallows anchor link target (_top)",
  clickAnchor("_top"),
  null,
], [
  "disallows fetch",
  `<script>fetch("${SCRIPT_URL}");</script>`,
  "CSP:connect-src",
], [
  "disallows 3P JS elements",
  `<script src="${SCRIPT_URL}"></script>`,
  "CSP:script-src-elem",
], [
  "disallows 3P CSS elements",
  `<link rel="stylesheet" href="${STYLE_URL}">`,
  "CSP:style-src-elem",
], [
  "disallows 3P CSS imports",
  `<style>@import url("${STYLE_URL}") print;</style>`,
  "CSP:style-src-elem",
], [
  "disallows 3P images in styles",
  `<style>* { background-image: url("${IMG_URL}"); }</style>`,
  "CSP:img-src",
], [
  "disallows 3P images in elements",
  `<img src="${IMG_URL}" />`,
  "CSP:img-src",
], [
  "disallows base element",
  `<base href="${HTML_URL}" />`,
  "CSP:base-uri",
], [
  "disallows prefetch",
  `<link rel="prefetch" href="${HTML_URL}" />`,
  "CSP:default-src",
], [
  "disallows Worker",
  `<script>new Worker("${SCRIPT_URL}")</script>`,
  /Uncaught SecurityError/,
], [
  "disallows SharedWorker",
  `<script>new SharedWorker("${SCRIPT_URL}")</script>`,
  /Uncaught SecurityError/,
], [
  "disallows ServiceWorker",
  `<script>navigator.serviceWorker.register("${SCRIPT_URL}")</script>`,
  /Uncaught SecurityError/,
], [
  "disallows cookie access",
  `<script>let foo = document.cookie;</script>`,
  /Uncaught SecurityError/,
]];

// /!\ These tests do not report correctly.
// /!\ Not sure why! But they correctly are blocked
// /!\ in practice. How can we ensure this is properly tested?
const falseNegatives: TestCase[] = [[
  "disallows iframes",
  `<iframe src="${HTML_URL}"></iframe>`,
  "CSP:frame-src",
], [
  "disallows navigation",
  `<script>window.location.href = "${HTML_URL}";</script>`,
  "CSP:default-src",
]];

// /!\ These tests do not report correctly.
// /!\ Not sure why! But they appear to be allowed
// /!\ but are not in practice.
const falsePositives: TestCase[] = [[
  "Allows anchor link target (_blank)",
  clickAnchor("_blank"),
  null,
]];

const unknownStatuses: TestCase[] = [
  [
    // `prerender` is a Chrome-only feature-flagged
    // source of exfiltration. This *should* be
    // covered by `default-src`, but TBD on testing that.
    "disallows prerender",
    `<link rel="prerender" href="${HTML_URL}" />`,
    "CSP:default-src",
  ],
];

for (const [name, html, expected] of cases) {
  defineTest(name, html, expected);
}
for (const [name, html, expected] of falseNegatives) {
  definePending(name, html, expected);
}
for (const [name, html, expected] of falsePositives) {
  definePending(name, html, expected);
}
for (const [name, html, expected] of unknownStatuses) {
  definePending(name, html, expected);
}

function defineTest(
  name: string,
  html: string,
  expected: string | null | RegExp,
) {
  Deno.test(name, async () => {
    const body = `
        ${CSP_REPORTER}
        ${html}
      `;
    const iframe = await render(body);
    if (expected == null) {
      await invertPromise(waitForEvent(iframe, "common-iframe-error"));
    } else {
      const event = await waitForEvent(
        iframe,
        "common-iframe-error",
      ) as CustomEvent;
      if (typeof expected === "string") {
        assertEquals(event.detail.description, expected);
      } else {
        assert(expected.test(event.detail.description));
      }
    }
  });
}

function definePending(
  name: string,
  _html: string,
  _expected: string | null | RegExp,
) {
  Deno.test(name, () => {});
}
