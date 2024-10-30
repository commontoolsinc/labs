export * as components from "./components/index.js";
export * as view from "./hyperscript/view.js";
export * as tags from "./hyperscript/tags.js";
export * as render from "./hyperscript/render.js";
export * as style from "./components/style.js";
import { adoptStyles } from "./components/shoelace/index.js";

const setup = () => {
  adoptStyles();
  console.log("Hit");
};

setup();
