import { beforeEach, describe, it } from "@std/testing/bdd";
import { UI, VNode } from "@commontools/runtime-client";
import { render, renderImpl } from "../src/render.ts";
import { sanitizeEvent } from "../src/render-utils.ts";
import * as assert from "./assert.ts";
import { MockDoc } from "../src/mock-doc.ts";
import { h } from "../src/h.ts";

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
    render(parent, renderable as unknown as VNode, renderOptions);

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

  it("does not render false as text content", () => {
    const { renderOptions, document } = mock;
    const vnode = {
      type: "vnode" as const,
      name: "div",
      props: {},
      children: [false, "visible", null, undefined, true],
    } as VNode;
    const parent = document.getElementById("root")!;
    const cancel = renderImpl(parent, vnode, renderOptions);
    const div = parent.getElementsByTagName("div")[0]!;
    // false, null, and undefined should render as empty text nodes
    // true should render as "true"
    // So innerHTML should be "visibletrue" (no "false")
    assert.equal(div.innerHTML, "visibletrue");
    cancel();
  });
});

describe("sanitizeEvent", () => {
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
    const result = sanitizeEvent(event);
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
    const result = sanitizeEvent(event);
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
    const result = sanitizeEvent(event);
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
    const result = sanitizeEvent(event) as object;
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
    const result = sanitizeEvent(event) as object;
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
    const result = sanitizeEvent(event) as object;
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
    const result = sanitizeEvent(event) as object;
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

  it("serializes an event with target.dataset", () => {
    const { document } = mock;
    const div = document.createElement("div");
    div.setAttribute("data-id", "123");
    div.setAttribute("data-name", "test");
    const event = new Event("click");
    Object.defineProperty(event, "target", { value: div });
    const result = sanitizeEvent(event) as object;
    assert.matchObject(result, {
      type: "click",
      target: {
        dataset: {
          id: "123",
          name: "test",
        },
      },
    });
    assert.equal(
      isPlainSerializableObject(result),
      true,
      "Result should be a plain serializable object",
    );
  });
});

