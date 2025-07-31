import { isObject } from "@commontools/utils/types";
import {
  type Cancel,
  type Cell,
  convertCellsToLinks,
  effect,
  isCell,
  isStream,
  type JSONSchema,
  UI,
  useCancelGroup,
} from "@commontools/runner";
import { type Child, isVNode, type Props, type VNode } from "./jsx.ts";
import * as logger from "./logger.ts";

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
    [UI]: { $ref: "#" },
  },
} as const;

/**
 * Renders a view into a parent element, supporting both static VNodes and reactive cells.
 * @param parent - The HTML element to render into
 * @param view - The VNode or reactive cell containing a VNode to render
 * @returns A cancel function to clean up the rendering
 */
export const render = (
  parent: HTMLElement,
  view: VNode | Cell<VNode>,
): Cancel => {
  // If this is a reactive cell, ensure the schema is VNode
  if (isCell(view)) view = view.asSchema(vdomSchema);
  return effect(view, (view: VNode) => renderImpl(parent, view));
};

/**
 * Internal implementation that renders a VNode into a parent element.
 * @param parent - The HTML element to render into
 * @param view - The VNode to render
 * @returns A cancel function to remove the rendered content
 */
export const renderImpl = (parent: HTMLElement, view: VNode): Cancel => {
  // If there is no valid vnode, don't render anything
  if (!isVNode(view)) {
    logger.debug("No valid vnode to render", view);
    return () => {};
  }
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

  // Follow `[UI]` to actual vdom. Do this before otherwise parsing the vnode,
  // so that if there are both, the `[UI]` annotation takes precedence (avoids
  // accidental collision with the otherwise quite generic property names)
  while (node[UI]) node = node[UI];

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
  const renderChild = (
    child: Child,
    key: string,
  ): { node: ChildNode; cancel: Cancel } => {
    let currentNode: ChildNode | null = null;
    const cancel = effect(child, (childValue: any) => {
      let newRendered: { node: ChildNode; cancel: Cancel };
      if (isVNode(childValue)) {
        const [childElement, childCancel] = renderNode(childValue);
        newRendered = {
          node: childElement ?? document.createTextNode(""),
          cancel: childCancel ?? (() => {}),
        };
      } else {
        if (childValue === null || childValue === undefined) {
          childValue = "";
        } else if (typeof childValue === "object") {
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
        keyedChildren.get(key)?.cancel();
        // Update the mapping entry to capture any newly-rendered node.
        keyedChildren.set(key, {
          ...keyedChildren.get(key)!,
          ...newRendered,
        });
      }

      currentNode = newRendered.node;
      return newRendered.cancel;
    });

    return { node: currentNode!, cancel };
  };

  // When the children array changes, diff its flattened values against what we previously rendered.
  const updateChildren = (
    childrenArr: Array<Child | Array<Child>> | undefined | null,
  ) => {
    const newChildren = Array.isArray(childrenArr) ? childrenArr.flat() : [];
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
  const cancelArrayEffect = effect(
    children,
    (childrenVal) => updateChildren(childrenVal),
  );

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
  return key.slice(2).toLowerCase();
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

const sanitizeScripts = (node: VNode): VNode | null => {
  if (node.name === "script") {
    return null;
  }
  if (!isCell(node.props) && !isObject(node.props)) {
    node = { ...node, props: {} };
  }
  if (!isCell(node.children) && !Array.isArray(node.children)) {
    node = { ...node, children: [] };
  }

  return node;
};

let sanitizeNode = sanitizeScripts;

export const setNodeSanitizer = (fn: (node: VNode) => VNode | null) => {
  sanitizeNode = fn;
};

export type EventSanitizer<T> = (event: Event) => T;

export const passthroughEvent: EventSanitizer<Event> = (event: Event): Event =>
  event;

const allowListedEventProperties = [
  "type", // general
  "key", // keyboard event
  "code", // keyboard event
  "repeat", // keyboard event
  "altKey", // keyboard & mouse event
  "ctrlKey", // keyboard & mouse event
  "metaKey", // keyboard & mouse event
  "shiftKey", // keyboard & mouse event
  "inputType", // input event
  "data", // input event
  "button", // mouse event
  "buttons", // mouse event
];

const allowListedEventTargetProperties = [
  "name", // general input
  "value", // general input
  "checked", // checkbox
  "selected", // option
  "selectedIndex", // select
];

/**
 * Sanitize an event so it can be serialized.
 *
 * NOTE: This isn't yet vetted for security, it's just a coarse first pass with
 * the primary objective of making events serializable.
 *
 * E.g. one glaring omission is that this can leak data via bubbling and we
 * should sanitize quite differently if the target isn't the same as
 * eventTarget.
 *
 * This code also doesn't make any effort to only copy properties that are
 * allowed on various event types, or otherwise tailor sanitization to the event
 * type.
 *
 * @param event - The event to sanitize.
 * @returns The serializable event.
 */
export function serializableEvent<T>(event: Event): T {
  const eventObject: Record<string, any> = {};
  for (const property of allowListedEventProperties) {
    eventObject[property] = event[property as keyof Event];
  }

  const targetObject: Record<string, any> = {};
  for (const property of allowListedEventTargetProperties) {
    targetObject[property] = event.target?.[property as keyof EventTarget];
  }
  if (
    event.target instanceof HTMLSelectElement && event.target.selectedOptions
  ) {
    // To support multiple selections, we create serializable option elements
    targetObject.selectedOptions = Array.from(event.target.selectedOptions).map(
      (option) => ({ value: option.value }),
    );
  }
  if (Object.keys(targetObject).length > 0) eventObject.target = targetObject;

  if ((event as CustomEvent).detail !== undefined) {
    // Could be anything, but should only come from our own custom elements.
    // Step below will remove any direct references.
    eventObject.detail = (event as CustomEvent).detail;
  }

  return convertCellsToLinks(eventObject) as T;
}

let sanitizeEvent: EventSanitizer<unknown> = serializableEvent;

export const setEventSanitizer = (sanitize: EventSanitizer<unknown>) => {
  sanitizeEvent = sanitize;
};
