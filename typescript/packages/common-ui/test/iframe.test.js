import { IframeIPC } from "../lib/src/index.js";

IframeIPC.setIframeContextHandler({
  read(_context, _key) { },
  write(_context, _key, _value) {
  },
  subscribe(_context, _key, _callback) {
    return {};
  },
  unsubscribe(_context, _receipt) {
  }
});

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

const FIXTURE_ID = "common-iframe-csp-fixture-container";

function assertEquals(a, b) {
  if (a !== b) {
    throw new Error(`${a} does not equal ${b}.`);
  }
}

function render(src) {
  return new Promise(resolve => {
    const parent = document.createElement('div');
    parent.id = FIXTURE_ID;
    const iframe = document.createElement('common-iframe');
    iframe.context = {};
    iframe.addEventListener('load', e => {
      resolve(iframe);
    })
    parent.appendChild(iframe);
    document.body.appendChild(parent);
    iframe.src = src;
  });
}

function invertPromise(promise) {
  return new Promise((resolve, reject) => promise.then(reject, resolve))
}

function waitForEvent(element, eventName, timeout = 1000) {
  return new Promise((resolve, reject) => {
    let timer = setTimeout(() => {
      reject(`Timeout reached waiting for ${eventName}`)
    }, timeout);
    element.addEventListener(eventName, e => {
      clearTimeout(timer);
      resolve(e);
    }, { once: true });
  });
}

describe("common-iframe", () => {
  afterEach(() => {
    const parent = document.querySelector(`#${FIXTURE_ID}`);
    document.body.removeChild(parent);
  });

  it('works without 3P resources', async () => {
    const body = `
    ${CSP_REPORTER}
    <div>foo</div>
    `;
    const iframe = await render(body);
    await invertPromise(waitForEvent(iframe, "error"));
  });

  it('disallows 3P JS', async () => {
    const body = `
    ${CSP_REPORTER}
    <script src="https://ajax.googleapis.com/ajax/libs/threejs/r84/three.min.js"></script>
    `;
    const iframe = await render(body);
    let event = await waitForEvent(iframe, "error");
    assertEquals(event.detail.description, "script-src-elem");
  });
})