describe("style object support", () => {
  it("converts React-style object to CSS string", () => {
    const { renderOptions, document } = mock;
    const vnode = {
      type: "vnode" as const,
      name: "div",
      props: {
        style: {
          backgroundColor: "red",
          fontSize: 16,
          padding: "10px",
        },
      },
      children: [],
    };
    const parent = document.getElementById("root")!;
    const cancel = renderImpl(parent, vnode, renderOptions);
    const div = parent.getElementsByTagName("div")[0]!;
    const style = div.getAttribute("style");
    assert.equal(
      style?.includes("background-color: red"),
      true,
      "Should convert backgroundColor to background-color",
    );
    assert.equal(
      style?.includes("font-size: 16px"),
      true,
      "Should add px to numeric fontSize",
    );
    assert.equal(
      style?.includes("padding: 10px"),
      true,
      "Should preserve string values",
    );
    cancel();
  });

  it("handles unitless numeric properties", () => {
    const { renderOptions, document } = mock;
    const vnode = {
      type: "vnode" as const,
      name: "div",
      props: {
        style: {
          opacity: 0.5,
          zIndex: 10,
          flex: 1,
          flexGrow: 1,
          lineHeight: 1.5,
        },
      },
      children: [],
    };
    const parent = document.getElementById("root")!;
    const cancel = renderImpl(parent, vnode, renderOptions);
    const div = parent.getElementsByTagName("div")[0]!;
    const style = div.getAttribute("style");
    assert.equal(
      style?.includes("opacity: 0.5"),
      true,
      "opacity should be unitless",
    );
    assert.equal(
      style?.includes("z-index: 10"),
      true,
      "z-index should be unitless",
    );
    assert.equal(style?.includes("flex: 1"), true, "flex should be unitless");
    assert.equal(
      style?.includes("flex-grow: 1"),
      true,
      "flex-grow should be unitless",
    );
    assert.equal(
      style?.includes("line-height: 1.5"),
      true,
      "line-height should be unitless",
    );
    cancel();
  });

  it("handles vendor prefixes", () => {
    const { renderOptions, document } = mock;
    const vnode = {
      type: "vnode" as const,
      name: "div",
      props: {
        style: {
          WebkitTransform: "rotate(45deg)",
          MozAppearance: "none",
          msUserSelect: "none",
        },
      },
      children: [],
    };
    const parent = document.getElementById("root")!;
    const cancel = renderImpl(parent, vnode, renderOptions);
    const div = parent.getElementsByTagName("div")[0]!;
    const style = div.getAttribute("style");
    assert.equal(
      style?.includes("-webkit-transform: rotate(45deg)"),
      true,
      "Should handle WebkitTransform",
    );
    assert.equal(
      style?.includes("-moz-appearance: none"),
      true,
      "Should handle MozAppearance",
    );
    assert.equal(
      style?.includes("-ms-user-select: none"),
      true,
      "Should handle msUserSelect",
    );
    cancel();
  });

  it("handles zero values without units", () => {
    const { renderOptions, document } = mock;
    const vnode = {
      type: "vnode" as const,
      name: "div",
      props: {
        style: {
          margin: 0,
          padding: 0,
        },
      },
      children: [],
    };
    const parent = document.getElementById("root")!;
    const cancel = renderImpl(parent, vnode, renderOptions);
    const div = parent.getElementsByTagName("div")[0]!;
    const style = div.getAttribute("style");
    assert.equal(
      style?.includes("margin: 0"),
      true,
      "Should handle zero margin",
    );
    assert.equal(
      style?.includes("padding: 0"),
      true,
      "Should handle zero padding",
    );
    cancel();
  });

  it("handles null and undefined values", () => {
    const { renderOptions, document } = mock;
    const vnode = {
      type: "vnode" as const,
      name: "div",
      props: {
        style: {
          color: "blue",
          backgroundColor: null,
          fontSize: undefined,
        },
      },
      children: [],
    };
    const parent = document.getElementById("root")!;
    const cancel = renderImpl(parent, vnode, renderOptions);
    const div = parent.getElementsByTagName("div")[0]!;
    const style = div.getAttribute("style");
    assert.equal(style?.includes("color: blue"), true, "Should include color");
    assert.equal(
      style?.includes("background-color"),
      false,
      "Should skip null values",
    );
    assert.equal(
      style?.includes("font-size"),
      false,
      "Should skip undefined values",
    );
    cancel();
  });

  it("handles complex CSS values", () => {
    const { renderOptions, document } = mock;
    const vnode = {
      type: "vnode" as const,
      name: "div",
      props: {
        style: {
          boxShadow: "0 4px 6px rgba(0, 0, 0, 0.1)",
          backgroundImage: "linear-gradient(to right, red, blue)",
          transform: "translate3d(10px, 20px, 0)",
        },
      },
      children: [],
    };
    const parent = document.getElementById("root")!;
    const cancel = renderImpl(parent, vnode, renderOptions);
    const div = parent.getElementsByTagName("div")[0]!;
    const style = div.getAttribute("style");
    assert.equal(
      style?.includes("box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1)"),
      true,
      "Should handle box-shadow",
    );
    assert.equal(
      style?.includes("background-image: linear-gradient(to right, red, blue)"),
      true,
      "Should handle gradients",
    );
    assert.equal(
      style?.includes("transform: translate3d(10px, 20px, 0)"),
      true,
      "Should handle transforms",
    );
    cancel();
  });

  it("handles style object alongside other props", () => {
    const { renderOptions, document } = mock;
    const vnode = {
      type: "vnode" as const,
      name: "div",
      props: {
        id: "styled-div",
        className: "test-class",
        style: {
          color: "red",
          fontSize: 14,
        },
        "data-test": "value",
      },
      children: [],
    };
    const parent = document.getElementById("root")!;
    const cancel = renderImpl(parent, vnode, renderOptions);
    const div = parent.getElementsByTagName("div")[0]!;
    assert.equal(div.getAttribute("id"), "styled-div");
    // Use getAttribute for className in mock DOM
    // @ts-ignore: attribs exists on mock element
    assert.equal(div.attribs.className, "test-class");
    assert.equal(div.getAttribute("data-test"), "value");
    const style = div.getAttribute("style");
    assert.equal(style?.includes("color: red"), true);
    assert.equal(style?.includes("font-size: 14px"), true);
    cancel();
  });

  it("handles empty style object", () => {
    const { renderOptions, document } = mock;
    const vnode = {
      type: "vnode" as const,
      name: "div",
      props: {
        style: {},
      },
      children: [],
    };
    const parent = document.getElementById("root")!;
    const cancel = renderImpl(parent, vnode, renderOptions);
    const div = parent.getElementsByTagName("div")[0]!;
    const style = div.getAttribute("style");
    assert.equal(style, "", "Empty style object should result in empty string");
    cancel();
  });

  it("handles CSS custom properties (variables) without adding px", () => {
    const { renderOptions, document } = mock;
    const vnode = {
      type: "vnode" as const,
      name: "div",
      props: {
        style: {
          "--scale": 2,
          "--opacity": 0.5,
          "--columns": 3,
          "--primary-color": "#ff0000",
          "--MyAccent": "blue",
          "--THEME-Color": "green",
        },
      },
      children: [],
    };
    const parent = document.getElementById("root")!;
    const cancel = renderImpl(parent, vnode, renderOptions);
    const div = parent.getElementsByTagName("div")[0]!;
    const style = div.getAttribute("style");
    assert.equal(
      style?.includes("--scale: 2"),
      true,
      "CSS variables should not get px suffix",
    );
    assert.equal(
      style?.includes("--opacity: 0.5"),
      true,
      "CSS variables should preserve decimal values",
    );
    assert.equal(
      style?.includes("--columns: 3"),
      true,
      "CSS variables should preserve numeric values",
    );
    assert.equal(
      style?.includes("--primary-color: #ff0000"),
      true,
      "CSS variables should preserve string values",
    );
    assert.equal(
      style?.includes("--MyAccent: blue"),
      true,
      "CSS variables should preserve case sensitivity",
    );
    assert.equal(
      style?.includes("--THEME-Color: green"),
      true,
      "CSS variables should preserve mixed case",
    );
    cancel();
  });
});

