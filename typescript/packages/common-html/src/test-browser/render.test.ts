// import { equal as assertEqual } from "./assert.js";
import render from "../render.js";
import html from "../html.js";
// import state from "../state.js";

describe("render", () => {
  it("renders", () => {
    const renderable = html`
    <div class="hello">
      <p>Hello world!</p>
    </div>
    `;
    const dom = render(renderable);
    console.log(dom);
  });
});
