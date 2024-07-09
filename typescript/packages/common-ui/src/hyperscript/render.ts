import { Cancel, combineCancels, isSendable } from "@commontools/common-frp";
import {
  Signal,
  WriteableSignal,
  effect,
  isSignal,
} from "@commontools/common-frp/signal";
import {
  Stream,
  WriteableStream,
  isStream,
} from "@commontools/common-frp/stream";
import {
  isBinding,
  VNode,
  View,
  view as createView,
  Children,
  isRepeatBinding,
} from "./view.js";
import { JSONSchemaRecord } from "./schema-helpers.js";
import { gmap, isIterable } from "../shared/generator.js";

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
export const view = (tagName: string, props: JSONSchemaRecord = {}): View => {
  const factory = createView(tagName, props);
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
  element: Element,
  event: string,
  listener: EventListener,
  options?: AddEventListenerOptions,
): Cancel => {
  element.addEventListener(event, listener, options);
  return () => {
    element.removeEventListener(event, listener, options);
  };
};

/** Read an event, returning a safe description object */
const readEvent = (event: Event) => {
  event.stopPropagation();
  switch (event.type) {
    case "click":
      return {
        type: "click",
        id: (event.target as Element).id,
      };
    default:
      return {
        type: event.type,
        id: (event.target as Element).id,
        detail: (event as CustomEvent).detail,
      };
  }
};

// const modifyPropsForSchemaValidation = (props: object) =>
//   Object.fromEntries(
//     Object.entries(props).filter(
//       ([_, value]) => !isSignal(value) && !isStream(value) && !isBinding(value),
//     ),
//   );

/** Render a VNode tree, binding reactive data sources.  */
const renderVNode = (vnode: VNode, context: RenderContext): Node => {
  // Make sure we have a view for this tag. If we don't it is not whitelisted.
  // const view = getViewByTag(vnode.tag);

  // if (typeof view !== "function") {
  //   throw new TypeError(`Unknown tag: ${vnode.tag}`);
  // }

  // // Validate props against the view's schema.
  // if (!view.props.validate(modifyPropsForSchemaValidation(vnode.props))) {
  //   throw new TypeError(`Invalid props for tag: ${vnode.tag}.
  //     Props: ${JSON.stringify(vnode.props)}, ${JSON.stringify(modifyPropsForSchemaValidation(vnode.props), undefined, 2)}
  //     Schema: ${JSON.stringify(view.props.schema, undefined, 2)}`);
  // }

  // Create the element
  const element = document.createElement(vnode.tag);

  // Bind each prop to a reactive value (if any) and collect cancels
  const cancels: Array<Cancel> = [];

  for (const [prop, value] of Object.entries(vnode.props || {})) {
    const [key, detail] = prop.split("#", 2);
    // Don't bind properties that aren't whitelisted in the schema.
    // if (!Object.hasOwn(view.props.schema.properties, key)) {
    //   continue;
    // }

    if (isBinding(value) || isSignal(value) || isStream(value)) {
      const bound =
        isSignal(value) || isStream(value) ? value : context[value.name];
      if (isEventKey(key)) {
        console.log("found event", element, key, value, context);
        if (isSendable(bound)) {
          console.log("binding event", element, key, bound);
          const { send } = bound;
          const event = readEventNameFromEventKey(key);
          const cancel = listen(element, event, (event: Event) => {
            let vdomEvent = readEvent(event);
            if (detail) vdomEvent = vdomEvent.detail[detail];
            send(vdomEvent);
          });
          cancels.push(cancel);
        }
      } else {
        if (bound) {
          console.log("setting binding", element, key, value);
          const cancel = effect([bound], (value) => {
            setProp(element, key, value);
          });
          cancels.push(cancel);
        }
      }
    } else {
      console.log("setting prop", element, key, value);
      setProp(element, key, value);
    }
  }

  // Combine cancels and store on element.
  const cancel = combineCancels(cancels);
  // @ts-ignore
  element[__cancel__] = cancel;

  if (isRepeatBinding(vnode.children)) {
    const { name, template, signal } = vnode.children;
    const scopedContext = signal ? signal : context[name];
    const cancel = renderDynamicChildren(element, template, scopedContext);
    cancels.push(cancel);
  } else if (isBinding(vnode.children)) {
    const { name } = vnode.children;
    renderText(element, context[name]);
  } else if (isSignal(vnode.children)) {
    const signal = vnode.children;
    renderText(element, signal);
  } else {
    renderStaticChildren(
      element,
      vnode.children as Exclude<Signal<any>, Children>,
      context,
    );
  }

  return element;
};

