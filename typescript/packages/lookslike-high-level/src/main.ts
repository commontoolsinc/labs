export { components } from "@commontools/common-ui";
export { fab } from "@commontools/common-os-ui";
import { CommonWindowManager } from "./components/window-manager.js";
export { components as myComponents } from "./components.js";
import { charms, recipes, openCharm, runPersistent } from "./data.js";
import { home } from "./recipes/home.js";
import "../../common-os-ui/src/static/main.css";

document.addEventListener("DOMContentLoaded", () => {
  const windowManager = document.getElementById(
    "window-manager"
  )! as CommonWindowManager;
  openCharm.set(windowManager.openCharm.bind(windowManager));
  runPersistent(home, { charms, recipes }, "home").then((homeCharm) => {
    windowManager.openCharm(JSON.stringify(homeCharm.entityId));
  });
});
