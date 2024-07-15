import { view } from "../view.js";
import * as hole from "../hole.js";
import * as assert from "node:assert/strict";

describe("view()", () => {
  it("parses a context and string template into a view", () => {
    const hello = view("<div>Hello world!</div>", {});
    assert.deepStrictEqual(hello, {
      type: "view",
      template: {
        type: "vnode",
        tag: "div",
        props: {},
        children: ["Hello world!"],
      },
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
      template: {
        type: "vnode",
        tag: "div",
        props: {
          hidden: hole.create("hidden"),
        },
        children: [hole.create("text")],
      },
      context: {
        hidden: false,
        text: "Hello world!",
      },
    });
  });
});
