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
import {
  effect,
  isSendable,
  isReactive,
} from "@commontools/common-propagator/reactive.js";
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
  context: Context
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
  context: Context
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
      let endAnchor: ChildNode | undefined = undefined;
      element.append(anchor);
      const replace = (replacement: any) => {
        if (isReactive(replacement)) {
          const cancel = effect(replacement, replace);
          addCancel(cancel);
        } else if (Array.isArray(replacement)) {
          // TODO: Probably should move this up and instead only support the
          // case where all the children are dynamic. That is, call bindChildren
          // again from effect.

          // For now a dumb version that replaces the whole list every time
          while (endAnchor && anchor.nextSibling !== endAnchor) {
            anchor.nextSibling?.remove();
          }
          if (!endAnchor) {
            endAnchor = document.createTextNode("");
            anchor.after(endAnchor);
          }

          // Swap out anchor for each item, so we can use the rest of the code
          // as if it was a regular node.
          const originalAnchor = anchor;
          for (const item of replacement) {
            const newAnchor = document.createTextNode("");
            anchor.after(newAnchor);
            anchor = newAnchor;
            replace(item);
          }
          anchor = originalAnchor;
        } else if (isView(replacement)) {
          const [childElement, cancel] = renderNode(
            replacement.template,
            replacement.context
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
      };
      replace(replacement);
    } else if (isSection(child)) {
      logger.warn("Sections not yet implemented");
    }
  }
  return cancel;
};

const bindProps = (
  element: HTMLElement,
  props: Props,
  context: Context
): Cancel => {
  const [cancel, addCancel] = useCancelGroup();
  for (const [propKey, propValue] of Object.entries(props)) {
    if (isBinding(propValue)) {
      const replacement = getContext(context, propValue.path);
      // If prop is an event, we need to add an event listener
      if (isEventProp(propKey)) {
        if (!isSendable(replacement)) {
          throw new TypeError(
            `Event prop "${propKey}" does not have a send method`
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
  callback: (event: Event) => void
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