describe("dataset attributes", () => {
  it("sets data-* attributes using setAttribute", () => {
    const { renderOptions, document } = mock;
    const vnode = {
      type: "vnode" as const,
      name: "div",
      props: {
        "data-id": "123",
        "data-name": "test",
      },
      children: [],
    };
    const parent = document.getElementById("root")!;
    const cancel = renderImpl(parent, vnode, renderOptions);
    const div = parent.getElementsByTagName("div")[0]!;
    assert.equal(div.getAttribute("data-id"), "123");
    assert.equal(div.getAttribute("data-name"), "test");
    // @ts-ignore: dataset exists on Element in real DOM
    assert.equal(div.dataset.id, "123");
    // @ts-ignore: dataset exists on Element in real DOM
    assert.equal(div.dataset.name, "test");
    cancel();
  });

  it("removes data-* attributes when value is null", () => {
    const { renderOptions, document } = mock;
    const parent = document.getElementById("root")!;

    // First render with data attribute
    const vnode1 = {
      type: "vnode" as const,
      name: "div",
      props: {
        "data-id": "123",
      },
      children: [],
    };
    const cancel1 = renderImpl(parent, vnode1, renderOptions);
    const div = parent.getElementsByTagName("div")[0]!;
    assert.equal(div.getAttribute("data-id"), "123");
    cancel1();

    // Re-render with null value
    const vnode2 = {
      type: "vnode" as const,
      name: "div",
      props: {
        "data-id": null,
      },
      children: [],
    };
    const cancel2 = renderImpl(parent, vnode2, renderOptions);
    const div2 = parent.getElementsByTagName("div")[0]!;
    assert.equal(div2.hasAttribute("data-id"), false);
    cancel2();
  });

  it("removes data-* attributes when value is undefined", () => {
    const { renderOptions, document } = mock;
    const parent = document.getElementById("root")!;

    // First render with data attribute
    const vnode1 = {
      type: "vnode" as const,
      name: "div",
      props: {
        "data-id": "123",
      },
      children: [],
    };
    const cancel1 = renderImpl(parent, vnode1, renderOptions);
    const div = parent.getElementsByTagName("div")[0]!;
    assert.equal(div.getAttribute("data-id"), "123");
    cancel1();

    // Re-render with undefined value
    // @ts-ignore: Testing undefined handling even though it's not in Props type
    const vnode2 = {
      type: "vnode" as const,
      name: "div",
      props: {
        "data-id": undefined,
      },
      children: [],
    } as VNode;
    const cancel2 = renderImpl(parent, vnode2, renderOptions);
    const div2 = parent.getElementsByTagName("div")[0]!;
    assert.equal(div2.hasAttribute("data-id"), false);
    cancel2();
  });

  it("converts non-string values to strings for data-* attributes", () => {
    const { renderOptions, document } = mock;
    const vnode = {
      type: "vnode" as const,
      name: "div",
      props: {
        "data-count": 42,
        "data-enabled": true,
        "data-items": ["a", "b", "c"],
      },
      children: [],
    };
    const parent = document.getElementById("root")!;
    const cancel = renderImpl(parent, vnode, renderOptions);
    const div = parent.getElementsByTagName("div")[0]!;
    assert.equal(div.getAttribute("data-count"), "42");
    assert.equal(div.getAttribute("data-enabled"), "true");
    assert.equal(div.getAttribute("data-items"), "a,b,c");
    cancel();
  });

  it("updates data-* attributes when value changes", () => {
    const { renderOptions, document } = mock;
    const parent = document.getElementById("root")!;

    // First render
    const vnode1 = {
      type: "vnode" as const,
      name: "div",
      props: {
        "data-id": "123",
      },
      children: [],
    };
    const cancel1 = renderImpl(parent, vnode1, renderOptions);
    const div = parent.getElementsByTagName("div")[0]!;
    assert.equal(div.getAttribute("data-id"), "123");
    cancel1();

    // Update with new value
    const vnode2 = {
      type: "vnode" as const,
      name: "div",
      props: {
        "data-id": "456",
      },
      children: [],
    };
    const cancel2 = renderImpl(parent, vnode2, renderOptions);
    const div2 = parent.getElementsByTagName("div")[0]!;
    assert.equal(div2.getAttribute("data-id"), "456");
    cancel2();
  });
});

