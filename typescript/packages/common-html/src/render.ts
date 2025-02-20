import { isVNode } from "./jsx.js";
import {
  effect,
  useCancelGroup,
  type Cancel,
  type Cell,
  isCell,
  isStream,
  Stream,
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
      asCell: true,
    },
  },
} as const;

type Props = {
  [key: string]: string | number | boolean | object | Array<any> | null | Cell<any> | Stream<any>;
};

type VNode = {
  type: "vnode";
  name: string;
  props: Props;
  children: Array<Child> | Cell<Array<Child>>;
};

type Child = VNode | string;

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
  return () => {
    root.remove();
    cancel();
  };
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

const bindChildren = (
  element: HTMLElement,
  children: Array<Child> | Cell<Array<Child>>,
): Cancel => {
  // Mapping from stable key to its rendered node and cancel function.
  let keyedChildren = new Map<string, { node: ChildNode; cancel: Cancel }>();

  // Render a child that can be static or reactive. For reactive cells we update
  // the already-rendered node (using replaceWith) so that we never add an extra
  // container.
  const renderChild = (child: Child, key: string): { node: ChildNode; cancel: Cancel } => {
    if (isCell(child)) {
      let currentNode: ChildNode | null = null;
      const cancel = effect(child, (childValue: any) => {
        let newRendered: { node: ChildNode; cancel: Cancel };
        if (isVNode(childValue)) {
          const [childElement, childCancel] = renderNode(childValue);
          newRendered = {
            node: childElement ?? document.createTextNode(""),
            cancel: childCancel,
          };
        } else {
          if (typeof childValue === "object") {
            console.warn("unexpected object when value was expected", childValue);
            childValue = JSON.stringify(childValue);
          }
          newRendered = {
            node: document.createTextNode(childValue.toString()),
            cancel: () => {},
          };
        }

        if (currentNode) {
          // Replace the previous DOM node, if any
          currentNode.replaceWith(newRendered.node);
          // Update the mapping entry to capture any newly-rendered node.
          keyedChildren.set(key, { ...keyedChildren.get(key)!, node: newRendered.node });
        }

        currentNode = newRendered.node;
        return newRendered.cancel;
      });
      logger.debug("renderChild", child.toJSON());

      return { node: currentNode!, cancel };
    } else {
      if (typeof child === "string" || typeof child === "number" || typeof child === "boolean") {
        return { node: document.createTextNode(child.toString()), cancel: () => {} };
      } else if (isVNode(child)) {
        const [childElement, cancel] = renderNode(child);
        return { node: childElement ?? document.createTextNode(""), cancel };
      } else throw new Error("Unsupported static child type");
    }
  };

  // When the children array changes, diff its flattened values against what we previously rendered.
  const updateChildren = (childrenArr: Array<Child | Array<Child>>) => {
    const newChildren = childrenArr.flat();
    const newKeyOrder: string[] = [];
    const newMapping = new Map<string, { node: ChildNode; cancel: Cancel }>();
    const occurrence = new Map<string, number>();

    for (let i = 0; i < newChildren.length; i++) {
      const child = newChildren[i];
      const rawKey = JSON.stringify(child);
      const count = occurrence.get(rawKey) ?? 0;
      occurrence.set(rawKey, count + 1);
      // Composite key ensures that two structurally identical children get unique keys.
      const key = rawKey + "-" + count;
      newKeyOrder.push(key);
      if (keyedChildren.has(key)) {
        // Reuse an existing rendered node.
        newMapping.set(key, keyedChildren.get(key)!);
        keyedChildren.delete(key);
      } else {
        // Render a new child.
        newMapping.set(key, renderChild(child, key));
      }
    }

    // Remove any obsolete nodes.
    for (const [_, { node, cancel }] of keyedChildren.entries()) {
      cancel();
      node.remove();
    }

    // Now update the parent element so that its children appear in newKeyOrder.
    // We build an array of current DOM nodes to compare by index.
    const domNodes = Array.from(element.childNodes);
    for (let i = 0; i < newKeyOrder.length; i++) {
      const key = newKeyOrder[i];
      const desiredNode = newMapping.get(key)!.node;
      // If there's no node at this position, or it’s different, insert desiredNode there.
      if (domNodes[i] !== desiredNode) {
        // Using domNodes[i] (which may be undefined) is equivalent to appending
        // if there’s no node at that index.
        element.insertBefore(desiredNode, domNodes[i] ?? null);
      }
    }

    logger.debug("new element order", { newKeyOrder });

    keyedChildren = newMapping;
  };

  // Set up a reactive effect so that changes to the children array are diffed and applied.
  const cancelArrayEffect = effect(children, (childrenVal) => updateChildren(childrenVal));

  // Return a cancel function that tears down the effect and cleans up any rendered nodes.
  return () => {
    cancelArrayEffect();
    for (const { node, cancel } of keyedChildren.values()) {
      cancel();
      node.remove();
    }
  };
};

const bindProps = (element: HTMLElement, props: Props): Cancel => {
  const [cancel, addCancel] = useCancelGroup();
  for (const [propKey, propValue] of Object.entries(props)) {
    if (isCell(propValue) || isStream(propValue)) {
      // If prop is an event, we need to add an event listener
      if (isEventProp(propKey)) {
        if (!isStream(propValue)) {
          throw new TypeError(`Event prop "${propKey}" does not have a send method`);
        }
        const key = cleanEventProp(propKey);
        if (key != null) {
          const cancel = listen(element, key, (event) => {
            const sanitizedEvent = sanitizeEvent(event);
            propValue.send(sanitizedEvent);
          });
          addCancel(cancel);
        } else {
          logger.warn("Could not bind event", propKey, propValue);
        }
      } else if (propKey.startsWith("$")) {
        // Properties starting with $ get passed in as raw values, useful for
        // e.g. passing a cell itself instead of its value.
        const key = propKey.slice(1);
        setProp(element, key, propValue);
      } else {
        const cancel = effect(propValue, (replacement) => {
          logger.debug("prop update", propKey, replacement);
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