/** Render a view tree, binding reactive data sources.  */
export const render = (
  vnode: VNode | string | undefined | null,
  context: RenderContext = {},
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
      `Invalid event key: ${key}. Event keys must start with "@".`,
    );
  }
  return key.slice(1);
};

const setProp = (element: Element, key: string, value: any) => {
  // @ts-ignore
  element[key] = value;
};

/** Render a static list of VNode children to an element */
const renderStaticChildren = (
  element: Element,
  children: Array<VNode | string>,
  context: RenderContext,
) => {
  for (const child of children || []) {
    if (typeof child === "string") {
      element.appendChild(document.createTextNode(child));
    } else {
      element.appendChild(render(child, context));
    }
  }
};

const renderText = (element: Element, value: any): Cancel =>
  effect([value], (value) => {
    if (value != null) {
      element.textContent = value as string;
    }
  });

/** Symbol for list item key */
const __id__ = Symbol("list item key");

let _cid = 0;
const cid = () => `cid${_cid++}`;

/**
 * An element with an id symbol used for efficient rendering of dynamic lists.
 */
export type IdentifiedChild = Element & { [__id__]?: any };

export const renderDynamicChildren = (
  parent: Element,
  template: VNode | Function,
  states: Signal<unknown> | any,
) => {
  return effect([states], (states) => {
    // If states is not iterable, do nothing.
    if (!isIterable(states)) {
      return;
    }

    // Build a map of states by id for quick lookup.
    // If model doesn't have an ID, generate one. Generated ID will mean the
    // item will not be efficiently re-rendered by identity, but it will
    // still work.
    const statesById = new Map(
      gmap(states, (state) => [state.id ?? cid(), state]),
    );

    // Build an index of children and a list of children to remove.
    // Note that we must build a list of children to remove, since
    // removing in-place would change the live node list and bork iteration.
    const children = new Map<any, Element>();
    const removes: Array<Element> = [];

    for (const child of parent.children) {
      const identifiedChild = child as IdentifiedChild;
      const childId = identifiedChild[__id__];
      children.set(childId, child);
      if (!statesById.has(childId)) {
        removes.push(identifiedChild);
      }
    }

    for (const child of removes) {
      parent.removeChild(child);
    }

    let i = 0;
    for (const id of statesById.keys()) {
      const index = i++;
      const child = children.get(id);
      if (child != null) {
        insertElementAt(parent, child, index);
      } else {
        const childContext = statesById.get(id);
        const keyedChild = render(
          typeof template === "function" ? template(childContext) : template,
          childContext,
        ) as IdentifiedChild;
        keyedChild[__id__] = id;
        insertElementAt(parent, keyedChild, index);
      }
    }
  });
};

/**
 * Insert element at index.
 * If element is already at index, this function is a no-op
 * (it doesn't remove-and-then-add element). By avoiding moving the element
 * unless needed, we preserve focus and selection state for elements that
 * don't move.
 */
export const insertElementAt = (
  parent: Element,
  element: Element,
  index: number,
) => {
  const elementAtIndex = parent.children[index];
  if (elementAtIndex === element) {
    return;
  }
  parent.insertBefore(element, elementAtIndex);
};