describe("cycle detection", () => {
  it("detects direct [UI] self-reference cycle and renders placeholder", () => {
    const { renderOptions, document } = mock;
    // Create a VNode that references itself via [UI]
    const selfRefNode: VNode = {
      type: "vnode" as const,
      name: "div",
      props: { id: "self-ref" },
      children: [],
    };
    // Create cycle: node[UI] points to itself
    (selfRefNode as any)[UI] = selfRefNode;

    const parent = document.getElementById("root")!;
    const cancel = renderImpl(parent, selfRefNode, renderOptions);

    // Cyclic [UI] references are detected and render a placeholder
    assert.equal(parent.children.length, 1);
    assert.equal(parent.children[0].textContent, "🔄");
    cancel();
  });

  it("detects indirect [UI] chain cycle (A -> B -> A) and renders placeholder", () => {
    const { renderOptions, document } = mock;
    // Create two VNodes that reference each other via [UI]
    const nodeA: VNode = {
      type: "vnode" as const,
      name: "div",
      props: { id: "node-a" },
      children: [],
    };
    const nodeB: VNode = {
      type: "vnode" as const,
      name: "span",
      props: { id: "node-b" },
      children: [],
    };
    // Create cycle: A[UI] -> B[UI] -> A
    (nodeA as any)[UI] = nodeB;
    (nodeB as any)[UI] = nodeA;

    const parent = document.getElementById("root")!;
    const cancel = renderImpl(parent, nodeA, renderOptions);

    // Cyclic [UI] references are detected and render a placeholder
    assert.equal(parent.children.length, 1);
    assert.equal(parent.children[0].textContent, "🔄");
    cancel();
  });

  it("detects cycle when child VNode references parent", () => {
    const { renderOptions, document } = mock;
    // Create parent that has itself as a child
    const parentNode: VNode = {
      type: "vnode" as const,
      name: "div",
      props: { id: "parent" },
      children: [], // will be set below
    };
    // Child references parent, creating a cycle
    parentNode.children = [parentNode];

    const parent = document.getElementById("root")!;
    const cancel = renderImpl(parent, parentNode, renderOptions);

    // Should render the parent div with cycle placeholder as child
    const div = parent.getElementsByTagName("div")[0];
    assert.equal(div?.getAttribute("id"), "parent");
    const span = div?.getElementsByTagName("span")[0];
    assert.equal(span?.textContent, "🔄");
    cancel();
  });

  it("allows the same VNode object as siblings (not a cycle)", () => {
    const { renderOptions, document } = mock;
    // Create a VNode that appears twice as siblings
    const sharedChild: VNode = {
      type: "vnode" as const,
      name: "span",
      props: { className: "shared" },
      children: ["shared content"],
    };
    const parentNode: VNode = {
      type: "vnode" as const,
      name: "div",
      props: {},
      children: [sharedChild, sharedChild], // same object twice
    };

    const parent = document.getElementById("root")!;
    const cancel = renderImpl(parent, parentNode, renderOptions);

    // Should render both siblings without cycle detection
    const spans = parent.getElementsByTagName("span");
    assert.equal(spans.length, 2);
    // Check via innerHTML that neither is a cycle placeholder
    assert.equal(
      parent.innerHTML.includes("🔄"),
      false,
      "Should not contain cycle placeholder",
    );
    cancel();
  });

  it("allows valid [UI] chain without cycle", () => {
    const { renderOptions, document } = mock;
    // Create a valid [UI] chain: A[UI] -> B[UI] -> C (no cycle)
    const nodeC: VNode = {
      type: "vnode" as const,
      name: "span",
      props: { id: "final" },
      children: ["final content"],
    };
    const nodeB: VNode = {
      type: "vnode" as const,
      name: "div",
      props: { id: "node-b" },
      children: [],
      [UI]: nodeC,
    } as VNode;
    const nodeA: VNode = {
      type: "vnode" as const,
      name: "div",
      props: { id: "node-a" },
      children: [],
      [UI]: nodeB,
    } as VNode;

    const parent = document.getElementById("root")!;
    const cancel = renderImpl(parent, nodeA, renderOptions);

    // Should render nodeC (the final node in the [UI] chain)
    const span = parent.getElementsByTagName("span")[0];
    assert.equal(span?.getAttribute("id"), "final");
    // Check via innerHTML since textContent doesn't work in MockDoc
    assert.equal(parent.innerHTML.includes("final content"), true);
    cancel();
  });

  it("detects deep nested cycle (grandchild references grandparent)", () => {
    const { renderOptions, document } = mock;
    // Create: grandparent -> parent -> child -> grandparent (cycle)
    const grandparent: VNode = {
      type: "vnode" as const,
      name: "div",
      props: { id: "grandparent" },
      children: [],
    };
    const parentNode: VNode = {
      type: "vnode" as const,
      name: "div",
      props: { id: "parent" },
      children: [],
    };
    // Create cycle: grandparent -> parent -> grandparent
    grandparent.children = [parentNode];
    parentNode.children = [grandparent];

    const parent = document.getElementById("root")!;
    const cancel = renderImpl(parent, grandparent, renderOptions);

    // Should render grandparent and parent, with cycle detected at the child level
    const divs = parent.getElementsByTagName("div");
    assert.equal(divs.length, 2);
    // The innermost should have the cycle placeholder
    const innerDiv = divs[1];
    const span = innerDiv?.getElementsByTagName("span")[0];
    assert.equal(span?.textContent, "🔄");
    cancel();
  });
});

