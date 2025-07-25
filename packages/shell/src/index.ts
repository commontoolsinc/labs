import "core-js/proposals/explicit-resource-management";
import "@commontools/ui/v1";
import "@commontools/ui/v2";
import {
  API_URL,
  COMMIT_SHA,
  ENVIRONMENT,
  USE_SHELL_PREFIX,
} from "./lib/env.ts";
import { AppUpdateEvent } from "./lib/app/events.ts";
import { XRootView } from "./views/RootView.ts";
import "./components/index.ts";
import "./views/index.ts";
import { App } from "./lib/app/controller.ts";
import { getNavigationHref } from "./lib/navigate.ts";
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
{
  const location = new URL(globalThis.location.href);
  const segments = location.pathname.split("/");
  segments.shift(); // shift off the pathnames' prefix "/";
  let [spaceName, charmId] = USE_SHELL_PREFIX
    ? [segments[1], segments[2]]
    : [segments[0], segments[1]];
  if (!spaceName) {
    spaceName = "common-knowledge";
    globalThis.history.replaceState(
      {},
      "",
      USE_SHELL_PREFIX ? "/shell/common-knowledge" : "/common-knowledge",
    );
  }
  app.setSpace(spaceName);
  if (charmId) app.setActiveCharmId(charmId);
}

globalThis.addEventListener("navigate-to-charm", (e) => {
  const { spaceName, charmId } = (e as CustomEvent).detail ?? {};
  if (!spaceName) {
    console.warn(`Navigation event missing 'spaceName'.`);
    return;
  }
  if (!charmId) {
    console.warn(`Navigation event missing 'charmId'.`);
    return;
  }
  app.setSpace(spaceName);
  app.setActiveCharmId(charmId);

  // Update the browser URL to reflect the new location
  // (DefaultCharmList should not use this event, it sets activeCharmId directly)
  const href = getNavigationHref(spaceName, charmId);
  globalThis.history.pushState({}, "", href);
});
