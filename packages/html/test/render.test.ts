import { beforeEach, describe, it } from "@std/testing/bdd";
import { h, UI } from "@commontools/api";
import { render, renderImpl } from "../src/render.ts";
import * as assert from "./assert.ts";
import { JSDOM } from "jsdom";

let dom: JSDOM;

beforeEach(() => {
  dom = new JSDOM(`<!DOCTYPE html><html><body></body></html>`);
  const { document } = dom.window;
  globalThis.document = document;
  globalThis.Element = dom.window.Element;
  globalThis.Node = dom.window.Node;
  globalThis.Text = dom.window.Text;
});

describe("render", () => {
  it("renders", () => {
    // dom and globals are set up by beforeEach
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

describe("renderImpl", () => {
  it("creates DOM for a simple VNode", () => {
    const vnode = {
      type: "vnode" as const,
      name: "span",
      props: { id: "test-span" },
      children: ["hi!"],
    };
    const parent = document.createElement("div");
    const cancel = renderImpl(parent, vnode);
    const span = parent.querySelector("span");
    assert.equal(span?.id, "test-span");
    assert.equal(span?.textContent, "hi!");
    cancel();
    assert.equal(parent.querySelector("span"), null);
  });

  it("returns a cancel function that removes the node", () => {
    const vnode = {
      type: "vnode" as const,
      name: "div",
      props: {},
      children: [],
    };
    const parent = document.createElement("div");
    const cancel = renderImpl(parent, vnode);
    assert.equal(parent.querySelector("div") !== null, true);
    cancel();
    assert.equal(parent.querySelector("div"), null);
  });

  it("handles null/invalid VNode by not appending anything", () => {
    const invalidVNode = {
      type: "not-vnode",
      name: "div",
      props: {},
      children: [],
    };
    const parent = document.createElement("div");
    const cancel = renderImpl(parent, invalidVNode as any);
    assert.equal(parent.children.length, 0);
    cancel();
  });

  it("renders only the [UI] nested vdom when both [UI] and top-level vdom are present", () => {
    // The [UI] property should take precedence over the top-level vdom
    const nestedVNode = {
      type: "vnode" as const,
      name: "span",
      props: { id: "nested" },
      children: ["nested!"],
    };
    const topLevelVNode = {
      type: "vnode" as const,
      name: "div",
      props: { id: "top" },
      children: ["top!"],
    };
    // Compose an object with both vdom and [UI]
    const vdomWithUI = {
      ...topLevelVNode,
      [UI]: nestedVNode,
    };
    const parent = document.createElement("div");
    const cancel = renderImpl(parent, vdomWithUI as any);
    // Only the nestedVNode should be rendered
    const span = parent.querySelector("span#nested");
    const div = parent.querySelector("div#top");
    assert.equal(!!span, true);
    assert.equal(span?.textContent, "nested!");
    assert.equal(div, null);
    cancel();
    assert.equal(parent.children.length, 0);
  });
});