describe("DOM reordering algorithm", () => {
  it("correctly reorders children [A, B] to [B, A] using live childNodes", () => {
    // This test verifies the fix for the stale childNodes reference bug.
    // The bug: capturing element.childNodes into a static array, then using
    // insertBefore() which mutates the DOM, causing subsequent iterations
    // to reference stale positions.
    const { document } = mock;
    const parent = document.createElement("div");

    // Create two children
    const childA = document.createElement("span");
    childA.textContent = "Alice";
    const childB = document.createElement("span");
    childB.textContent = "Bob";

    // Initial order: [Alice, Bob]
    parent.appendChild(childA);
    parent.appendChild(childB);
    assert.equal(parent.childNodes[0], childA);
    assert.equal(parent.childNodes[1], childB);

    // Simulate the reorder algorithm using LIVE childNodes (the fix)
    // Desired order: [Bob, Alice]
    const desiredOrder = [childB, childA];
    for (let i = 0; i < desiredOrder.length; i++) {
      const desiredNode = desiredOrder[i];
      // Use live childNodes[i] instead of a stale snapshot
      if (parent.childNodes[i] !== desiredNode) {
        parent.insertBefore(desiredNode, parent.childNodes[i] ?? null);
      }
    }

    // Verify final order is [Bob, Alice]
    assert.equal(parent.childNodes[0], childB, "First child should be Bob");
    assert.equal(parent.childNodes[1], childA, "Second child should be Alice");
    assert.equal(
      (parent.childNodes[0] as Element).textContent,
      "Bob",
      "First child text should be Bob",
    );
    assert.equal(
      (parent.childNodes[1] as Element).textContent,
      "Alice",
      "Second child text should be Alice",
    );
  });

  it("correctly reverses [A, B, C] to [C, B, A] using live childNodes", () => {
    const { document } = mock;
    const parent = document.createElement("div");

    const childA = document.createElement("span");
    childA.textContent = "A";
    const childB = document.createElement("span");
    childB.textContent = "B";
    const childC = document.createElement("span");
    childC.textContent = "C";

    // Initial order: [A, B, C]
    parent.appendChild(childA);
    parent.appendChild(childB);
    parent.appendChild(childC);

    // Desired order: [C, B, A]
    const desiredOrder = [childC, childB, childA];
    for (let i = 0; i < desiredOrder.length; i++) {
      const desiredNode = desiredOrder[i];
      if (parent.childNodes[i] !== desiredNode) {
        parent.insertBefore(desiredNode, parent.childNodes[i] ?? null);
      }
    }

    // Verify final order is [C, B, A]
    assert.equal(
      (parent.childNodes[0] as Element).textContent,
      "C",
      "First should be C",
    );
    assert.equal(
      (parent.childNodes[1] as Element).textContent,
      "B",
      "Second should be B",
    );
    assert.equal(
      (parent.childNodes[2] as Element).textContent,
      "A",
      "Third should be A",
    );
  });

  it("demonstrates the bug with stale snapshot (for documentation)", () => {
    // This test shows what WOULD happen with the bug (stale snapshot)
    // We don't actually want this behavior, but it documents the issue.
    const { document } = mock;
    const parent = document.createElement("div");

    const childA = document.createElement("span");
    childA.textContent = "Alice";
    const childB = document.createElement("span");
    childB.textContent = "Bob";

    // Initial order: [Alice, Bob]
    parent.appendChild(childA);
    parent.appendChild(childB);

    // THE BUG: Capture a STATIC snapshot (this is what the old code did)
    const domNodes = Array.from(parent.childNodes);

    // Desired order: [Bob, Alice]
    const desiredOrder = [childB, childA];
    for (let i = 0; i < desiredOrder.length; i++) {
      const desiredNode = desiredOrder[i];
      // Bug: using stale domNodes[i] instead of live childNodes[i]
      if (domNodes[i] !== desiredNode) {
        parent.insertBefore(desiredNode, domNodes[i] ?? null);
      }
    }

    // With the bug, the final order is WRONG: [Alice, Bob] instead of [Bob, Alice]
    // i=0: domNodes[0]=Alice, desired=Bob, Alice≠Bob, so insertBefore(Bob, Alice) → [Bob, Alice] ✓
    // i=1: domNodes[1]=Bob (STALE!), desired=Alice, Bob≠Alice, so insertBefore(Alice, Bob)
    //      But Bob is now at position 0, so this inserts Alice before Bob → [Alice, Bob] ✗
    assert.equal(
      (parent.childNodes[0] as Element).textContent,
      "Alice",
      "Bug: First child is Alice (wrong!)",
    );
    assert.equal(
      (parent.childNodes[1] as Element).textContent,
      "Bob",
      "Bug: Second child is Bob (wrong!)",
    );
  });

  it("handles shrinking array [A, B, C] to [A] correctly", () => {
    // This simulates the full bindChildren algorithm:
    // 1. Remove obsolete nodes (B, C)
    // 2. Reorder remaining nodes
    const { document } = mock;
    const parent = document.createElement("div");

    const childA = document.createElement("span");
    childA.textContent = "A";
    const childB = document.createElement("span");
    childB.textContent = "B";
    const childC = document.createElement("span");
    childC.textContent = "C";

    // Initial: [A, B, C]
    parent.appendChild(childA);
    parent.appendChild(childB);
    parent.appendChild(childC);
    assert.equal(parent.childNodes.length, 3);

    // Simulate bindChildren update to [A]:
    // Step 1: Remove obsolete nodes (B and C)
    childB.remove();
    childC.remove();

    // Step 2: Reorder (only A remains, should be at position 0)
    const desiredOrder = [childA];
    for (let i = 0; i < desiredOrder.length; i++) {
      const desiredNode = desiredOrder[i];
      if (parent.childNodes[i] !== desiredNode) {
        parent.insertBefore(desiredNode, parent.childNodes[i] ?? null);
      }
    }

    // Verify: only A remains
    assert.equal(parent.childNodes.length, 1, "Should have 1 child");
    assert.equal(
      (parent.childNodes[0] as Element).textContent,
      "A",
      "Only child should be A",
    );
  });

  it("handles growing array [A] to [A, B, C] correctly", () => {
    const { document } = mock;
    const parent = document.createElement("div");

    const childA = document.createElement("span");
    childA.textContent = "A";
    const childB = document.createElement("span");
    childB.textContent = "B";
    const childC = document.createElement("span");
    childC.textContent = "C";

    // Initial: [A]
    parent.appendChild(childA);
    assert.equal(parent.childNodes.length, 1);

    // Simulate bindChildren update to [A, B, C]:
    // B and C are new nodes (not yet in DOM)
    const desiredOrder = [childA, childB, childC];
    for (let i = 0; i < desiredOrder.length; i++) {
      const desiredNode = desiredOrder[i];
      if (parent.childNodes[i] !== desiredNode) {
        // childNodes[i] ?? null handles appending when i >= length
        parent.insertBefore(desiredNode, parent.childNodes[i] ?? null);
      }
    }

    // Verify: [A, B, C]
    assert.equal(parent.childNodes.length, 3, "Should have 3 children");
    assert.equal((parent.childNodes[0] as Element).textContent, "A");
    assert.equal((parent.childNodes[1] as Element).textContent, "B");
    assert.equal((parent.childNodes[2] as Element).textContent, "C");
  });

  it("handles shrink AND reorder [A, B, C] to [C, A] correctly", () => {
    const { document } = mock;
    const parent = document.createElement("div");

    const childA = document.createElement("span");
    childA.textContent = "A";
    const childB = document.createElement("span");
    childB.textContent = "B";
    const childC = document.createElement("span");
    childC.textContent = "C";

    // Initial: [A, B, C]
    parent.appendChild(childA);
    parent.appendChild(childB);
    parent.appendChild(childC);

    // Simulate bindChildren update to [C, A]:
    // Step 1: Remove obsolete node (B)
    childB.remove();
    // DOM is now [A, C]

    // Step 2: Reorder to [C, A]
    const desiredOrder = [childC, childA];
    for (let i = 0; i < desiredOrder.length; i++) {
      const desiredNode = desiredOrder[i];
      if (parent.childNodes[i] !== desiredNode) {
        parent.insertBefore(desiredNode, parent.childNodes[i] ?? null);
      }
    }

    // Verify: [C, A]
    assert.equal(parent.childNodes.length, 2, "Should have 2 children");
    assert.equal(
      (parent.childNodes[0] as Element).textContent,
      "C",
      "First should be C",
    );
    assert.equal(
      (parent.childNodes[1] as Element).textContent,
      "A",
      "Second should be A",
    );
  });

  it("handles grow AND reorder [A] to [C, B, A] correctly", () => {
    const { document } = mock;
    const parent = document.createElement("div");

    const childA = document.createElement("span");
    childA.textContent = "A";
    const childB = document.createElement("span");
    childB.textContent = "B";
    const childC = document.createElement("span");
    childC.textContent = "C";

    // Initial: [A]
    parent.appendChild(childA);

    // Simulate bindChildren update to [C, B, A]:
    // B and C are new (not in DOM yet)
    const desiredOrder = [childC, childB, childA];
    for (let i = 0; i < desiredOrder.length; i++) {
      const desiredNode = desiredOrder[i];
      if (parent.childNodes[i] !== desiredNode) {
        parent.insertBefore(desiredNode, parent.childNodes[i] ?? null);
      }
    }

    // Verify: [C, B, A]
    assert.equal(parent.childNodes.length, 3, "Should have 3 children");
    assert.equal((parent.childNodes[0] as Element).textContent, "C");
    assert.equal((parent.childNodes[1] as Element).textContent, "B");
    assert.equal((parent.childNodes[2] as Element).textContent, "A");
  });
});

