export * as components from "./components/index.js";
export * as view from "./hyperscript/view.js";
export * as tags from "./hyperscript/tags.js";
export * as render from "./hyperscript/render.js";
export * as style from "./components/style.js";
import { setupShoelace } from "./components/shoelace/index.js";
import { compileStylesheet, all as allClasses } from "./breeze/breeze.js";

const setup = () => {
  setupShoelace();
  const breeze = compileStylesheet(allClasses());
  document.adoptedStyleSheets.push(breeze);
};

setup();
