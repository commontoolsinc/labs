// This file is exported separately, and uses DOM parsing
// libraries in tests and some CLI utilities.

import * as htmlparser2 from "htmlparser2";
import * as domhandler from "domhandler";
import * as domserializer from "dom-serializer";
import { RenderOptions } from "./render.ts";

/**
 * Converts a React-style CSS object to a CSS string.
 * Supports vendor prefixes, pixel value shorthand, and comprehensive CSS properties.
 * @param styleObject - The style object with React-style camelCase properties
 * @returns A CSS string suitable for the style attribute
 */
const styleObjectToCssString = (styleObject: Record<string, any>): string => {
  return Object.entries(styleObject)
    .map(([key, value]) => {
      // Skip if value is null or undefined
      if (value == null) return "";

      // Convert camelCase to kebab-case, handling vendor prefixes
      let cssKey = key;

      // Handle vendor prefixes (WebkitTransform -> -webkit-transform)
      if (/^(webkit|moz|ms|o)[A-Z]/.test(key)) {
        cssKey = "-" + key;
      }

      // Convert camelCase to kebab-case
      cssKey = cssKey.replace(/([A-Z])/g, "-$1").toLowerCase();

      // Convert value to string
      let cssValue = value;

      // Add 'px' suffix to numeric values for properties that need it
      // Exceptions: properties that accept unitless numbers
      const unitlessProperties = new Set([
        "animation-iteration-count",
        "column-count",
        "fill-opacity",
        "flex-grow",
        "flex-shrink",
        "font-weight",
        "line-height",
        "opacity",
        "order",
        "orphans",
        "stroke-opacity",
        "widows",
        "z-index",
        "zoom",
      ]);

      if (
        typeof value === "number" &&
        !unitlessProperties.has(cssKey) &&
        value !== 0
      ) {
        cssValue = `${value}px`;
      } else {
        cssValue = String(value);
      }

      return `${cssKey}: ${cssValue}`;
    })
    .filter((s) => s !== "")
    .join("; ");
};

function renderOptionsFromDoc(document: globalThis.Document): RenderOptions {
  return {
    document,
    setProp<T>(
      element: T,
      key: string,
      value: unknown,
    ) {
      const el = element as any;

      // Handle style object specially - convert to CSS string
      if (
        key === "style" &&
        el.attribs &&
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value)
      ) {
        const cssString = styleObjectToCssString(value as Record<string, any>);
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
      setAttribute: {
        value(attrName: string, value: string) {
          if (this && (this as any).attribs) {
            // @ts-ignore: domhandler.Element has `attribs`
            (this as Element).attribs[attrName] = value;
          }
        },
      },
      hasAttribute: {
        value(attrName: string) {
          if (this && (this as any).attribs) {
            // @ts-ignore: domhandler.Element has `attribs`
            return attrName in (this as Element).attribs;
          }
          return false;
        },
      },
      removeAttribute: {
        value(attrName: string) {
          if (this && (this as any).attribs) {
            // @ts-ignore: domhandler.Element has `attribs`
            delete (this as Element).attribs[attrName];
          }
        },
      },
      dataset: {
        get() {
          const el = this as any;
          if (!el.attribs) return {};
          const dataset: Record<string, string> = {};
          for (const key in el.attribs) {
            if (key.startsWith("data-")) {
              const dataKey = key.slice(5).replace(
                /-([a-z])/g,
                (_, char) => char.toUpperCase(),
              );
              dataset[dataKey] = el.attribs[key];
            }
          }
          return dataset;
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
