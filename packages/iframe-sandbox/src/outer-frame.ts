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
let documentAsked = false;

iframe.addEventListener("load", onInnerLoad);
window.addEventListener("message", onMessage);
window.addEventListener("error", onOuterError);

toHost({ type: "ready" });

function onMessage(e) {
  // Anything the guest posts here is forwarded without being read. It has a
  // port for everything the key/value protocol says, so this route carries
  // only a guest reporting that it could not use that port.
  if (e.source === INNER_WINDOW) {
    toHost({ type: "guest-error", data: e.data });
    return;
  }

  if (e.source !== HOST_WINDOW || e.origin !== HOST_ORIGIN) {
    return;
  }

  if (e.data && e.data.type === "load-document") {
    documentAsked = true;
    iframe.srcdoc = e.data.data;
  }
}

function onInnerLoad(e) {
  // The frame fires this for the empty document it starts on, before there is
  // a guest at all. Reporting that one would announce a load the host never
  // asked for and offer a port to nothing, so the first document the host asks
  // for is where this starts counting.
  if (!documentAsked) {
    return;
  }
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

	<\/script>
<\/body>
<\/html>
<\/html>
`;
