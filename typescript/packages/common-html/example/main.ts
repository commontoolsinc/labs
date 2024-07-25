import { cell } from "@commontools/common-propagator";
import view from "../src/view.js";
import html from "../src/html.js";
import render from "../src/render.js";
import { setDebug } from "../src/logger.js";

setDebug(true);

const inputState = cell({ text: "Hello, world!" });
const inputEvents = cell<InputEvent | null>(null);

inputEvents.sink((event) => {
  const target = event?.target as HTMLInputElement | null;
  const value = target?.value;
  if (value != null) {
    inputState.send({ text: value });
  }
});

const time = cell(new Date().toLocaleTimeString());

setInterval(() => {
  time.send(new Date().toLocaleTimeString());
}, 1000);

const timeView = view(`<div class="time">{{time}}</div>`, { time });

// Build template
const titleGroup = view(
  `
    <div class="title-group">
      <h1 class="title">{{input.text}}</h1>
      <input type="text" oninput={{oninput}} value={{input.text}} />
    </div>
  `,
  { input: inputState, oninput: inputEvents },
);

const container = html`
  <div class="container">${timeView} ${titleGroup}</div>
`;

const _cancel = render(document.body, container);
