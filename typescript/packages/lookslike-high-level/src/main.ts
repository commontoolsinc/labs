export { components } from "@commontools/common-ui";
import { CommonWindowManager } from "./components/window-manager.js";
export { components as myComponents } from "./components.js";
import { getGemByName } from "./data.js";

document.addEventListener("DOMContentLoaded", () => {
  const windowManager = document.getElementById(
    "window-manager"
  )! as CommonWindowManager;
  console.log(getGemByName("home"));
  windowManager.openSaga(getGemByName("home")!);
});
