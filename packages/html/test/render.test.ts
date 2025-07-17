import { beforeEach, describe, it } from "@std/testing/bdd";
import { h, UI } from "@commontools/api";
import { render, renderImpl } from "../src/render.ts";
import * as assert from "./assert.ts";
import { JSDOM } from "jsdom";
import { serializableEvent } from "../src/render.ts";

let dom: JSDOM;

beforeEach(() => {
  dom = new JSDOM(`<!DOCTYPE html><html><body></body></html>`);
  const { document } = dom.window;
  globalThis.document = document;
  globalThis.Element = dom.window.Element;
  globalThis.Node = dom.window.Node;
  globalThis.Text = dom.window.Text;
  globalThis.InputEvent = dom.window.InputEvent;
  globalThis.KeyboardEvent = dom.window.KeyboardEvent;
  globalThis.MouseEvent = dom.window.MouseEvent;
  globalThis.CustomEvent = dom.window.CustomEvent;
  globalThis.HTMLSelectElement = dom.window.HTMLSelectElement;
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

describe("serializableEvent", () => {
  function isPlainSerializableObject(obj: any): boolean {
    if (typeof obj !== "object" || obj === null) return true; // primitives are serializable
    if (Array.isArray(obj)) {
      return obj.every(isPlainSerializableObject);
    }
    if (Object.getPrototypeOf(obj) !== Object.prototype) return false;
    for (const key in obj) {
      if (typeof obj[key] === "function") return false;
      if (!isPlainSerializableObject(obj[key])) return false;
    }
    return true;
  }

  it("serializes a basic Event", () => {
    const event = new Event("test");
    const result = serializableEvent(event);
    assert.matchObject(result, { type: "test" });
    assert.equal(
      isPlainSerializableObject(result),
      true,
      "Result should be a plain serializable object",
    );
    // Should not include non-allow-listed fields
    assert.equal(
      "timeStamp" in (result as any),
      false,
      "Should not include timeStamp",
    );
  });

  it("serializes a KeyboardEvent", () => {
    const event = new KeyboardEvent("keydown", {
      key: "a",
      code: "KeyA",
      repeat: true,
      altKey: true,
      ctrlKey: false,
      metaKey: true,
      shiftKey: false,
    });
    const result = serializableEvent(event);
    assert.matchObject(result, {
      type: "keydown",
      key: "a",
      code: "KeyA",
      repeat: true,
      altKey: true,
      ctrlKey: false,
      metaKey: true,
      shiftKey: false,
    });
    assert.equal(
      isPlainSerializableObject(result),
      true,
      "Result should be a plain serializable object",
    );
    assert.equal(
      "timeStamp" in (result as any),
      false,
      "Should not include timeStamp",
    );
  });

  it("serializes a MouseEvent", () => {
    const event = new MouseEvent("click", {
      button: 0,
      buttons: 1,
      altKey: false,
      ctrlKey: true,
      metaKey: false,
      shiftKey: true,
    });
    const result = serializableEvent(event);
    assert.matchObject(result, {
      type: "click",
      button: 0,
      buttons: 1,
      altKey: false,
      ctrlKey: true,
      metaKey: false,
      shiftKey: true,
    });
    assert.equal(
      isPlainSerializableObject(result),
      true,
      "Result should be a plain serializable object",
    );
    assert.equal(
      "timeStamp" in (result as any),
      false,
      "Should not include timeStamp",
    );
  });

  it("serializes an InputEvent with target value", () => {
    const input = document.createElement("input");
    input.value = "hello";
    input.id = "should-not-appear";
    const event = new InputEvent("input", {
      data: "h",
      inputType: "insertText",
    });
    Object.defineProperty(event, "target", { value: input });
    const result = serializableEvent(event);
    assert.matchObject(result, {
      type: "input",
      data: "h",
      inputType: "insertText",
      target: { value: "hello" },
    });
    assert.equal(
      isPlainSerializableObject(result),
      true,
      "Result should be a plain serializable object",
    );
    assert.equal(
      "timeStamp" in (result as any),
      false,
      "Should not include timeStamp",
    );
    assert.equal(
      (result as any).target && "id" in (result as any).target,
      false,
      "Should not include id on target",
    );
  });

  it("serializes a CustomEvent with detail", () => {
    const event = new CustomEvent("custom", { detail: { foo: [42, 43] } });
    const result = serializableEvent(event);
    assert.matchObject(result, {
      type: "custom",
      detail: { foo: [42, 43] },
    });
    assert.equal(
      isPlainSerializableObject(result),
      true,
      "Result should be a plain serializable object",
    );
    assert.equal(
      "timeStamp" in (result as any),
      false,
      "Should not include timeStamp",
    );
  });

  it("serializes an event with HTMLSelectElement target and selectedOptions", () => {
    const select = document.createElement("select");
    select.multiple = true;
    select.id = "should-not-appear";
    // Create option elements
    const option1 = document.createElement("option");
    option1.value = "option1";
    option1.text = "Option 1";
    const option2 = document.createElement("option");
    option2.value = "option2";
    option2.text = "Option 2";
    const option3 = document.createElement("option");
    option3.value = "option3";
    option3.text = "Option 3";
    select.appendChild(option1);
    select.appendChild(option2);
    select.appendChild(option3);
    // Select multiple options
    option1.selected = true;
    option3.selected = true;
    const event = new Event("change");
    Object.defineProperty(event, "target", { value: select });
    const result = serializableEvent(event);
    assert.matchObject(result, {
      type: "change",
      target: {
        selectedOptions: [
          { value: "option1" },
          { value: "option3" },
        ],
      },
    });
    assert.equal(
      isPlainSerializableObject(result),
      true,
      "Result should be a plain serializable object",
    );
    assert.equal(
      "timeStamp" in (result as any),
      false,
      "Should not include timeStamp",
    );
    assert.equal(
      (result as any).target && "id" in (result as any).target,
      false,
      "Should not include id on target",
    );
  });

  it("serializes an event with single-select HTMLSelectElement target", () => {
    const select = document.createElement("select");
    select.multiple = false; // single select
    select.id = "should-not-appear";
    // Create option elements
    const option1 = document.createElement("option");
    option1.value = "option1";
    option1.text = "Option 1";
    const option2 = document.createElement("option");
    option2.value = "option2";
    option2.text = "Option 2";
    select.appendChild(option1);
    select.appendChild(option2);
    // Select single option
    option2.selected = true;
    const event = new Event("change");
    Object.defineProperty(event, "target", { value: select });
    const result = serializableEvent(event);
    assert.matchObject(result, {
      type: "change",
      target: {
        selectedOptions: [
          { value: "option2" },
        ],
      },
    });
    assert.equal(
      isPlainSerializableObject(result),
      true,
      "Result should be a plain serializable object",
    );
    assert.equal(
      "timeStamp" in (result as any),
      false,
      "Should not include timeStamp",
    );
    assert.equal(
      (result as any).target && "id" in (result as any).target,
      false,
      "Should not include id on target",
    );
  });
});
