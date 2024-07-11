import { isNode, Node } from "./node.js";
import { Renderable, Context, isRenderable } from "./html.js";
import { isHole } from "./hole.js";
import { effect } from "./reactive.js";
import { useCancelGroup, Cancel } from "./cancel.js";

export type CancellableHTMLElement = HTMLElement & { cancel?: Cancel };

export const render = (renderable: Renderable): HTMLElement => {
  const { template, context } = renderable;
  const [cancel, addCancel] = useCancelGroup();
  const root = renderNode(
    template,
    context,
    addCancel
  ) as CancellableHTMLElement;
  root.cancel = cancel;
  return root;
};

export default render;

const renderNode = (
  node: Node,
  context: Context,
  addCancel: (cancel: Cancel) => void
): HTMLElement | null => {
  const sanitizedNode = sanitizeNode(node);
  if (!sanitizedNode) {
    return null;
  }
  const element = document.createElement(sanitizedNode.tag);
  for (const [name, value] of Object.entries(sanitizedNode.attrs)) {
    if (isHole(value)) {
      const replacement = context[value.name];
      const cancel = effect(replacement, (replacement) => {
        // Replacements are set as properties not attributes to avoid
        // string serialization of complex datatypes.
        setProp(element, name, replacement);
      });
      addCancel(cancel);
    } else {
      element.setAttribute(name, value);
    }
  }
  for (const childNode of sanitizedNode.children) {
    if (typeof childNode === "string") {
      element.append(childNode);
    } else if (isNode(childNode)) {
      const childElement = renderNode(childNode, context, addCancel);
      if (childElement) {
        element.append(childElement);
      }
    } else if (isHole(childNode)) {
      const replacement = context[childNode.name];
      // Anchor for reactive replacement
      let anchor: ChildNode = document.createTextNode("");
      element.append(anchor);
      const cancel = effect(replacement, (replacement) => {
        if (isRenderable(replacement)) {
          const childElement = render(replacement);
          anchor.replaceWith(childElement);
          anchor = childElement;
        } else {
          const text = document.createTextNode(`${replacement}`);
          anchor.replaceWith(text);
          anchor = text;
        }
      });
      addCancel(cancel);
    }
  }
  return element;
};

const setProp = (element: HTMLElement, key: string, value: unknown) => {
  // @ts-ignore - we've validated these via runtime checks
  element[key] = value;
};

const sanitizeScripts = (node: Node): Node | null => {
  if (node.tag === "script") {
    return null;
  }
  return node;
};

let sanitizeNode = sanitizeScripts;

export const setSanitizer = (fn: (node: Node) => Node | null) => {
  sanitizeNode = fn;
};
