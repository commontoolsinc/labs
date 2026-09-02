// deno-coverage-ignore-file -- runs only in a browser, as text inlined into a document.
// @ts-check

/**
 * The outer frame's own script: it loads each document the host asks for into
 * the inner frame, reports each such load back to the host, and forwards what
 * the guest posts outside its port. Plain JavaScript, because the browser runs
 * this text as it stands: `outer-frame.ts` inlines it into the document it
 * assembles, on a `<script>` element whose `data-host-origin` attribute
 * carries the host's origin.
 */

const HOST_ORIGIN = hostOrigin();
const HOST_WINDOW = globalThis.parent;
const iframe = /** @type {HTMLIFrameElement} */ (
  document.querySelector("iframe")
);
const INNER_WINDOW = iframe.contentWindow;
let documentAsked = false;

iframe.addEventListener("load", onInnerLoad);
globalThis.addEventListener("message", onMessage);
globalThis.addEventListener("error", onOuterError);

toHost({ type: "ready" });

/**
 * Handles a message from either neighbor: the guest below or the host above.
 *
 * @param {MessageEvent} e
 */
function onMessage(e) {
  // Anything the guest posts here is forwarded without being read. It has a
  // port for every capability operation, so this route carries only a guest
  // reporting that it could not use that port.
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

/** Handles the inner frame's document having loaded. */
function onInnerLoad() {
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

/**
 * Reports an error raised in this frame to the host.
 *
 * @param {ErrorEvent} event
 */
function onOuterError({ message, filename, lineno, colno, error }) {
  // Not all browsers can directly send the `ErrorEvent` object, and the one
  // named `error` does not survive the crossing with its class, so what goes
  // is what reads back.
  toHost({
    type: "outer-error",
    data: {
      message,
      filename,
      lineno,
      colno,
      error: error && error.stack ? error.stack : String(error),
    },
  });
}

/**
 * Returns the host's origin, which the assembly places on this script's
 * element.
 *
 * @returns {string}
 */
function hostOrigin() {
  const origin = document.currentScript?.dataset.hostOrigin;
  if (!origin) {
    throw new Error("The outer frame's script needs `data-host-origin`.");
  }
  return origin;
}

/**
 * Posts `data` to the host.
 *
 * @param {unknown} data
 */
function toHost(data) {
  HOST_WINDOW.postMessage(data, HOST_ORIGIN);
}
