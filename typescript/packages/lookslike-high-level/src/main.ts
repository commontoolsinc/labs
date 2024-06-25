export { components } from "@commontools/common-ui";
import { CommonWindowManager } from "./components/window-manager.js";
export { components as myComponents } from "./components.js";
import { dataGems, recipes, openSaga } from "./data.js";
import { home } from "./recipes/home.js";

document.addEventListener("DOMContentLoaded", () => {
  const windowManager = document.getElementById(
    "window-manager"
  )! as CommonWindowManager;
  openSaga.set(windowManager.openSaga.bind(windowManager));
  windowManager.openSaga(home({ sagas: dataGems, recipes }));
});
