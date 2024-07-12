import render, { setNodeSanitizer, setEventSanitizer } from "../src/render.js";
import view from "../src/view.js";
import html from "../src/html.js";
import { state, stream } from "../src/state.js";
import { setDebug } from "../src/logger.js";

setDebug(true);

// setNodeSanitizer(...);
// setEventSanitizer(...);

const text = state("text", "Hello, world!");
const input = stream<InputEvent>("clicks");

input.sink((event) => {
  console.log("input", event);
  const target = event.target as HTMLInputElement | null;
  const value = target?.value ?? null;
  if (value !== null) {
    text.send(value);
  }
});

// Build template
const renderable1 = view(
  `
    <div class="container">
      <h1 class="title">{{text}}</h1>
      <input type="text" oninput={{input}} value={{text}} />
    </div>
  `,
  { text, input },
);

// Render
const dom1 = render(renderable1);

document.body.appendChild(dom1);

const renderable2 = html`
  <div class="container">
    <h1 class="title">${text}</h1>
    <input type="text" oninput="${input}" value="${text}" />
  </div>
`;

const dom2 = render(renderable2);

document.body.appendChild(dom2);
