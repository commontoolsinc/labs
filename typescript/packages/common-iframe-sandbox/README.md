# common-iframe-sandbox

This package contains a custom element `<common-iframe-sandbox>`, which enables a sandboxed iframe to execute arbitrary code.

> [!CAUTION]
> This is experimental software and no guarantees of security are provided.
> Continue reading for full details of current status and limitations.

## Usage

`<common-iframe-sandbox>` takes a `src` string of HTML content and a `context` object. The contents in `src` are loaded
inside a sandboxed iframe (via `srcdoc`).

```js
const element = document.createElement('common-iframe-sandbox');
element.src = "<h1>Hello</h1>";
element.context = {};
```

The element has a `context` property that can be set to read, write, or subscribe to a key/value store from the iframe contents.
See the inter-frame communications in [ipc.ts](/typescript/packages/common-iframe-sandbox/src/ipc.ts).

To handle these messages, a global singleton handler is used that must be set via `setIframeContextHandler(handler)`. The handler is called with the `context` provided to the iframe, and the handler determines how values are stored and retrieved.
See [context.ts](/typescript/packages/common-iframe-sandbox/src/context.ts).

## Missing Functionality

* Support updating the `src` property.
* Flushing subscriptions inbetween frame loads.
* Uniquely identify context handler calls so that they can be mapped to the correct iframe instance when there are multiple active sandboxed iframes.
* Support browsers that do not support `HTMLIFrameElement.prototype.csp` (non-chromium).
* Abort on unsupported browsers.
* Further testing.

## Incomplete Security Considerations

* `document.baseURI` is accessible in an iframe, leaking the parent URL
* Currently without CFC, data can be written in the iframe containing other sensitive data,
  or newly synthesized fingerprinting via capabilities (accelerometer, webrtc, canvas),
  and saved back into the database, where some other vector of exfiltration could occur.
* Exposing iframe status to outer content could be considered leaky,
  though all content is inlined, not HTTP URLs.
  https://developer.mozilla.org/en-US/docs/Web/HTML/Element/iframe#error_and_load_event_behavior