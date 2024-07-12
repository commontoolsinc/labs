import { isNode, Node } from "./node.js";
import { Renderable, Context, isRenderable } from "./html.js";
import { isHole } from "./hole.js";
import { effect } from "./reactive.js";
import { isSendable } from "./sendable.js";
import { useCancelGroup, Cancel } from "./cancel.js";
import * as logger from "./logger.js";

export type CancellableHTMLElement = HTMLElement & { cancel?: Cancel };

export const render = (renderable: Renderable): HTMLElement => {
  const { template, context } = renderable;
  const [cancel, addCancel] = useCancelGroup();
  const root = renderNode(
    template,
    context,
    addCancel,
  ) as CancellableHTMLElement;
  root.cancel = cancel;
  logger.debug("Rendered", root);
  return root;
};

export default render;

const renderNode = (
  node: Node,
  context: Context,
  addCancel: (cancel: Cancel) => void,
): HTMLElement | null => {
  const sanitizedNode = sanitizeNode(node);
  if (!sanitizedNode) {
    return null;
  }
  const element = document.createElement(sanitizedNode.tag);
  attrs: for (const [name, value] of Object.entries(sanitizedNode.attrs)) {
    if (isHole(value)) {
      const replacement = context[value.name];
      // If prop is an event, we need to add an event listener
      if (isEventProp(name)) {
        if (!isSendable(replacement)) {
          throw new TypeError(
            `Event prop "${name}" does not have a send method`,
          );
        }
        const key = cleanEventProp(name);
        const cancel = listen(element, key, (event) => {
          const sanitizedEvent = sanitizeEvent(event);
          replacement.send(sanitizedEvent);
        });
        addCancel(cancel);
      } else {
        const cancel = effect(replacement, (replacement) => {
          // Replacements are set as properties not attributes to avoid
          // string serialization of complex datatypes.
          setProp(element, name, replacement);
        });
        addCancel(cancel);
      }
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

const isEventProp = (key: string) => key.startsWith("on");

const cleanEventProp = (key: string) => {
  if (!key.startsWith("on")) {
    return null;
  }
  return key.slice(2);
};

/** Attach an event listener, returning a function to cancel the listener */
const listen = (
  element: HTMLElement,
  key: string,
  callback: (event: Event) => void,
) => {
  element.addEventListener(key, callback);
  return () => {
    element.removeEventListener(key, callback);
  };
};

const setProp = <T>(target: T, key: string, value: unknown) => {
  // @ts-ignore - we've validated these via runtime checks
  if (target[key] !== value) {
    // @ts-ignore - we've validated these via runtime checks
    target[key] = value;
  }
};

const sanitizeScripts = (node: Node): Node | null => {
  if (node.tag === "script") {
    return null;
  }
  return node;
};

let sanitizeNode = sanitizeScripts;

export const setNodeSanitizer = (fn: (node: Node) => Node | null) => {
  sanitizeNode = fn;
};

export type EventSanitizer<T> = (event: Event) => T;

const passthroughEvent: EventSanitizer<Event> = (event: Event): Event => event;

let sanitizeEvent: EventSanitizer<unknown> = passthroughEvent;

export const setEventSanitizer = (sanitize: EventSanitizer<unknown>) => {
  sanitizeEvent = sanitize;
};
