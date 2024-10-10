export { components } from "@commontools/common-ui";
import { run, CellImpl } from "@commontools/common-runner";
import { CommonWindowManager } from "./components/window-manager.js";
export { components as myComponents } from "./components.js";
import { charms, recipes, openCharm, type Charm } from "./data.js";
import { home } from "./recipes/home.js";

document.addEventListener("DOMContentLoaded", () => {
  const windowManager = document.getElementById(
    "window-manager"
  )! as CommonWindowManager;
  openCharm.set(windowManager.openCharm.bind(windowManager));
  const homeCharm = run(home, { charms, recipes }) as CellImpl<Charm>;
  windowManager.openCharm(homeCharm.entityId!);
});
