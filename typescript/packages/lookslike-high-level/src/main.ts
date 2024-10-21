import "../../common-os-ui/src/static/main.css";
export { components } from "@commontools/common-ui";
export { fab } from "@commontools/common-os-ui";
import { CommonWindowManager } from "./components/window-manager.js";
export { components as myComponents } from "./components.js";
import { openCharm, runPersistent } from "./data.js";
import "./router.js";
import { search } from "./recipes/search.js";

document.addEventListener("DOMContentLoaded", () => {
  const windowManager = document.getElementById(
    "window-manager"
  )! as CommonWindowManager;
  openCharm.set(windowManager.openCharm.bind(windowManager));
  runPersistent(search, { search: "inbox" }, "search").then((feedCharm) => {
    windowManager.openCharm(JSON.stringify(feedCharm.entityId));
  });
});
