import render, { setNodeSanitizer, setEventSanitizer } from "../src/render.js";
import view from "../src/view.js";
import html from "../src/html.js";
import { state, stream } from "../src/state.js";
import { setDebug } from "../src/logger.js";

setDebug(true);

// setNodeSanitizer(...);
// setEventSanitizer(...);

const text = state("Hello, world!");
const input = stream<InputEvent>();

input.sink((event) => {
  console.log("input", event);
  const target = event.target as HTMLInputElement | null;
  const value = target?.value ?? null;
  if (value !== null) {
    text.send(value);
  }
});

const time = state(new Date().toLocaleTimeString());

setInterval(() => {
  time.send(new Date().toLocaleTimeString());
}, 1000);

const timeView = view(`<div class="time">{{time}}</div>`, { time });

// Build template
const titleGroup = view(
  `
    <div class="title-group">
      <h1 class="title">{{text}}</h1>
      <input type="text" oninput={{input}} value={{text}} />
    </div>
  `,
  { text, input },
);

const container = html`
  <div class="container">${timeView} ${titleGroup}</div>
`;

const dom = render(container);

document.body.appendChild(dom);
