import "core-js/proposals/explicit-resource-management";
import "core-js/proposals/async-explicit-resource-management";
import "@commonfabric/ui";
import { API_URL, COMMIT_SHA, ENVIRONMENT } from "./lib/env.ts";
import { setupHostToggles } from "./lib/host-toggles.ts";
import { consumeDeviceLinkFragment } from "./lib/device-link.ts";
// Statically imported, deliberately. A dynamic `await import()` here pushes
// `shared/app/*` into esbuild's lazy `__esm` wrappers, and esbuild then emits
// the wrapper for `shared/app/controller.ts` as a NON-async function containing
// a top-level await — a bundle that is a SyntaxError, so the whole shell fails
// to load. (`node --check dist/scripts/index.js` catches it; the type checker
// and the unit tests do not.) There was nothing to gain either way: the shell's
// `index` entry sets `splitting: false`, so esbuild inlines dynamic imports
// rather than emitting a chunk.
import { handleDeviceLink } from "./lib/device-link-login.ts";
import "./components/index.ts";
import "./views/index.ts";
import { App, AppElement, AppUpdateEvent, Navigation } from "../shared/mod.ts";
import "./globals.ts";

// Device-link login: /#k=<base64url 32-byte BIP39 entropy>.
// Read and scrubbed FIRST, synchronously, before any await — so the secret
// never survives into session history, a bookmark, or iCloud tab sync.
// Interim pre-key-delegation pairing flow; delete when delegation lands.
const deviceLink = consumeDeviceLinkFragment();

// Handle a scan while the app is ALREADY loaded at the QR's target URL. The QR
// deliberately points at the page the user bookmarked as mobile Loom, so
// re-scanning it is a same-document fragment navigation: no reload fires, the
// module-eval read above never re-runs, and the secret would sit unscrubbed in
// the address bar. `hashchange` is the only signal for that case. On an
// accepted REPLACE the running app still holds the old identity, so reload to
// re-bootstrap cleanly (the fragment is already scrubbed, so the reload is
// clean and cannot loop).
globalThis.addEventListener("hashchange", () => {
  const rescan = consumeDeviceLinkFragment();
  if (rescan.kind === "absent") return;
  void handleDeviceLink(rescan, { reloadOnReplace: true });
});

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js");
}

console.log(`ENVIRONMENT=${ENVIRONMENT}`);
console.log(`API_URL=${API_URL}`);
console.log(`COMMIT_SHA=${COMMIT_SHA}`);
setupHostToggles();

const root = document.querySelector("x-root-view");
if (!root) throw new Error("No root view found.");
const app = new App(root as unknown as AppElement);
globalThis.app = app;
if (ENVIRONMENT !== "production") {
  app.addEventListener("appupdate", (e) => {
    (e as AppUpdateEvent).prettyPrint();
  });
}
// Runs BEFORE initializeKeys: handleDeviceLink writes ROOT_KEY straight into
// the KeyStore so the normal boot below picks the new identity up. Routing it
// through App.setIdentity instead would throw whenever a DIFFERENT identity is
// already active — precisely the re-pair case this exists for. It never throws,
// so a failed pairing degrades to a normal boot rather than skipping
// initializeKeys and Navigation entirely.
if (deviceLink.kind !== "absent") {
  await handleDeviceLink(deviceLink);
}

await app.initializeKeys();

const _navigation = new Navigation(app);
