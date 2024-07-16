import { view, parse, createVar, createVNode } from "../view.js";
import * as assert from "node:assert/strict";

describe("view()", () => {
  it("parses a context and string template into a view", () => {
    const hello = view("<div>Hello world!</div>", {});
    assert.deepStrictEqual(hello, {
      type: "view",
      template: createVNode("div", {}, ["Hello world!"]),
      context: {},
    });
  });

  it("parses a context and string template into a view (2)", () => {
    const hello = view("<div hidden={{hidden}}>{{text}}</div>", {
      hidden: false,
      text: "Hello world!",
    });
    assert.deepStrictEqual(hello, {
      type: "view",
      template: createVNode("div", { hidden: createVar("hidden") }, [
        createVar("text"),
      ]),
      context: {
        hidden: false,
        text: "Hello world!",
      },
    });
  });
});

describe("parse()", () => {
  it("parses", () => {
    const xml = `
      <div class="container" hidden={{hidden}}>
        <button id="foo" onclick={{click}}>Hello world!</button>
      </div>
    `;

    const root = parse(xml);

    assert.deepEqual(
      root,
      createVNode("documentfragment", {}, [
        createVNode(
          "div",
          { class: "container", hidden: createVar("hidden") },
          [
            createVNode("button", { id: "foo", onclick: createVar("click") }, [
              "Hello world!",
            ]),
          ],
        ),
      ]),
    );
  });
});
