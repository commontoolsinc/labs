# common-iframe-sandbox

This package contains a custom element `<common-iframe-sandbox>`, which enables a sandboxed iframe to execute arbitrary code.

> [!CAUTION]
> This is incomplete, experimental software and no guarantees of security are provided. Continue reading for full details of current status and limitations.

## Goals

To run untrusted code within an iframe, with the ability to communicate with host to read, write, and subscribe to values in a key value store, not allowing code to communicate with any external third party.

> [!CAUTION]
> During experimental development, there are intentional gaps in the sandboxing to enable product features where data within the sandbox may be exfiltrated.

## Usage

`<common-iframe-sandbox>` takes a `src` string of HTML content and a `context` object. The contents in `src` are loaded inside a sandboxed iframe (via `srcdoc`).

```js
const element = document.createElement("common-iframe-sandbox");
element.src = "<h1>Hello</h1>";
element.context = {};
```

The element has a `context` property that can be set to read, write, or subscribe to a key/value store from the iframe contents. See the inter-frame communications in [ipc.ts](/common-iframe-sandbox/src/ipc.ts).

To handle these messages, a global singleton handler is used that must be set via `setIframeContextHandler(handler)`. The handler is called with the `context` provided to the iframe, and the handler determines how values are stored and retrieved. See [context.ts](/common-iframe-sandbox/src/context.ts).

## How it works

`common-iframe-sandbox` is a [Lit] element that manages rendering content in an iframe, using [CSP]. Due to [inconsistent HTMLIFrameElement.prototype.csp support](https://caniuse.com/mdn-html_elements_iframe_csp), we take the approach of each untrusted iframe running inside [another iframe](/common-iframe-sandbox/src/outer-frame.ts). Setting contents via `srcdoc` on the iframes, this approach allows us to set CSP in the outer frame that propagates to the inner (untrusted) frame across browsers.

> Whenever a user agent creates an iframe srcdoc document in a browsing context nested in the protected resource, if the user agent is enforcing any policies for the protected resource, the user agent MUST enforce those policies on the iframe srcdoc document as well. - [CSP Spec](https://www.w3.org/TR/CSP2/#processing-model-iframe-srcdoc)

## Missing Functionality

- Audit the IPC communication (`postMessage()`) with origin-bounds and ensure other frames can't spoof messages.
- Abort on unsupported browsers.
- Further testing.

## Incomplete Security Considerations

Some of these are shortcomings of implementation, and some are intentional product decisisons during experimentation.

- Hardcoded CDNs (and their logging services) are an exfiltration vector.
- Allowing anchor elements with `target="_blank"` is an exfiltration vector.
- `document.baseURI` is accessible in an iframe, leaking the parent URL
- Currently without CFC, data can be written in the iframe containing other sensitive data, or newly synthesized fingerprinting via capabilities (accelerometer, webrtc, canvas), and saved back into the database, where some other vector of exfiltration could occur.
- Exposing iframe status to outer content could be considered leaky, though all content is inlined, not HTTP URLs. https://developer.mozilla.org/en-US/docs/Web/HTML/Element/iframe#error_and_load_event_behavior

[Lit]: https://lit.dev/
[CSP]: https://developer.mozilla.org/en-US/docs/Web/HTTP/CSP
