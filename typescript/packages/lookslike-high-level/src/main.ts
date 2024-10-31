import "../../common-os-ui/src/static/main.css";
export { components } from "@commontools/common-ui";
export { fab } from "@commontools/common-os-ui";
import { setDebug } from "@commontools/common-html";
import { CommonWindowManager } from "./components/window-manager.js";
export { components as myComponents } from "./components.js";
import { openCharm } from "./data.js";
import "./router.js";

setDebug(!!(import.meta as any).env.VITE_DEBUG);

document.addEventListener("DOMContentLoaded", () => {
  const windowManager = document.getElementById(
    "window-manager",
  )! as CommonWindowManager;
  openCharm.set(windowManager.openCharm.bind(windowManager));
});
