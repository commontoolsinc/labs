import {
  View,
  Context,
  isView,
  isVNode,
  VNode,
  isBinding,
  Props,
  Child,
  isSection,
  getContext,
} from "./view.js";
import { effect, isSendable } from "@commontools/common-propagator/reactive.js";
import {
  useCancelGroup,
  Cancel,
} from "@commontools/common-propagator/cancel.js";
import * as logger from "./logger.js";

export const render = (parent: HTMLElement, view: View): Cancel => {
  const { template, context } = view;
  const [root, cancel] = renderNode(template, context);
  if (!root) {
    logger.warn("Could not render view", view);
    return cancel;
  }
  parent.append(root);
  logger.debug("Rendered", root);
  return cancel;
};

export default render;

const renderNode = (
  node: VNode,
  context: Context,
): [HTMLElement | null, Cancel] => {
  const [cancel, addCancel] = useCancelGroup();

  const sanitizedNode = sanitizeNode(node);

  if (!sanitizedNode) {
    return [null, cancel];
  }

  const element = document.createElement(sanitizedNode.name);

  const cancelProps = bindProps(element, sanitizedNode.props, context);
  addCancel(cancelProps);

  const cancelChildren = bindChildren(element, sanitizedNode.children, context);
  addCancel(cancelChildren);

  return [element, cancel];
};

const bindChildren = (
  element: HTMLElement,
  children: Array<Child>,
  context: Context,
): Cancel => {
  const [cancel, addCancel] = useCancelGroup();

  for (const child of children) {
    if (typeof child === "string") {
      // Bind static content
      element.append(child);
    } else if (isVNode(child)) {
      // Bind static VNode
      const [childElement, cancel] = renderNode(child, context);
      addCancel(cancel);
      if (childElement) {
        element.append(childElement);
      }
    } else if (isBinding(child)) {
      // Bind dynamic content
      const replacement = getContext(context, child.path);
      // Anchor for reactive replacement
      let anchor: ChildNode = document.createTextNode("");
      element.append(anchor);
      const cancel = effect(replacement, (replacement) => {
        if (isView(replacement)) {
          const [childElement, cancel] = renderNode(
            replacement.template,
            replacement.context,
          );
          addCancel(cancel);
          if (childElement != null) {
            anchor.replaceWith(childElement);
            anchor = childElement;
          } else {
            logger.warn("Could not render view", replacement);
          }
        } else {
          const text = document.createTextNode(`${replacement}`);
          anchor.replaceWith(text);
          anchor = text;
        }
      });
      addCancel(cancel);
    } else if (isSection(child)) {
      logger.warn("Sections not yet implemented");
    }
  }
  return cancel;
};

const bindProps = (
  element: HTMLElement,
  props: Props,
  context: Context,
): Cancel => {
  const [cancel, addCancel] = useCancelGroup();
  for (const [propKey, propValue] of Object.entries(props)) {
    if (isBinding(propValue)) {
      const replacement = getContext(context, propValue.path);
      // If prop is an event, we need to add an event listener
      if (isEventProp(propKey)) {
        if (!isSendable(replacement)) {
          throw new TypeError(
            `Event prop "${propKey}" does not have a send method`,
          );
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
      } else {
        const cancel = effect(replacement, (replacement) => {
          // Replacements are set as properties not attributes to avoid
          // string serialization of complex datatypes.
          setProp(element, propKey, replacement);
        });
        addCancel(cancel);
      }
    } else {
      element.setAttribute(propKey, propValue);
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
