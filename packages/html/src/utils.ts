// This file is exported separately, and uses DOM parsing
// libraries in tests and some CLI utilities.

import * as htmlparser2 from "htmlparser2";
import * as domhandler from "domhandler";
import * as domserializer from "dom-serializer";
import { RenderOptions } from "./render.ts";

function renderOptionsFromDoc(document: globalThis.Document): RenderOptions {
  return {
    document,
    setProp<T>(
      element: T,
      key: string,
      value: unknown,
    ) {
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
      const el = element as domhandler.Element;
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
        value() {
          return DomUtils.removeElement(this as any);
        },
      },
      innerHTML: {
        get() {
          return domserializer.render((this as any).children);
        },
      },
    };

    // Extend `NodeWithChildren` types with query and manipulation functionality
    // used by the renderer.
    const nodeWithChildrenExt = {
      getElementsByTagName: {
        value(tagName: string) {
          // @ts-ignore: Cast to Node, we only
          // want to query the children, do not match `this`.
          const node = this as domhandler.NodeWithChildren;
          return DomUtils.getElementsByTagName(tagName, node.children, true);
        },
      },
      append: {
        value(nodeOrText: any) {
          return DomUtils.appendChild(this as any, nodeOrText);
        },
      },
      appendChild: {
        value(nodeOrText: any) {
          return DomUtils.appendChild(this as any, nodeOrText);
        },
      },
      insertBefore: {
        value(child: any, ref: any | null) {
          return ref !== null
            ? DomUtils.prepend(ref, child)
            : DomUtils.appendChild(this as any, child);
        },
      },
      getAttribute: {
        value(attrName: string) {
          if (this && (this as any).attribs) {
            // @ts-ignore: domhandler.Element has `attribs`
            return (this as Element).attribs[attrName];
          }
        },
      },
    };

    // Extend `Document` with element creation methods
    // used by the renderer.
    const docExt = {
      body: {
        get() {
          // @ts-ignore: domhandler.Document is also a domhandler.Node
          return (this as domhandler.Node).getElementsByTagName("body")[0];
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
        value(id: string) {
          return DomUtils.getElementById(id, this as any, true);
        },
      },
    };

    if (!("remove" in domhandler.Node.prototype)) {
      Object.defineProperties(domhandler.Node.prototype, nodeExt);
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
