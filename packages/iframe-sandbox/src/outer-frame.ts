import { CSP, HOST_ORIGIN } from "./csp.ts";

export default `
<!DOCTYPE html>
<html>
<head>
<meta http-equiv="Content-Security-Policy" content="${CSP}" \/>
<style>
html, body {
  padding: 0;
  margin: 0;
  height: 100vh;
  overflow: hidden;
  background-color: #ddd;
}

* {
  box-sizing: border-box;
}

iframe {
  padding: 0;
  margin: 0;
  height: 100vh;
  width: 100vw;
  border: none;
}
  <\/style>
<\/head>
<body>
<iframe
  allow="clipboard-write"
  sandbox="allow-popups allow-popups-to-escape-sandbox allow-scripts allow-modals"><\/iframe>
<script>
const iframe = document.querySelector("iframe");
const HOST_ORIGIN = "${HOST_ORIGIN}";
const HOST_WINDOW = window.parent;
const INNER_WINDOW = iframe.contentWindow;
let FRAME_ID = null;

iframe.addEventListener("load", onInnerLoad);
window.addEventListener("message", onMessage);
window.addEventListener("error", onOuterError);

toHost({ type: "ready" });

function onMessage(e) {
  if (!e.data || typeof e.data.type !== "string") {
    return;
  }

  if (e.source === INNER_WINDOW) {
    assertInitialized();
    toHost({
      id: FRAME_ID,
      type: "passthrough",
      data: e.data,
    });
    return;
  }

  if (e.source === HOST_WINDOW && e.origin === HOST_ORIGIN) {
    // Handle initialization, receiving the frame ID.
    if (FRAME_ID == null && e.data.type === "init") {
      FRAME_ID = e.data.id;
      return;
    }

    if (FRAME_ID == null || FRAME_ID !== e.data.id) {
      return;
    }

    switch (e.data.type) {
      case "init": {
        // There shouldn't be a second "init" command.
        return;
      }
      case "load-document": {
        iframe.srcdoc = e.data.data;
        return;
      }
      case "passthrough": {
        toInner(e.data.data);
        return;
      }
    }
  }
}

function onInnerLoad(e) {
  // The iframe can fire its load event before
  // loading the srcdoc contents in some browsers.
  // Ignore, and wait for initialization to occur.
  if (FRAME_ID == null) {
    return;
  }
  toHost({ type: "load", id: FRAME_ID });
}

function onOuterError({ message, filename, lineno, colno, error }) {
  // Not all browsers can directly send the \`ErrorEvent\` object.
  toHost({ type: "error", id: FRAME_ID, data: { message, filename, lineno, colno, error }})
}

function assertInitialized() {
  if (FRAME_ID == null) {
    throw new Error("Expected frame to be assigned an id.");
  }
}

function toHost(data) {
  HOST_WINDOW.postMessage(data, HOST_ORIGIN);
}

function toInner(data) {
  INNER_WINDOW.postMessage(data, "*");
}
	<\/script>
<\/body>
<\/html>
<\/html>
`;
