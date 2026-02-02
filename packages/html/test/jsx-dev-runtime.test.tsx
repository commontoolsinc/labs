/**
 * Tests for the JSX development runtime
 *
 * These tests verify that @commontools/html provides a development runtime
 * compatible with TypeScript's "jsx": "react-jsxdev" configuration.
 */

import { describe, it } from "@std/testing/bdd";
import * as assert from "./assert.ts";

import { Fragment, jsxDEV } from "../src/jsx-dev-runtime.ts";

describe("JSX development runtime", () => {
  it("jsxDEV() creates a simple element", () => {
    const element = jsxDEV("div", { className: "test" });

    assert.matchObject(element, {
      type: "vnode",
      name: "div",
      props: { className: "test" },
      children: [],
    });
  });

  it("jsxDEV() creates an element with children", () => {
    const element = jsxDEV("div", {
      children: [jsxDEV("p", { children: "Hello" })],
    });

    assert.matchObject(element, {
      type: "vnode",
      name: "div",
      children: [
        {
          type: "vnode",
          name: "p",
          children: ["Hello"],
        },
      ],
    });
  });

  it("jsxDEV() accepts debug parameters", () => {
    const element = jsxDEV(
      "div",
      { children: "Test" },
      "test-key",
      false,
      {
        fileName: "test.tsx",
        lineNumber: 42,
        columnNumber: 10,
      },
      undefined,
    );

    assert.matchObject(element, {
      type: "vnode",
      name: "div",
      children: ["Test"],
    });
  });

  it("jsxDEV() handles null props", () => {
    const element = jsxDEV("div", null);

    assert.matchObject(element, {
      type: "vnode",
      name: "div",
      props: {},
      children: [],
    });
  });

  it("jsxDEV() handles component functions", () => {
    const MyComponent = ({ name }: { name: string }) =>
      jsxDEV("div", { children: `Hello, ${name}` });

    const element = jsxDEV(MyComponent, { name: "World" });

    assert.matchObject(element, {
      type: "vnode",
      name: "div",
      children: ["Hello, World"],
    });
  });

  it("Fragment creates a ct-fragment element", () => {
    const fragment = Fragment({
      children: [
        jsxDEV("p", { children: "Paragraph 1" }),
        jsxDEV("p", { children: "Paragraph 2" }),
      ],
    });

    assert.matchObject(fragment, {
      type: "vnode",
      name: "ct-fragment",
      children: [
        {
          type: "vnode",
          name: "p",
          children: ["Paragraph 1"],
        },
        {
          type: "vnode",
          name: "p",
          children: ["Paragraph 2"],
        },
      ],
    });
  });

  it("jsxDEV() with static children flag", () => {
    const element = jsxDEV(
      "ul",
      {
        children: [
          jsxDEV("li", { children: "Item 1" }),
          jsxDEV("li", { children: "Item 2" }),
        ],
      },
      undefined,
      true, // isStaticChildren
    );

    assert.matchObject(element, {
      type: "vnode",
      name: "ul",
      children: [
        {
          type: "vnode",
          name: "li",
          children: ["Item 1"],
        },
        {
          type: "vnode",
          name: "li",
          children: ["Item 2"],
        },
      ],
    });
  });
});
