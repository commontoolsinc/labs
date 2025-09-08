import "core-js/proposals/explicit-resource-management";
import "@commontools/ui/v1";
import "@commontools/ui/v2";
import { setLLMUrl } from "@commontools/llm";
import { setRecipeEnvironment } from "@commontools/runner";
import { API_URL, COMMIT_SHA, ENVIRONMENT } from "./lib/env.ts";
import { AppUpdateEvent } from "./lib/app/events.ts";
import { XRootView } from "./views/RootView.ts";
import "./components/index.ts";
import "./views/index.ts";
import { App } from "./lib/app/controller.ts";
import { Navigation } from "./lib/navigate.ts";
import "./globals.ts";

console.log(`ENVIRONMENT=${ENVIRONMENT}`);
console.log(`API_URL=${API_URL}`);
console.log(`COMMIT_SHA=${COMMIT_SHA}`);

// Configure LLM client to use the correct API URL
setLLMUrl(API_URL.toString());

setRecipeEnvironment({ apiUrl: API_URL });

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
