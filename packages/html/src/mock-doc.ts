// This file is exported separately, and uses DOM parsing
// libraries in tests and some CLI utilities.

import * as htmlparser2 from "htmlparser2";
import * as domhandler from "domhandler";
import * as domserializer from "dom-serializer";
import { RenderOptions } from "./render.ts";
import { styleObjectToCssString } from "./render-utils.ts";

type StyleObject = Record<string, unknown>;

const eventListeners = new WeakMap<
  object,
  Map<string, Array<(event: unknown) => void>>
>();

function isDomElement(node: unknown): node is domhandler.Element {
  return node instanceof domhandler.Element;
}

function getNodeEventListeners(node: object) {
  let listeners = eventListeners.get(node);
  if (!listeners) {
    listeners = new Map<string, Array<(event: unknown) => void>>();
    eventListeners.set(node, listeners);
  }
  return listeners;
}

function renderOptionsFromDoc(document: globalThis.Document): RenderOptions {
  return {
    document,
    setProp<T>(
      element: T,
      key: string,
      value: unknown,
    ) {
      const el = element as domhandler.Element;

      // Handle style object specially - convert to CSS string
      if (
        key === "style" &&
        el.attribs &&
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value)
      ) {
        const cssString = styleObjectToCssString(value as StyleObject);
        el.attribs["style"] = cssString;
        return;
      }

      // Handle data-* attributes specially - they need to be set as HTML attributes
      // to populate the dataset property correctly
      if (key.startsWith("data-") && el.attribs) {
        // If value is null or undefined, remove the attribute
        if (value == null) {
          if (key in el.attribs) {
            delete el.attribs[key];
          }
        } else {
          el.attribs[key] = String(value);
        }
        return;
      }

      // For non-data attributes, use the existing logic
      let attrValue;
      if (typeof value === "string") {
        attrValue = value;
      } else if (Array.isArray(value)) {
        attrValue = `[${Array(`${value.length}`)}]`;
      } else if (typeof value === "object") {
        // for objects, JSON.stringify is unruly -- just render
        // as a "[binding]".
        attrValue = "[binding]";
      } else {
        attrValue = `${value}`;
      }
      if (!el.attribs[key]) {
        el.attribs[key] = attrValue;
      }
    },
  };
}

