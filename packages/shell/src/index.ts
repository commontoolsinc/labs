import "@commontools/ui/v2";
import { API_URL, COMMIT_SHA, ENVIRONMENT } from "./lib/env.ts";
import { AppUpdateEvent } from "./lib/app/events.ts";
import { XRootView } from "./views/RootView.ts";
import "./components/index.ts";
import "./views/index.ts";
import { AppController } from "./lib/app/controller.ts";

console.log(`ENVIRONMENT=${ENVIRONMENT}`);
console.log(`API_URL=${API_URL}`);
console.log(`COMMIT_SHA=${COMMIT_SHA}`);

declare global {
  var app: AppController;
}

const root = document.querySelector("x-root-view");
if (!root) throw new Error("No root view found.");
const app = new AppController(root as XRootView);
globalThis.app = app;
if (ENVIRONMENT !== "production") {
  app.addEventListener("appupdate", (e) => {
    (e as AppUpdateEvent).prettyPrint();
  });
}
{
  const location = new URL(globalThis.location.href);
  const segments = location.pathname.split("/");
  segments.shift(); // shift off the pathnames' prefix "/";
  let [spaceName, charmId] = segments;
  if (!spaceName) {
    spaceName = "common-knowledge";
    globalThis.history.replaceState({}, "", "/common-knowledge");
  }
  app.setSpace(spaceName);
  if (charmId) app.setActiveCharmId(charmId);
}
