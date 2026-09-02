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
<script>
const HOST_ORIGIN = "${HOST_ORIGIN}";
const HOST_WINDOW = window.parent;
// The frame holding the guest, once the host has asked for a document. Each
// document gets a frame of its own; see \`loadDocument()\`.
let inner = null;

window.addEventListener("message", onMessage);
window.addEventListener("error", onOuterError);

toHost({ type: "ready" });

function onMessage(e) {
  // Anything the guest posts here is forwarded without being read. It has a
  // port for every capability operation, so this route carries
  // only a guest reporting that it could not use that port.
  if (inner && e.source === inner.contentWindow) {
    toHost({ type: "guest-error", data: e.data });
    return;
  }

  if (e.source !== HOST_WINDOW || e.origin !== HOST_ORIGIN) {
    return;
  }

  if (e.data && e.data.type === "load-document") {
    loadDocument(e.data.data);
  }
}

// Loads \`html\` as the guest, in a fresh frame that replaces the one before
// it. Removing a frame discards its browsing context, and with it any load
// still in flight, so the document that ends up loaded is the one asked for
// last however closely the requests follow one another. A frame given two
// \`srcdoc\`s within a few milliseconds does not promise that: Chrome 152
// commits the first document and drops the second.
function loadDocument(html) {
  if (inner) {
    inner.remove();
  }
  inner = document.createElement("iframe");
  inner.setAttribute("allow", "clipboard-write");
  inner.setAttribute(
    "sandbox",
    "allow-popups allow-popups-to-escape-sandbox allow-scripts allow-modals",
  );
  inner.addEventListener("load", onInnerLoad);
  inner.srcdoc = html;
  document.body.appendChild(inner);
}

function onInnerLoad() {
  // The host takes this as its cue to hand the new document a port: a fresh
  // document is a fresh realm, and the port the previous one held died with
  // it.
  toHost({ type: "load" });
}

function onOuterError({ message, filename, lineno, colno, error }) {
  // Not all browsers can directly send the \`ErrorEvent\` object, and the one
  // named \`error\` does not survive the crossing with its class, so what goes
  // is what reads back.
  toHost({ type: "outer-error", data: {
    message,
    filename,
    lineno,
    colno,
    error: error && error.stack ? error.stack : String(error),
  }})
}

function toHost(data) {
  HOST_WINDOW.postMessage(data, HOST_ORIGIN);
}

\t<\/script>
<\/body>
<\/html>
<\/html>
`;
