import { Cancel, combineCancels, isSendable } from "@commontools/common-frp";
import {
  Signal,
  WriteableSignal,
  effect,
} from "@commontools/common-frp/signal";
import { Stream, WriteableStream } from "@commontools/common-frp/stream";
import {
  isBinding,
  VNode,
  JSONSchemaRecord,
  View,
  view as createView,
  Props,
} from "./view.js";

/** Registry for tags that are allowed to be rendered */
const registry = () => {
  const viewByTag = new Map<string, View>();

  const listViews = () => Array.from(viewByTag.values());

  const getViewByTag = (tag: string) => viewByTag.get(tag);

  const registerView = (view: View) => {
    viewByTag.set(view.tag, view);
  };

  return { getViewByTag, listViews, registerView };
};

export const { getViewByTag, listViews, registerView } = registry();

/** Define and register a view factory function */
export const view = (
  tagName: string,
  props: JSONSchemaRecord = {},
  constantProps: Props = {}
): View => {
  const factory = createView(tagName, props, constantProps);
  registerView(factory);
  return factory;
};

export type BindableValue =
  | Signal<any>
  | WriteableSignal<any>
  | Stream<any>
  | WriteableStream<any>
  | any;

export type RenderContext = Record<string, BindableValue>;

export const __cancel__ = Symbol("cancel");

/** Bind an event listener, and return a Cancel function */
const listen = (
  element: HTMLElement,
  event: string,
  listener: EventListener,
  options?: AddEventListenerOptions
): Cancel => {
  element.addEventListener(event, listener, options);
  return () => {
    element.removeEventListener(event, listener, options);
  };
};

/** Read an event, returning a safe description object */
const readEvent = (event: Event) => {
  switch (event.type) {
    case "click":
      return {
        type: "click",
      };
    default:
      return { type: event.type };
  }
};

/** Render a VNode tree, binding reactive data sources.  */
const renderVNode = (vnode: VNode, context: RenderContext): Node => {
  // Make sure we have a view for this tag. If we don't it is not whitelisted.
  const view = getViewByTag(vnode.tag);

  if (typeof view !== "function") {
    throw new TypeError(`Unknown tag: ${vnode.tag}`);
  }

  // Validate props against the view's schema.
  if (!view.props.validate(vnode.props)) {
    throw new TypeError(`Invalid props for tag: ${vnode.tag}.
      Props: ${JSON.stringify(vnode.props)}
      Schema: ${JSON.stringify(view.props.schema)}`);
  }

  // Create the element
  const element = document.createElement(vnode.tag);

  // Bind each prop to a reactive value (if any) and collect cancels
  const cancels: Array<Cancel> = [];

  for (const [key, value] of Object.entries(vnode.props)) {
    // Don't bind properties that aren't whitelisted in the schema.
    if (!Object.hasOwn(view.props.schema.properties, key)) {
      continue;
    }

    if (isEventKey(key) && isBinding(value)) {
      const bound = context[value.name];
      if (isSendable(bound)) {
        const { send } = bound;
        const event = readEventNameFromEventKey(key);
        const cancel = listen(element, event, (event: Event) => {
          send(readEvent(event));
        });
        cancels.push(cancel);
      }
    } else if (isBinding(value)) {
      const boundValue = context[value.name];
      if (boundValue != null) {
        const cancel = effect([boundValue], (value) => {
          setProp(element, key, value);
        });
        cancels.push(cancel);
      }
    } else {
      setProp(element, key, value);
    }
  }

  // Combine cancels and store on element.
  const cancel = combineCancels(cancels);
  // @ts-ignore
  element[__cancel__] = cancel;

  for (const child of vnode.children) {
    if (typeof child === "string") {
      element.appendChild(document.createTextNode(child));
    } else {
      element.appendChild(render(child, context));
    }
  }

  return element;
};

/** Render a view tree, binding reactive data sources.  */
export const render = (
  vnode: VNode | string | undefined | null,
  context: RenderContext = {}
): Node => {
  if (vnode == null) {
    return document.createTextNode("");
  }
  if (typeof vnode === "string") {
    return document.createTextNode(vnode);
  }
  return renderVNode(vnode, context);
};

export default render;

const isEventKey = (key: string) => key.startsWith("@");

/** Extract the event name from the event key */
const readEventNameFromEventKey = (key: string) => {
  if (!isEventKey(key)) {
    throw new TypeError(
      `Invalid event key: ${key}. Event keys must start with "@".`
    );
  }
  return key.slice(1);
};

const setProp = (element: HTMLElement, key: string, value: any) => {
  // @ts-ignore
  element[key] = value;
};
