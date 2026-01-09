import "core-js/proposals/explicit-resource-management";
import "core-js/proposals/async-explicit-resource-management";
import "@commontools/ui";
import { API_URL, COMMIT_SHA, ENVIRONMENT } from "./lib/env.ts";
import "./components/index.ts";
import "./views/index.ts";
import { App, AppElement, AppUpdateEvent, Navigation } from "../shared/mod.ts";
import "./globals.ts";

console.log(`ENVIRONMENT=${ENVIRONMENT}`);
console.log(`API_URL=${API_URL}`);
console.log(`COMMIT_SHA=${COMMIT_SHA}`);

const root = document.querySelector("x-root-view");
if (!root) throw new Error("No root view found.");
const app = new App(root as unknown as AppElement);
globalThis.app = app;
if (ENVIRONMENT !== "production") {
  app.addEventListener("appupdate", (e) => {
    (e as AppUpdateEvent).prettyPrint();
  });
}
await app.initializeKeys();

const _navigation = new Navigation(app);
