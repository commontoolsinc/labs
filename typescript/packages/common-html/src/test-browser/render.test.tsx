// import { equal as assertEqual } from "./assert.js";
import render from "../render.js";
import { h } from "../jsx.js";
import * as assert from "./assert.js";

describe("render", () => {
  it("renders", () => {
    const renderable = (
      <div class="hello">
        <p>Hello world!</p>
      </div>
    );
    const parent = document.createElement("div");
    render(parent, renderable);
    assert.equal(parent.firstElementChild?.className, "hello");
    assert.equal(parent.querySelector("p")?.textContent, "Hello world!");
  });
});
