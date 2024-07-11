import render from "../src/render.js";
import html from "../src/html.js";
import { state, stream } from "../src/state.js";
import { setDebug } from "../src/log.js";

setDebug(true);

const text = state("text", "Hello, world!");
const clicks = stream("clicks");

clicks.sink((value) => {
  console.log("clicks", value);
});

const renderable = html`
  <div class="container">
    <h1 class="title">${text}</h1>
    <button onclick=${clicks}>Click me</button>
  </div>
`;

console.log("renderable", renderable);

const dom = render(renderable);

console.log("dom", dom);

document.body.appendChild(dom);
