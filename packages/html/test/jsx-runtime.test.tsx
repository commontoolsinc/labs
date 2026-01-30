/**
 * Tests for the JSX automatic runtime
 *
 * These tests verify that @commontools/html can be used as a JSX runtime
 * compatible with TypeScript's "jsx": "react-jsx" configuration.
 */

import { describe, it } from "@std/testing/bdd";
import * as assert from "./assert.ts";

// Note: To properly test the automatic JSX runtime, this file should be
// compiled with jsxImportSource set to "@commontools/html"
// However, for this test to work with the current deno.jsonc configuration,
// we'll import the functions directly and verify they work correctly.

import { Fragment, jsx, jsxs } from "../src/jsx-runtime.ts";

describe("JSX automatic runtime", () => {
  it("jsx() creates a simple element", () => {
    const element = jsx("div", { className: "test" });

    assert.matchObject(element, {
      type: "vnode",
      name: "div",
      props: { className: "test" },
      children: [],
    });
  });

  it("jsx() creates an element with children", () => {
    const element = jsx("div", {
      children: [jsx("p", { children: "Hello" })],
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

  it("jsx() creates an element with a single child", () => {
    const element = jsx("div", {
      children: "Hello",
    });

    assert.matchObject(element, {
      type: "vnode",
      name: "div",
      children: ["Hello"],
    });
  });

  it("jsx() handles null props", () => {
    const element = jsx("div", null);

    assert.matchObject(element, {
      type: "vnode",
      name: "div",
      props: {},
      children: [],
    });
  });

  it("jsx() accepts a key parameter", () => {
    // The key parameter is accepted but currently not stored in VNode
    const element = jsx("li", { children: "Item 1" }, "item-1");

    assert.matchObject(element, {
      type: "vnode",
      name: "li",
      children: ["Item 1"],
    });
  });

  it("jsxs() works identically to jsx()", () => {
    const element = jsxs("ul", {
      children: [
        jsx("li", { children: "Item 1" }),
        jsx("li", { children: "Item 2" }),
      ],
    });

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

  it("jsx() handles component functions", () => {
    const MyComponent = ({ name }: { name: string }) =>
      jsx("div", { children: `Hello, ${name}` });

    const element = jsx(MyComponent, { name: "World" });

    assert.matchObject(element, {
      type: "vnode",
      name: "div",
      children: ["Hello, World"],
    });
  });

  it("Fragment creates a ct-fragment element", () => {
    const fragment = Fragment({
      children: [
        jsx("p", { children: "Paragraph 1" }),
        jsx("p", { children: "Paragraph 2" }),
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

  it("jsx() with complex nested structure", () => {
    const element = jsx("div", {
      className: "container",
      children: [
        jsx("h1", { children: "Title" }),
        jsx("p", { children: "Description" }),
        jsx("ul", {
          children: [
            jsx("li", { children: "Item 1" }),
            jsx("li", { children: "Item 2" }),
          ],
        }),
      ],
    });

    assert.matchObject(element, {
      type: "vnode",
      name: "div",
      props: { className: "container" },
      children: [
        {
          type: "vnode",
          name: "h1",
          children: ["Title"],
        },
        {
          type: "vnode",
          name: "p",
          children: ["Description"],
        },
        {
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
        },
      ],
    });
  });
});
