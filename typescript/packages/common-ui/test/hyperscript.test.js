import { equal, throws } from "./assert.js";
import { state } from "@commontools/common-frp/signal";
import { hstack, checkbox } from "../lib/hyperscript/tags.js";
import { binding } from "../lib/hyperscript/view.js";
import render from "../lib/hyperscript/render.js";

describe("vnode factory functions", () => {
  it("creates a vnode", () => {
    const vnode = hstack({ className: "foo" }, "Hello");

    equal(vnode.tag, "com-hstack");
    equal(vnode.props.className, "foo");
    equal(vnode.children[0], "Hello");
  });
});

describe("add constant props", () => {
  it("creates a vnode", () => {
    const vnode = checkbox({ value: "foo" });

    equal(vnode.tag, "input");
    equal(vnode.props.type, "checkbox");
    equal(vnode.props.value, "foo");
  });
});

describe("it does not create tags that aren't whitelisted", () => {
  throws(() => {
    tags.div({ className: "foo" }, "Hello");
  });
});

describe("it creates an element, substituting template context constants", () => {
  const className = state("foo");

  const vnode = hstack({ className: "foo" }, "Hello");

  const element = render(vnode, { className });

  equal(element.tagName, "COM-HSTACK");
  equal(element.className, "foo");
  equal(element.textContent, "Hello");
});

describe("it binds signals", () => {
  const className = state("foo");

  const vnode = hstack({ className: binding("string", "className") }, "Hello");

  const element = render(vnode, { className });

  equal(element.tagName, "COM-HSTACK");
  equal(element.className, "foo");
  equal(element.textContent, "Hello");

  className.send("bar");

  equal(element.className, "bar");
});
