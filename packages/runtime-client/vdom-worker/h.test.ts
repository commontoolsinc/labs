/**
 * Tests for worker-side JSX factory (h function).
 */

import { assertEquals, assertThrows } from "@std/assert";
import {
  FRAGMENT_ELEMENT,
  getBindingPropName,
  getEventType,
  h,
  isBindingProp,
  isEventHandler,
  isEventProp,
} from "./h.ts";
import type { WorkerRenderNode, WorkerVNode } from "./types.ts";

Deno.test("h - basic element creation", async (t) => {
  await t.step("creates a basic element", () => {
    const result = h("div", null) as WorkerVNode;

    assertEquals(result.type, "vnode");
    assertEquals(result.name, "div");
    assertEquals(result.props, {});
    assertEquals(result.children, []);
  });

  await t.step("creates an element with props", () => {
    const result = h("div", { className: "foo", id: "bar" }) as WorkerVNode;

    assertEquals(result.type, "vnode");
    assertEquals(result.name, "div");
    assertEquals(result.props, { className: "foo", id: "bar" });
  });

  await t.step("creates an element with children", () => {
    const result = h("div", null, "hello", "world") as WorkerVNode;

    assertEquals(result.type, "vnode");
    assertEquals(result.name, "div");
    assertEquals(result.children, ["hello", "world"]);
  });

  await t.step("flattens nested children arrays", () => {
    const result = h("div", null, ["a", "b"], "c") as WorkerVNode;

    assertEquals(result.children, ["a", "b", "c"]);
  });

  await t.step("handles numeric children", () => {
    const result = h("div", null, 42, 0, -1) as WorkerVNode;

    assertEquals(result.children, [42, 0, -1]);
  });

  await t.step("handles mixed children types", () => {
    const child = h("span", null, "nested") as WorkerVNode;
    const result = h("div", null, "text", child, 42) as WorkerVNode;

    assertEquals(result.children.length, 3);
    assertEquals(result.children[0], "text");
    assertEquals((result.children[1] as WorkerVNode).name, "span");
    assertEquals(result.children[2], 42);
  });
});

Deno.test("h - fragment support", async (t) => {
  await t.step("creates a fragment via h.fragment", () => {
    const result = h.fragment({ children: ["a", "b", "c"] });

    assertEquals(result.type, "vnode");
    assertEquals(result.name, FRAGMENT_ELEMENT);
    assertEquals(result.children, ["a", "b", "c"]);
  });
});

Deno.test("h - component functions", async (t) => {
  await t.step("calls component function with props", () => {
    const MyComponent = (props: { name: string }) => {
      return h("div", null, `Hello ${props.name}`) as WorkerVNode;
    };

    const result = h(MyComponent, { name: "World" }) as WorkerVNode;

    assertEquals(result.type, "vnode");
    assertEquals(result.name, "div");
    assertEquals(result.children, ["Hello World"]);
  });

  await t.step("passes children to component function", () => {
    const Container = (props: { children?: WorkerRenderNode[] }) => {
      return h("div", { className: "container" }, ...(props.children ?? []));
    };

    const result = h(Container, null, "child1", "child2") as WorkerVNode;

    assertEquals(result.name, "div");
    assertEquals(result.props, { className: "container" });
    assertEquals(result.children, ["child1", "child2"]);
  });
});

Deno.test("h - $prop validation", async (t) => {
  await t.step("throws for non-reactive $value binding", () => {
    assertThrows(
      () => h("ct-input", { $value: "not-reactive" }),
      Error,
      "Bidirectionally bound property $value is not reactive",
    );
  });

  await t.step("throws for non-reactive $checked binding", () => {
    assertThrows(
      () => h("ct-checkbox", { $checked: false }),
      Error,
      "Bidirectionally bound property $checked is not reactive",
    );
  });

  await t.step("throws for null $prop binding", () => {
    assertThrows(
      () => h("ct-input", { $value: null }),
      Error,
      "Bidirectionally bound property $value is not reactive",
    );
  });

  await t.step("throws for object that is not Cell or CellResult", () => {
    assertThrows(
      () => h("ct-input", { $value: { notACell: true } }),
      Error,
      "Bidirectionally bound property $value is not reactive",
    );
  });
});

Deno.test("h - utility functions", async (t) => {
  await t.step("isEventHandler identifies functions", () => {
    assertEquals(isEventHandler(() => {}), true);
    assertEquals(isEventHandler(function () {}), true);
    assertEquals(isEventHandler("string"), false);
    assertEquals(isEventHandler(42), false);
    assertEquals(isEventHandler(null), false);
    assertEquals(isEventHandler({}), false);
  });

  await t.step("isEventProp identifies event props", () => {
    assertEquals(isEventProp("onClick"), true);
    assertEquals(isEventProp("onMouseMove"), true);
    assertEquals(isEventProp("onChange"), true);
    assertEquals(isEventProp("onCustomEvent"), true);
    assertEquals(isEventProp("on"), false); // Too short
    // Note: isEventProp only checks prefix "on" and length > 2
    // it doesn't enforce camelCase
    assertEquals(isEventProp("onclick"), true);
    assertEquals(isEventProp("className"), false);
    assertEquals(isEventProp("$value"), false);
  });

  await t.step("getEventType extracts event type", () => {
    assertEquals(getEventType("onClick"), "click");
    assertEquals(getEventType("onMouseMove"), "mousemove");
    assertEquals(getEventType("onChange"), "change");
    assertEquals(getEventType("onCustomEvent"), "customevent");
    // Note: getEventType only lowercases if it starts with "on"
    assertEquals(getEventType("notAnEvent"), "notAnEvent");
  });

  await t.step("isBindingProp identifies binding props", () => {
    assertEquals(isBindingProp("$value"), true);
    assertEquals(isBindingProp("$checked"), true);
    assertEquals(isBindingProp("$selectedIndex"), true);
    assertEquals(isBindingProp("value"), false);
    assertEquals(isBindingProp("onClick"), false);
    assertEquals(isBindingProp("className"), false);
  });

  await t.step("getBindingPropName extracts prop name", () => {
    assertEquals(getBindingPropName("$value"), "value");
    assertEquals(getBindingPropName("$checked"), "checked");
    assertEquals(getBindingPropName("$selectedIndex"), "selectedIndex");
    assertEquals(getBindingPropName("value"), "value"); // No $ prefix
  });
});
