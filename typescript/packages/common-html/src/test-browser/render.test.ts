// import { equal as assertEqual } from "./assert.js";
import render from "../render.js";
import html from "../html.js";

describe("render", () => {
  it("renders", () => {
    const renderable = html`
      <div class="hello">
        <p>Hello world!</p>
      </div>
    `;
    const parent = document.createElement("div");
    render(parent, renderable);
    console.log(parent);
  });
});
