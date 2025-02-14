import { isVNode, VNode, Props, Child } from "./jsx.js";
import {
  effect,
  useCancelGroup,
  type Cancel,
  type Cell,
  isCell,
  isStream,
} from "@commontools/runner";
import { JSONSchema } from "@commontools/builder";
import * as logger from "./logger.js";

const vdomSchema: JSONSchema = {
  type: "object",
  properties: {
    type: { type: "string" },
    name: { type: "string" },
    props: {
      type: "object",
      additionalProperties: { asCell: true },
    },
    children: {
      type: "array",
      items: {
        anyOf: [
          { $ref: "#", asCell: true },
          { type: "string", asCell: true },
          { type: "number", asCell: true },
          { type: "boolean", asCell: true },
          { type: "array", items: { $ref: "#", asCell: true } },
        ],
      },
    },
  },
} as const;

/** Render a view into a parent element */
export const render = (parent: HTMLElement, view: VNode | Cell<VNode>): Cancel => {
  // If this is a reactive cell, ensure the schema is VNode
  if (isCell(view)) view = view.asSchema(vdomSchema);
  return effect(view, (view: VNode) => renderImpl(parent, view));
};

export const renderImpl = (parent: HTMLElement, view: VNode): Cancel => {
  const [root, cancel] = renderNode(view);
  if (!root) {
    logger.warn("Could not render view", view);
    return cancel;
  }
  parent.append(root);
  logger.debug("Rendered", root);
  return cancel;
};

export default render;

const renderNode = (node: VNode): [HTMLElement | null, Cancel] => {
  const [cancel, addCancel] = useCancelGroup();

  const sanitizedNode = sanitizeNode(node);

  if (!sanitizedNode) {
    return [null, cancel];
  }

  const element = document.createElement(sanitizedNode.name);

  const cancelProps = bindProps(element, sanitizedNode.props);
  addCancel(cancelProps);

  const cancelChildren = bindChildren(element, sanitizedNode.children);
  addCancel(cancelChildren);

  return [element, cancel];
};

const bindChildren = (element: HTMLElement, children: Array<Child>): Cancel => {
  const [cancel, addCancel] = useCancelGroup();

  for (const child of children.flat()) {
    if (typeof child === "string" || typeof child === "number" || typeof child === "boolean") {
      // Bind static content
      element.append(child.toString());
    } else if (isVNode(child)) {
      // Bind static VNode
      const [childElement, cancel] = renderNode(child);
      addCancel(cancel);
      if (childElement) {
        element.append(childElement);
      }
    } else if (isCell(child)) {
      // Anchor for reactive replacement
      let anchor: ChildNode = document.createTextNode("");
      element.append(anchor);
      effect(child, (replacement: any) => {
        if (isVNode(replacement)) {
          const [childElement, cancel] = renderNode(replacement);
          addCancel(cancel);
          if (childElement != null) {
            anchor.replaceWith(childElement);
            anchor = childElement;
          } else {
            logger.warn("Could not render view", replacement);
          }
        } else {
          if (typeof replacement === "object") {
            console.warn("unexpected object when value was expected", replacement);
            replacement = JSON.stringify(replacement);
          }
          const text = document.createTextNode(`${replacement}`);
          anchor.replaceWith(text);
          anchor = text;
        }
      });
    }
  }
  return cancel;
};

const bindProps = (element: HTMLElement, props: Props): Cancel => {
  const [cancel, addCancel] = useCancelGroup();
  for (const [propKey, propValue] of Object.entries(props)) {
    if (isCell(propValue) || isStream(propValue)) {
      const replacement = propValue;
      // If prop is an event, we need to add an event listener
      if (isEventProp(propKey)) {
        if (!isStream(replacement)) {
          throw new TypeError(`Event prop "${propKey}" does not have a send method`);
        }
        const key = cleanEventProp(propKey);
        if (key != null) {
          const cancel = listen(element, key, (event) => {
            const sanitizedEvent = sanitizeEvent(event);
            replacement.send(sanitizedEvent);
          });
          addCancel(cancel);
        } else {
          logger.warn("Could not bind event", propKey, propValue);
        }
      } else if (propKey.startsWith("$")) {
        // Properties starting with $ get passed in as raw values, useful for
        // e.g. passing a cell itself instead of its value.
        const key = propKey.slice(1);
        setProp(element, key, replacement);
      } else {
        const cancel = effect(replacement, (replacement) => {
          // Replacements are set as properties not attributes to avoid
          // string serialization of complex datatypes.
          setProp(element, propKey, replacement);
        });
        addCancel(cancel);
      }
    } else {
      setProp(element, propKey, propValue);
    }
  }
  return cancel;
};

const isEventProp = (key: string) => key.startsWith("on");

const cleanEventProp = (key: string) => {
  if (!key.startsWith("on")) {
    return null;
  }
  return key.slice(2);
};

/** Attach an event listener, returning a function to cancel the listener */
const listen = (element: HTMLElement, key: string, callback: (event: Event) => void) => {
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

const sanitizeScripts = (node: VNode): VNode | null => {
  if (node.name === "script") {
    return null;
  }
  return node;
};

let sanitizeNode = sanitizeScripts;

export const setNodeSanitizer = (fn: (node: VNode) => VNode | null) => {
  sanitizeNode = fn;
};

export type EventSanitizer<T> = (event: Event) => T;

const passthroughEvent: EventSanitizer<Event> = (event: Event): Event => event;

let sanitizeEvent: EventSanitizer<unknown> = passthroughEvent;

export const setEventSanitizer = (sanitize: EventSanitizer<unknown>) => {
  sanitizeEvent = sanitize;
};
