import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  ensurePendingRenderStyles,
  PENDING_RENDER_STYLES,
  setPendingRenderState,
} from "../src/pending-render.ts";

Deno.test("pending render state marks retained content inert and busy", () => {
  const attributes = new Map<string, string>();
  const element = {
    setAttribute: (name: string, value: string) => attributes.set(name, value),
    removeAttribute: (name: string) => attributes.delete(name),
  } as unknown as Node;

  setPendingRenderState(element, true);
  assertEquals(attributes.get("data-cf-pending"), "true");
  assertEquals(attributes.get("inert"), "");
  assertEquals(attributes.get("aria-busy"), "true");

  setPendingRenderState(element, false);
  assertEquals(attributes.size, 0);
});

Deno.test("pending render styles install once in the active shadow root", () => {
  const styles: Array<{
    attributes: Map<string, string>;
    textContent: string;
  }> = [];
  const root = {
    nodeType: 11,
    querySelector: () =>
      styles.find((style) => style.attributes.has("data-cf-pending-styles")),
    appendChild: (style: (typeof styles)[number]) => styles.push(style),
  };
  const container = {
    getRootNode: () => root,
  } as unknown as HTMLElement;
  const document = {
    createElement: () => {
      const attributes = new Map<string, string>();
      return {
        attributes,
        textContent: "",
        setAttribute: (name: string, value: string) =>
          attributes.set(name, value),
      };
    },
  } as unknown as Document;

  ensurePendingRenderStyles(container, document);
  ensurePendingRenderStyles(container, document);

  assertEquals(styles.length, 1);
  assertEquals(styles[0].textContent, PENDING_RENDER_STYLES);
  assertStringIncludes(styles[0].textContent, "grayscale");
});

Deno.test("pending render styles tolerate a document without a style host", () => {
  let created = false;
  const root = {
    nodeType: 9,
    head: null,
    documentElement: null,
    querySelector: () => null,
  };
  const container = {
    getRootNode: () => root,
  } as unknown as HTMLElement;
  const document = {
    createElement: () => {
      created = true;
      return {};
    },
  } as unknown as Document;

  ensurePendingRenderStyles(container, document);

  assertEquals(created, false);
});