describe("bidirectional binding validation", () => {
  it("throws when $value is a primitive string", () => {
    assert.throws(
      () => h("ct-input", { $value: "hello" }),
      "Should throw for primitive string $value",
    );
  });

  it("throws when $value is a primitive number", () => {
    assert.throws(
      () => h("ct-input", { $value: 42 }),
      "Should throw for primitive number $value",
    );
  });

  it("throws when $checked is a primitive boolean", () => {
    assert.throws(
      () => h("ct-checkbox", { $checked: true }),
      "Should throw for primitive boolean $checked",
    );
  });

  it("throws when $value is null", () => {
    assert.throws(
      () => h("ct-input", { $value: null }),
      "Should throw for null $value",
    );
  });

  it("throws when $value is undefined", () => {
    assert.throws(
      () => h("ct-input", { $value: undefined }),
      "Should throw for undefined $value",
    );
  });

  it("throws when $value is a plain object (not a Cell)", () => {
    assert.throws(
      () => h("ct-input", { $value: { someData: "test" } }),
      "Should throw for plain object $value",
    );
  });

  it("throws when $value is an array (not a Cell)", () => {
    assert.throws(
      () => h("ct-input", { $value: [1, 2, 3] }),
      "Should throw for array $value",
    );
  });

  it("does not throw for regular (non-$) props with any value", () => {
    // Regular props should not be validated
    const vnode = h("div", {
      value: "string",
      count: 42,
      checked: true,
      data: { nested: "object" },
    });
    assert.equal(vnode.type, "vnode");
    assert.equal(vnode.name, "div");
  });

  it("allows null props object", () => {
    const vnode = h("div", null, "child");
    assert.equal(vnode.type, "vnode");
    assert.equal(vnode.name, "div");
  });

  it("error message mentions $value property name", () => {
    let errorMessage = "";
    try {
      h("ct-input", { $value: "test" });
    } catch (e) {
      errorMessage = (e as Error).message;
    }
    assert.equal(
      errorMessage.includes("$value"),
      true,
      "Error message should mention the property name",
    );
  });

  it("error message mentions $checked property name", () => {
    let errorMessage = "";
    try {
      h("ct-checkbox", { $checked: false });
    } catch (e) {
      errorMessage = (e as Error).message;
    }
    assert.equal(
      errorMessage.includes("$checked"),
      true,
      "Error message should mention the property name",
    );
  });

  it("error message for $checked includes checkbox example", () => {
    let errorMessage = "";
    try {
      h("ct-checkbox", { $checked: false });
    } catch (e) {
      errorMessage = (e as Error).message;
    }
    assert.equal(
      errorMessage.includes("ct-checkbox"),
      true,
      "Error message for $checked should include checkbox example",
    );
  });

  it("error message for $value includes input example", () => {
    let errorMessage = "";
    try {
      h("ct-input", { $value: "test" });
    } catch (e) {
      errorMessage = (e as Error).message;
    }
    assert.equal(
      errorMessage.includes("ct-input"),
      true,
      "Error message for $value should include input example",
    );
  });
});
