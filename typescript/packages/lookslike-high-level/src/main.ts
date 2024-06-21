export { components } from "@commontools/common-ui";
import { CommonWindowManager } from "./components/window-manager.js";
export { components as myComponents } from "./components.js";
import { dataGems, recipes } from "./data.js";
import { home } from "./recipes/home.js";

document.addEventListener("DOMContentLoaded", () => {
  const windowManager = document.getElementById(
    "window-manager"
  )! as CommonWindowManager;
  windowManager.openSaga(home({ sagas: dataGems, recipes }));
});
