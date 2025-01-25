// import { equal as assertEqual } from "./assert.js";
import render from "../render.js";
import html from "../html.js";
import view from "../view.js";
import { cell } from "@commontools/common-propagator";
import * as assert from "./assert.js";

describe("render", () => {
  it("renders", () => {
    const renderable = html`
      <div class="hello">
        <p>Hello world!</p>
      </div>
    `;
    const parent = document.createElement("div");
    render(parent, renderable);
    assert.equal(parent.firstElementChild?.className, "hello");
    assert.equal(parent.querySelector("p")?.textContent, "Hello world!");
  });

  it("binds deep paths on variables", () => {
    const a = cell({ b: { c: "Hello world!" } });

    const renderable = view(
      `
        <div class="hello">
          <p>{{a.b.c}}</p>
        </div>
      `,
      { a },
    );
    const parent = document.createElement("div");
    render(parent, renderable);

    assert.equal(parent.querySelector("p")?.textContent, "Hello world!");

    a.send({ b: { c: "Goodbye world!" } });

    assert.equal(parent.querySelector("p")?.textContent, "Goodbye world!");
  });
});
