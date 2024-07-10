import memoize from "./memoize.js";
import { noOp } from "./util.js";
import { debug, warn } from "./log.js";
import { useCancelGroup, Cancel, Cancellable } from "./cancel.js";
import { Template, TemplateContext, isTemplate } from "./html.js";
import { effect } from "./reactive.js";
import { isSendable } from "./sendable.js";

export { setDebug } from "./log.js";

/** Render template with replacements */
export const render = (tpl: Template) => {
  if (!isTemplate(tpl)) {
    throw new TypeError(`Expected a template object`);
  }

  const { template, context } = tpl;

  // Create a cancel bag for gathering cancels related to reactive
  // bindings on this element.
  const [cancelAll, addCancel] = useCancelGroup();

  // Render cached string to template
  const templateElement = getCachedTemplate(flattenTemplate(template));
  const root = cloneTemplateElement(templateElement) as CancellableElement;
  root.cancel = cancelAll;

  for (const node of walkElementAndTextNodes(root)) {
    if (node.nodeType === Node.ELEMENT_NODE) {
      const element = node as Element;

      // Prune disallowed elements
      if (!isElementAllowed(element)) {
        debug(`Element not allowed`, element);
        element.remove();
        continue;
      }

      // Capture attrs, since we're about to modify them during iteration.
      const attrs = Array.from(element.attributes);
      for (const attr of attrs) {
        if (isPropKey(attr.name)) {
          const cancel = bindProp(element, attr.name, attr.value, context);
          addCancel(cancel);
        } else if (isEventKey(attr.name)) {
          const cancel = bindEvent(element, attr.name, attr.value, context);
          addCancel(cancel);
        } else {
          const cancel = bindAttr(element, attr.name, attr.value, context);
          addCancel(cancel);
        }
      }
    } else if (node.nodeType === Node.TEXT_NODE) {
      const cancel = bindContent(node, context);
      addCancel(cancel);
    }
  }
  debug("Rendered template", root);
  return root;
};

export type CancellableElement = Element & Cancellable;

const alwaysAllow = () => true;

export type ElementSanitizer = (node: Element) => boolean;

export type PropSanitizer = (
  node: Node,
  key: string,
  value: unknown
) => boolean;

export type AttrSanitizer = (node: Node, key: string) => boolean;

export type EventSanitizer = (node: Node, key: string) => boolean;

/** The active sanitizers */
let isElementAllowed: ElementSanitizer = alwaysAllow;
let isPropAllowed: PropSanitizer = alwaysAllow;
let isAttrAllowed: AttrSanitizer = alwaysAllow;
let isEventAllowed: EventSanitizer = alwaysAllow;

/**
 * Set the property sanitizer
 * @example
 * import { setPropSanitizer } from "curly";
 *
 * setSanitizer({ ... })
 */
export const setSanitizer = ({
  element,
  prop,
  attr,
  event,
}: {
  element: ElementSanitizer;
  prop: PropSanitizer;
  attr: AttrSanitizer;
  event: EventSanitizer;
}) => {
  isElementAllowed = element;
  isPropAllowed = prop;
  isAttrAllowed = attr;
  isEventAllowed = event;
};

/** Generates a random number with 8 digits */
const randomSalt = () => Math.random().toFixed(9).slice(2);

const salt = randomSalt();

const placeholderRegex = new RegExp(`#hole${salt}-(\\d+)#`);

const placeholder = (i: number) => `#hole${salt}-${i}#`;

const matchPlaceholder = (value: unknown): number | null => {
  if (typeof value !== "string") {
    return null;
  }
  const match = value.match(placeholderRegex);
  if (match == null) {
    return null;
  }
  return parseInt(match[1], 10);
};

/**
 * Join string using a function that generates string.
 * Function receives the current index of the string part to the left.
 */
const joinWith = (
  parts: Readonly<Array<string>>,
  produce: (i: number) => string
): string => {
  const result: Array<string> = [];
  const holesLength = parts.length - 1;
  for (let i = 0; i < parts.length; i++) {
    result.push(parts[i]);
    if (i < holesLength) {
      result.push(produce(i));
    }
  }
  return result.join("");
};

/**
 * Transform template strings array into string template
 * Holes are transformed into placeholders.
 */
const flattenTemplate = (templateParts: Readonly<Array<string>>): string => {
  const flattened = joinWith(templateParts, placeholder);
  debug("Flattened template", flattened);
  return flattened;
};

const getCachedTemplate = memoize((template: string): HTMLTemplateElement => {
  const templateElement = document.createElement("template");
  templateElement.innerHTML = template;
  return templateElement;
});

/** Clone template, returning first element child */
const cloneTemplateElement = (
  templateElement: HTMLTemplateElement
): Element => {
  const clone = templateElement.content.cloneNode(true) as DocumentFragment;
  const element = clone.firstElementChild as Element;
  return element;
};

/**
 * Walk elements and text nodes, and collect them into an array
 * We deliberately collect them into an array, because once we're iterating
 * over them, we'll be mutating the DOM. This would confuse the walker,
 * so a generator is not appropriate here.
 * INCLUDES the root element.
 */
const walkElementAndTextNodes = (root: Node): Array<Node> => {
  const nodes: Array<Node> = [];
  // Include root node
  nodes.push(root);

  const walker = document.createTreeWalker(
    root,
    NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT
  );

  // Do template replacements
  let node: Node | null;
  while (true) {
    node = walker.nextNode();
    if (node == null) {
      // Done walking, return nodes
      return nodes;
    }
    nodes.push(node);
  }
};

