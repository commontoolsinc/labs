import { describe, it } from "@std/testing/bdd";
import { h } from "../src/jsx.ts";
import { render } from "../src/render.ts";
import * as assert from "./assert.ts";

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
