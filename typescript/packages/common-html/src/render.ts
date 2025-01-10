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
  Binding,
} from "./view.js";
import {
  effect,
  isSendable,
  isReactive,
  useCancelGroup,
  type Cancel,
  type RendererCell,
  ReactiveCell,
  isRendererCell,
} from "@commontools/common-runner";
import { JSONSchema } from "@commontools/common-builder";
import * as logger from "./logger.js";

const schema: JSONSchema = {
  type: "object",
  properties: {
    type: { type: "string" },
    // For VNode
    name: { type: "string" },
    props: {
      type: "object",
      additionalProperties: { asCell: true },
    },
    children: {
      type: "array",
      items: {
        $ref: "#",
        asCell: true,
      },
    },
    // For View
    template: { $ref: "#" },
    context: {
      type: "object",
      additionalProperties: { asCell: true },
    },
  },
};

/** Render a view into a parent element */
export const render = (
  parent: HTMLElement,
  view: View | VNode | RendererCell<View | VNode>,
): Cancel => {
  // If this is a reactive cell, ensure the schema is View | VNode
  if (isRendererCell(view)) view = view.asSchema(schema);
  return effect(view, (view: View | VNode) => renderImpl(parent, view));
};

export const renderImpl = (parent: HTMLElement, view: View | VNode): Cancel => {
  let { template, context } = isVNode(view)
    ? { template: view, context: {} }
    : view;
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
    if (
      typeof child === "string" ||
      typeof child === "number" ||
      typeof child === "boolean"
    ) {
      // Bind static content
      element.append(child.toString());
    } else if (isVNode(child)) {
      // Bind static VNode
      const [childElement, cancel] = renderNode(child, context);
      addCancel(cancel);
      if (childElement) {
        element.append(childElement);
      }
    } else if (isBinding(child) || isReactive(child)) {
      // Bind dynamic content
      const replacement = isReactive(child as ReactiveCell<unknown>)
        ? child
        : getContext(context, child.path);
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
        } else if (isView(replacement) || isVNode(replacement)) {
          const [childElement, cancel] = isView(replacement)
            ? renderNode(replacement.template, replacement.context)
            : renderNode(replacement, {});
          addCancel(cancel);
          if (childElement != null) {
            anchor.replaceWith(childElement);
            anchor = childElement;
          } else {
            logger.warn("Could not render view", replacement);
          }
        } else {
          if (typeof replacement === "object") {
            console.warn(
              "unexpected object when value was expected",
              replacement,
            );
            replacement = JSON.stringify(replacement);
          }
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
  context: Context,
): Cancel => {
  const [cancel, addCancel] = useCancelGroup();
  for (const [propKey, propValue] of Object.entries(props)) {
    if (
      isBinding(propValue) ||
      isReactive(propValue) ||
      isSendable(propValue)
    ) {
      const replacement =
        isReactive(propValue as ReactiveCell<unknown>) || isSendable(propValue)
          ? propValue
          : getContext(context, (propValue as Binding).path);
      // If prop is an event, we need to add an event listener
      if (isEventProp(propKey)) {
        if (!isSendable(replacement)) {
          throw new TypeError(
            `Event prop "${propKey}" does not have a send method`,
          );
        }
        const key = cleanEventProp(propKey);
        if (key != null) {
          const cancel = listen(element, key, event => {
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
        const cancel = effect(replacement, replacement => {
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
