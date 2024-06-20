import { view, tags, render } from "@commontools/common-ui";
import { signal } from "@commontools/common-frp";
import { dataGems } from "./data.js";
const { binding } = view;
const { include } = tags;
const { computed, isSignal } = signal;

// Hard coded todo list as UI to show
const UI = computed([dataGems], (dataGems) => {
  let UI = dataGems["recipe list"]?.UI;
  if (isSignal(UI)) UI = UI.get();
  return UI;
});

// Render the UI by including the recipe's UI
const element = render.render(include({ content: binding("UI") }), {
  UI,
});

document.body.appendChild(element);
