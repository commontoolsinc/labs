import render, { setNodeSanitizer, setEventSanitizer } from "../src/render.js";
import html from "../src/html.js";
import { state, stream } from "../src/state.js";
import { setDebug } from "../src/logger.js";

setDebug(true);

// setNodeSanitizer(...);
// setEventSanitizer(...);

const text = state("text", "Hello, world!");
const clicks = stream("clicks");

// Build template
const renderable = html`
  <div class="container">
    <h1 class="title">${text}</h1>
    <button onclick=${clicks}>Click me</button>
  </div>
`;

// Render
const dom = render(renderable);

clicks.sink((value) => {
  console.log("clicks", value);
});

setInterval(() => {
  text.send(`Hello, world! ${new Date().toLocaleTimeString()}`);
}, 1000);

document.body.appendChild(dom);
