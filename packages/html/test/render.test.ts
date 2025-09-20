import { beforeEach, describe, it } from "@std/testing/bdd";
import { h, UI, VNode } from "@commontools/api";
import { render, renderImpl } from "../src/render.ts";
import * as assert from "./assert.ts";
import { serializableEvent } from "../src/render.ts";
import { MockDoc } from "../src/utils.ts";

let mock: MockDoc;

class SynthesizedEvent extends Event {
  constructor(name: string, props: object) {
    super(name);
    Object.assign(this, props);
  }
}
class KeyboardEvent extends SynthesizedEvent {}
class InputEvent extends SynthesizedEvent {}
class MouseEvent extends SynthesizedEvent {}

beforeEach(() => {
  mock = new MockDoc(
    `<!DOCTYPE html><html><body><div id="root"></div></body></html>`,
  );
});

describe("render", () => {
  it("renders", () => {
    const { renderOptions, document } = mock;
    // dom and globals are set up by beforeEach
    const renderable = h(
      "div",
      { id: "hello" },
      h("p", null, "Hello world!"),
    );

    const parent = document.getElementById("root")!;
    render(parent, renderable, renderOptions);

    assert.equal(
      parent.getElementsByTagName("div")[0]!.getAttribute("id"),
      "hello",
    );
    assert.equal(
      parent.getElementsByTagName("p")[0]!.innerHTML,
      "Hello world!",
    );
  });
});

describe("renderImpl", () => {
  it("creates DOM for a simple VNode", () => {
    const { renderOptions, document } = mock;
    const vnode = {
      type: "vnode" as const,
      name: "span",
      props: { id: "test-span" },
      children: ["hi!"],
    };
    const parent = document.getElementById("root")!;
    const cancel = renderImpl(parent, vnode, renderOptions);
    const span = parent.getElementsByTagName("span")[0]!;
    assert.equal(span.getAttribute("id"), "test-span");
    assert.equal(span.innerHTML, "hi!");
    cancel();
    assert.equal(parent.getElementsByTagName("span").length, 0);
  });

  it("returns a cancel function that removes the node", () => {
    const { renderOptions, document } = mock;
    const vnode = {
      type: "vnode" as const,
      name: "span",
      props: {},
      children: [],
    };
    const parent = document.getElementById("root")!;
    const cancel = renderImpl(parent, vnode, renderOptions);
    assert.equal(parent.getElementsByTagName("span").length, 1);
    cancel();
    assert.equal(parent.getElementsByTagName("span").length, 0);
  });

  it("handles null/invalid VNode by not appending anything", () => {
    const { renderOptions, document } = mock;
    const invalidVNode = {
      type: "not-vnode",
      name: "div",
      props: {},
      children: [],
    };
    const parent = document.getElementById("root")!;
    const cancel = renderImpl(parent, invalidVNode as VNode, renderOptions);
    assert.equal(parent.children.length, 0);
    cancel();
  });

  it("renders only the [UI] nested vdom when both [UI] and top-level vdom are present", () => {
    const { renderOptions, document } = mock;
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
    const parent = document.getElementById("root")!;
    const cancel = renderImpl(parent, vdomWithUI, renderOptions);
    // Only the nestedVNode should be rendered
    const span = parent.getElementsByTagName("span")[0]!;
    const div = document.getElementById("top");
    assert.equal(span.getAttribute("id"), "nested");
    assert.equal(span.innerHTML, "nested!");
    assert.equal(div, null);
    cancel();
    assert.equal(parent.children.length, 0);
  });
});

describe("serializableEvent", () => {
  function isPlainSerializableObject(obj: unknown): boolean {
    if (typeof obj !== "object" || obj === null) return true; // primitives are serializable
    if (Array.isArray(obj)) {
      return obj.every(isPlainSerializableObject);
    }
    if (Object.getPrototypeOf(obj) !== Object.prototype) return false;
    for (const key in obj) {
      const value = (obj as Record<string, unknown>)[key];
      if (typeof value === "function") return false;
      if (!isPlainSerializableObject(value)) return false;
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
      "timeStamp" in (result as object),
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
      "timeStamp" in (result as object),
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
      "timeStamp" in (result as object),
      false,
      "Should not include timeStamp",
    );
  });

  it("serializes an InputEvent with target value", () => {
    const { document } = mock;
    const input = document.createElement("input");
    input.value = "hello";
    input.id = "should-not-appear";
    const event = new InputEvent("input", {
      data: "h",
      inputType: "insertText",
    });
    Object.defineProperty(event, "target", { value: input });
    const result = serializableEvent(event) as object;
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
      "timeStamp" in result,
      false,
      "Should not include timeStamp",
    );
    assert.equal(
      !!("target" in result && typeof result.target === "object" &&
        result.target && "id" in result.target),
      false,
      "Should not include id on target",
    );
  });

  it("serializes a CustomEvent with detail", () => {
    const event = new CustomEvent("custom", { detail: { foo: [42, 43] } });
    const result = serializableEvent(event) as object;
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
      "timeStamp" in result,
      false,
      "Should not include timeStamp",
    );
  });

  it("serializes an event with HTMLSelectElement target and selectedOptions", () => {
    const { document } = mock;
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
    // @ts-ignore: These aren't real HTMLSelectElements,
    // synthesize selectedOptions
    (select as HTMLSelectElement).selectedOptions = [option1, option3];
    const event = new Event("change");
    Object.defineProperty(event, "target", { value: select });
    const result = serializableEvent(event) as object;
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
      "timeStamp" in result,
      false,
      "Should not include timeStamp",
    );
    assert.equal(
      !!("target" in result && typeof result.target === "object" &&
        result.target && "id" in result.target),
      false,
      "Should not include id on target",
    );
  });

  it("serializes an event with single-select HTMLSelectElement target", () => {
    const { document } = mock;
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
    // @ts-ignore: These aren't real HTMLSelectElements,
    // synthesize selectedOptions
    (select as HTMLSelectElement).selectedOptions = [option2];

    const event = new Event("change");

    Object.defineProperty(event, "target", { value: select });
    const result = serializableEvent(event) as object;
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
      "timeStamp" in result,
      false,
      "Should not include timeStamp",
    );
    assert.equal(
      !!("target" in result && typeof result.target === "object" &&
        result.target && "id" in result.target),
      false,
      "Should not include id on target",
    );
  });
});
