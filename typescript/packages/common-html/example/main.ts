import render from "../src/render.js";
import html from "../src/html.js";
import state from "../src/state.js";

const text = state("text", "Hello, world!");
const clicks = state("clicks", null);

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