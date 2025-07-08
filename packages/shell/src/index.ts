import { API_URL, COMMIT_SHA, ENVIRONMENT } from "./lib/env.ts";
import { AppUpdateEvent } from "./lib/app-update.ts";
import { XRootView } from "./views/RootView.ts";

import "./components/index.ts";
import "./views/index.ts";

console.log(`ENVIRONMENT=${ENVIRONMENT}`);
console.log(`API_URL=${API_URL}`);
console.log(`COMMIT_SHA=${COMMIT_SHA}`);

declare global {
  var app: XRootView;
}

const root = document.querySelector("x-root-view");
if (!root) throw new Error("No root view found.");
const app = root as XRootView;
globalThis.app = app;
if (ENVIRONMENT !== "production") {
  app.addEventListener("appupdate", (e) => {
    (e as AppUpdateEvent).prettyPrint();
  });
}
{
  const location = new URL(globalThis.location.href);
  const match = location.pathname.match(/^\/([^\/]+)\//);
  const spaceName = match && match.length > 1 ? match[1] : "common-knowledge";
  await app.setSpace(spaceName);
}