const replaceWith = (node: Node, replacement: Node) => {
  const parentNode = node.parentNode;
  if (parentNode == null) {
    warn("Parent node is null, cannot replace node.", node);
    return;
  }
  parentNode.replaceChild(replacement, node);
};

const replaceNextSiblingWith = (node: Node, replacement: Node) => {
  if (node.nextSibling == null) {
    const parentNode = node.parentNode;
    if (parentNode == null) {
      warn("Parent node is null, cannot replace node.", node);
      return;
    }
    parentNode.insertBefore(replacement, node.nextSibling);
    return;
  }
  replaceWith(node.nextSibling, replacement);
};

const bindContent = (node: Node, context: TemplateContext): Cancel => {
  const i = matchPlaceholder(node.nodeValue);

  // Don't set null props
  if (i == null) {
    return noOp;
  }

  const replacement = context[i];
  if (replacement == null) {
    return noOp;
  }

  // We use this comment as a stable anchor in the DOM when doing reactive
  // re-renders of the content.
  const anchor = document.createComment("TEMPLATE_ANCHOR") as Comment;
  replaceWith(node, anchor);

  return effect(replacement, (replacement) => {
    if (isTemplate(replacement)) {
      const element = render(replacement);
      debug(`Render template`, replacement);
      replaceNextSiblingWith(anchor, element);
    } else {
      debug(`Render text node`, replacement);
      replaceNextSiblingWith(anchor, document.createTextNode(`${replacement}`));
    }
  });
};

const isDomEventKey = (key: string) => key.startsWith("on");

const isPropKey = (key: string) => key.startsWith(".");

const cleanPropKey = (key: string) => key.replace(/\./, "");

const setProp = (element: Element, key: string, value: unknown) => {
  // @ts-ignore - this function should always be called with a valid key
  element[key] = value;
};

const bindProp = (
  element: Element,
  attrKey: string,
  attrValue: string,
  context: TemplateContext
): Cancel => {
  // Remove placeholder attribute
  element.removeAttribute(attrKey);

  // Strip leading dot
  const key = cleanPropKey(attrKey);

  // Don't set disallowed props
  if (!isPropAllowed(element, key, attrValue)) {
    debug(`Property not allowed. Removing.`, key, attrValue);
    return noOp;
  }

  // Don't bind events via props
  if (isDomEventKey(key)) {
    warn(`Events should be bound via @event not via property keys.`, key);
    return noOp;
  }

  const i = matchPlaceholder(attrValue);

  if (i != null) {
    const replacement = context[i];
    return bindDynamicProp(element, key, attrValue, replacement);
  }

  debug("Setting static prop", element, key, attrValue);
  setProp(element, key, attrValue);
  return noOp;
};

const bindDynamicProp = (
  element: Element,
  key: string,
  _attrValue: string,
  replacement: unknown
): Cancel => {
  // Don't set null replacements
  if (replacement == null) {
    warn(`Template replacement is missing`, key);
    return noOp;
  }

  debug("Binding dynamic prop", element, key, replacement);

  return effect(replacement, (replacement) => {
    setProp(element, key, replacement);
  });
};

const bindAttr = (
  element: Element,
  attrKey: string,
  attrValue: string,
  context: TemplateContext
): Cancel => {
  element.removeAttribute(attrKey);

  // Don't set disallowed attributes
  if (!isAttrAllowed(element, attrKey)) {
    debug(`Attribute not allowed. Removing.`, element, attrKey, context);
    return noOp;
  }

  // Don't bind events via props
  if (isDomEventKey(attrKey)) {
    warn(`Events should be bound via @event not via attribute keys`, attrKey);
    return noOp;
  }

  const i = matchPlaceholder(attrValue);
  if (i != null) {
    return bindDynamicAttr(element, attrKey, attrValue, context[i]);
  }

  element.setAttribute(attrKey, attrValue);
  return noOp;
};

const bindDynamicAttr = (
  element: Element,
  attrKey: string,
  _attrValue: string,
  replacement: unknown
): Cancel => {
  // Don't set null replacements
  if (replacement == null) {
    warn(`Template replacement is missing`, attrKey);
    return noOp;
  }

  return effect(replacement, (replacement) => {
    element.setAttribute(attrKey, `${replacement}`);
  });
};

/** Bind an event listener, returning a cancel function */
const listen = (
  element: Element,
  key: string,
  listener: EventListener
): Cancel => {
  // Set listener
  element.addEventListener(key, listener);
  // Return cancel function for removing listener
  return () => {
    element.removeEventListener(key, listener);
  };
};

const isEventKey = (key: string) => key.startsWith("@");

const cleanEventKey = (key: string) => key.replace(/^@/, "");

const bindEvent = (
  element: Element,
  attrKey: string,
  attrValue: string,
  context: TemplateContext
): Cancel => {
  // Remove placeholder key
  element.removeAttribute(attrKey);

  // Remove leading dot
  const key = cleanEventKey(attrKey);

  // Don't set disallowed events
  if (!isEventAllowed(element, key)) {
    debug(`Event not allowed`, key);
    return noOp;
  }

  const i = matchPlaceholder(attrValue);

  if (i == null) {
    warn(`No event listener function provided. Removing listener.`, key);
    return noOp;
  }

  const replacement = context[i];

  if (typeof replacement === "function") {
    const listener = replacement as EventListener;
    return listen(element, key, listener);
  }

  if (isSendable(replacement)) {
    return listen(element, key, (event: Event) => {
      replacement.send(event);
    });
  }

  warn(
    `Cannot bind event listener (must be function or sendable)`,
    key,
    replacement
  );
  return noOp;
};
