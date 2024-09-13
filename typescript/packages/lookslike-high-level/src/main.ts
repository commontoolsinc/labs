export { components } from "@commontools/common-ui";
import { run, CellImpl } from "@commontools/common-runner";
import { CommonWindowManager } from "./components/window-manager.js";
export { components as myComponents } from "./components.js";
import { dataGems, recipes, openSaga, type Gem } from "./data.js";
import { home } from "./recipes/home.js";
import { ID } from "@commontools/common-builder";

document.addEventListener("DOMContentLoaded", () => {
  const windowManager = document.getElementById(
    "window-manager"
  )! as CommonWindowManager;
  openSaga.set(windowManager.openSaga.bind(windowManager));
  const homeGem = run(home, { sagas: dataGems, recipes }) as CellImpl<Gem>;
  windowManager.openSaga(homeGem.get()[ID]);
});
