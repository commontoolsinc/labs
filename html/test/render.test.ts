import { describe, it } from "@std/testing/bdd";
import { h } from "../src/jsx.ts";
import { render } from "../src/render.ts";
import * as assert from "./assert.ts";
import { JSDOM } from "jsdom";

describe("render", () => {
  it("renders", () => {
    // Set up JSDOM environment for this test
    const dom = new JSDOM(`<!DOCTYPE html><html><body></body></html>`);
    const { document } = dom.window;

    globalThis.document = document;
    globalThis.Element = dom.window.Element;
    globalThis.Node = dom.window.Node;
    globalThis.Text = dom.window.Text;

    const renderable = h(
      "div",
      { id: "hello" },
      h("p", null, "Hello world!"),
    );

    const parent = document.createElement("div");
    document.body.appendChild(parent);
    render(parent, renderable);

    // NOTE: JSDOM has a class instead of className :(
    assert.equal(parent.firstElementChild?.id, "hello");
    assert.equal(parent.querySelector("p")?.textContent, "Hello world!");
  });
});
