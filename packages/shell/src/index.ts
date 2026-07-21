import "core-js/proposals/explicit-resource-management";
import "core-js/proposals/async-explicit-resource-management";
import "@commonfabric/ui";
import { API_URL, COMMIT_SHA, ENVIRONMENT } from "./lib/env.ts";
import { setupHostToggles } from "./lib/host-toggles.ts";
import { consumeDeviceLinkFragment } from "./lib/device-link.ts";
import "./components/index.ts";
import "./views/index.ts";
import { App, AppElement, AppUpdateEvent, Navigation } from "../shared/mod.ts";
import "./globals.ts";

// Device-link login: /#k=<base64url 32-byte BIP39 entropy>.
// Read and scrubbed FIRST, synchronously, before any await — so the secret
// never survives into session history, a bookmark, or iCloud tab sync.
// Interim pre-key-delegation pairing flow; delete when delegation lands.
const deviceLinkEntropy = consumeDeviceLinkFragment();

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
// Must run BEFORE initializeKeys: it writes ROOT_KEY straight into the
// KeyStore so the normal boot below picks the new identity up. Routing it
// through App.setIdentity instead would throw whenever a DIFFERENT identity is
// already active — which is precisely the re-pair case this exists for.
if (deviceLinkEntropy) {
  const { runDeviceLinkLogin } = await import("./lib/device-link-login.ts");
  await runDeviceLinkLogin(deviceLinkEntropy);
}

await app.initializeKeys();

const _navigation = new Navigation(app);
