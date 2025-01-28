import { waitForEvent, invertPromise, setIframeTestHandler, cleanup, render, assertEquals } from "./utils.js";

setIframeTestHandler();

// When CSP is applied to an iframe, the `securitypolicyviolation`
// event is emitted on the iframe's `document`.
// As the host and iframe's do not share origin, and `securitypolicyviolation`
// events occur during load, we have to inject a CSP listener into
// the iframe content for these its.
// Outside of its/in app, we *may* want to inject this, though
// content may still work with some imports (e.g. styles/images) failing.
// If so, we may want to add a new post message "event" in addition
// to the not-very-CSP-compatible "error" event.
const CSP_REPORTER = `
<script>
document.addEventListener('securitypolicyviolation', e => {
  window.parent.postMessage({
    type: 'error',
    data: {
      description: e.violatedDirective,
      source: e.sourceFile,
      lineno: 0,
      colno: 0,
      stacktrace: "",
    }
  }, '*');
});
</script>
`;

const HTML_URL = "https://common.tools";
const SCRIPT_URL = "https://common.tools/static/sketch.js";
const STYLE_URL = "https://common.tools/static/main.css";
const IMG_URL = "https://common.tools/static/text.png";
const ORIGIN_URL = new URL(window.location.href).origin;

describe("common-iframe CSP", () => {
  afterEach(cleanup);

  const cases = [[
    "allows inline script",
    `<script>console.log("foo")</script><style>* { background-color: red; }</style><div>foo</div>`,
    null
  ], [
    "allows self resources",
    `<script>fetch("${ORIGIN_URL}/foo.js")</script>`,
    null,
  ], [
    "disallows 3P JS elements",
    `<script src="${SCRIPT_URL}"></script>`,
    "script-src-elem",
  ], [
    "disallows 3P CSS elements",
    `<link rel="stylesheet" href="${STYLE_URL}">`,
    "style-src-elem",
  ], [
    "disallows 3P CSS imports",
    `<style>@import url("${STYLE_URL}") print;</style>`,
    "style-src-elem",
  ], [
    "disallows 3P images in styles",
    `<style>* { background-image: url("${IMG_URL}"); }</style>`,
    "img-src",
  ], [
    "disallows 3P images in elements",
    `<img src="${IMG_URL}" />`,
    "img-src",
  ], [
    "disallows fetch",
    `<script>fetch("${SCRIPT_URL}");</script>`,
    "connect-src",
  ]];

  // These tests do not report correctly.
  const falseNegatives = [
    [ // An error isn't fired in the test here, but does correctly
      // prevents iframe rendering in practice
      "disallows iframes",
      `<iframe src="${HTML_URL}"></iframe>`,
      "frame-src",
    ]];

  for (let [name, html, expected] of cases) {
    it(name, async () => {
      const body = `
        ${CSP_REPORTER}
        ${html}
      `;
      const iframe = await render(body);
      if (expected == null) {
        await invertPromise(waitForEvent(iframe, "error"));
      } else {
        let event = await waitForEvent(iframe, "error");
        assertEquals(event.detail.description, expected);
      }
    });
  }
});