export class MockDoc {
  document: globalThis.Document;
  renderOptions: RenderOptions;
  constructor(html: string) {
    const { DomUtils, DomHandler, Parser } = htmlparser2;
    const handler = new DomHandler();
    const parser = new Parser(handler);
    parser.end(html);

    // Extend `Node` types with self manipulation functionality
    // used by the renderer.
    const nodeExt = {
      remove: {
        value(this: domhandler.ChildNode) {
          return DomUtils.removeElement(this);
        },
      },
      replaceWith: {
        value(this: domhandler.ChildNode, newNode: domhandler.ChildNode) {
          return DomUtils.replaceElement(this, newNode);
        },
      },
      innerHTML: {
        get(this: domhandler.ParentNode) {
          return domserializer.render(this.children);
        },
        set(this: domhandler.ParentNode, value: string) {
          if (value !== "") {
            throw new Error(
              "Only the empty string is supported when setting innerHTML.",
            );
          }
          const children = DomUtils.getChildren(this);
          for (const child of children) {
            DomUtils.removeElement(child);
          }
        },
      },
    };

    // Extend `NodeWithChildren` types with query and manipulation functionality
    // used by the renderer.
    const nodeWithChildrenExt = {
      getElementsByTagName: {
        value(this: domhandler.ParentNode, tagName: string) {
          return DomUtils.getElementsByTagName(tagName, this.children, true);
        },
      },
      append: {
        value(this: domhandler.ParentNode, nodeOrText: domhandler.ChildNode) {
          return DomUtils.appendChild(this, nodeOrText);
        },
      },
      appendChild: {
        value(this: domhandler.ParentNode, nodeOrText: domhandler.ChildNode) {
          return DomUtils.appendChild(this, nodeOrText);
        },
      },
      insertBefore: {
        value(
          this: domhandler.ParentNode,
          child: domhandler.ChildNode,
          ref: domhandler.ChildNode | null,
        ) {
          return ref !== null
            ? DomUtils.prepend(ref, child)
            : DomUtils.appendChild(this, child);
        },
      },
      getAttribute: {
        value(this: domhandler.ParentNode, attrName: string) {
          if (isDomElement(this)) {
            return this.attribs[attrName];
          }
        },
      },
      setAttribute: {
        value(
          this: domhandler.ParentNode,
          attrName: string,
          value: string,
        ) {
          if (isDomElement(this)) {
            this.attribs[attrName] = value;
          }
        },
      },
      hasAttribute: {
        value(this: domhandler.ParentNode, attrName: string) {
          if (isDomElement(this)) {
            return attrName in this.attribs;
          }
          return false;
        },
      },
      removeAttribute: {
        value(this: domhandler.ParentNode, attrName: string) {
          if (isDomElement(this)) {
            delete this.attribs[attrName];
          }
        },
      },
      dataset: {
        get(this: domhandler.ParentNode) {
          if (!isDomElement(this)) return {};
          const dataset: Record<string, string> = {};
          for (const key in this.attribs) {
            if (key.startsWith("data-")) {
              const dataKey = key.slice(5).replace(
                /-([a-z])/g,
                (_, char) => char.toUpperCase(),
              );
              dataset[dataKey] = this.attribs[key];
            }
          }
          return dataset;
        },
      },
      addEventListener: {
        value(type: string, listener: (event: unknown) => void) {
          const listeners = getNodeEventListeners(this as object);
          const existing = listeners.get(type) ?? [];
          existing.push(listener);
          listeners.set(type, existing);
        },
      },
      removeEventListener: {
        value(type: string, listener: (event: unknown) => void) {
          const listeners = getNodeEventListeners(this as object).get(type);
          if (!listeners) return;
          const index = listeners.indexOf(listener);
          if (index >= 0) {
            listeners.splice(index, 1);
          }
        },
      },
      dispatchEvent: {
        value(event: { type?: string }) {
          if (!event?.type) return;
          const listeners = getNodeEventListeners(this as object).get(
            event.type,
          ) ?? [];
          for (const listener of [...listeners]) {
            listener(event);
          }
        },
      },
    };

    // Extend `Document` with element creation methods
    // used by the renderer.
    const docExt = {
      body: {
        get(this: domhandler.Document) {
          return DomUtils.getElementsByTagName("body", this.children, true)[0];
        },
      },
      createElement: {
        value(
          name: string,
          options?: { [name: string]: string },
        ) {
          return new domhandler.Element(name, options ?? {});
        },
      },
      createTextNode: {
        value(text: string) {
          return new domhandler.Text(text);
        },
      },
      getElementById: {
        value(this: domhandler.Document, id: string) {
          return DomUtils.getElementById(id, this, true);
        },
      },
    };

    if (!("remove" in domhandler.Node.prototype)) {
      Object.defineProperties(domhandler.Node.prototype, nodeExt);
    }
    if (!("textContent" in domhandler.Text.prototype)) {
      Object.defineProperties(domhandler.Text.prototype, {
        textContent: {
          get() {
            return (this as domhandler.Text).data;
          },
          set(value: string) {
            (this as domhandler.Text).data = value;
          },
        },
        nodeValue: {
          get() {
            return (this as domhandler.Text).data;
          },
          set(value: string) {
            (this as domhandler.Text).data = value;
          },
        },
      });
    }
    if (!("getElementsByTagName" in domhandler.NodeWithChildren.prototype)) {
      Object.defineProperties(
        domhandler.NodeWithChildren.prototype,
        nodeWithChildrenExt,
      );
    }
    if (!("createElement" in domhandler.Document.prototype)) {
      Object.defineProperties(domhandler.Document.prototype, docExt);
    }

    // @ts-ignore: Force this to type as a web Document.
    this.document = handler.root as globalThis.Document;
    this.renderOptions = renderOptionsFromDoc(this.document);
  }
}
