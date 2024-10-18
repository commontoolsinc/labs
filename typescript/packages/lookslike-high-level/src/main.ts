import "../../common-os-ui/src/static/main.css";
export { components } from "@commontools/common-ui";
export { fab } from "@commontools/common-os-ui";
import { run, CellImpl } from "@commontools/common-runner";
import { CommonWindowManager } from "./components/window-manager.js";
export { components as myComponents } from "./components.js";
import { charms, recipes, openCharm, type Charm } from "./data.js";
import { home } from "./recipes/home.js";
import "./router.js";
import { search } from "./recipes/search.js";

document.addEventListener("DOMContentLoaded", () => {
  const windowManager = document.getElementById(
    "window-manager",
  )! as CommonWindowManager;
  openCharm.set(windowManager.openCharm.bind(windowManager));
  const feedCharm = run(search, { search: "inbox" }) as CellImpl<Charm>;
  windowManager.openCharm(JSON.stringify(feedCharm.entityId));
});
