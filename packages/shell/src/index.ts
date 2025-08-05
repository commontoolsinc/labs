import "core-js/proposals/explicit-resource-management";
import "@commontools/ui/v1";
import "@commontools/ui/v2";
import { API_URL, COMMIT_SHA, ENVIRONMENT } from "./lib/env.ts";
import { AppUpdateEvent } from "./lib/app/events.ts";
import { XRootView } from "./views/RootView.ts";
import "./components/index.ts";
import "./views/index.ts";
import { App } from "./lib/app/controller.ts";
import "./globals.ts";
console.log(`ENVIRONMENT=${ENVIRONMENT}`);
console.log(`API_URL=${API_URL}`);
console.log(`COMMIT_SHA=${COMMIT_SHA}`);

const root = document.querySelector("x-root-view");
if (!root) throw new Error("No root view found.");
const app = new App(root as XRootView);
globalThis.app = app;
if (ENVIRONMENT !== "production") {
  app.addEventListener("appupdate", (e) => {
    (e as AppUpdateEvent).prettyPrint();
  });
}
await app.initializeKeys();

const navigation = new Navigation(app);
