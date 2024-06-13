import { Cancel, combineCancels } from '@commontools/common-frp';
import { Signal, effect } from '@commontools/common-frp/signal';
import {
  isBinding,
  VNode,
  AnyJSONSchema,
  View,
  view as createView
} from './view.js';

/** Registry for tags that are allowed to be rendered */
const registry = () => {
  const viewByTag = new Map<string, View>();

  const getViewByTag = (tag: string) => viewByTag.get(tag);

  const register = (view: View) => {
    viewByTag.set(view.tag, view);
  }

  return {getViewByTag, register};
}

export const {getViewByTag, register} = registry();

/** Define and register a view factory function */
export const view = (
  tagName: string,
  propsSchema: AnyJSONSchema = {}
): View => {
  const factory = createView(tagName, propsSchema);
  register(factory);
  return factory;
}

export type RenderContext = Record<string, Signal<any>>

export const __cancel__ = Symbol('cancel');

/** Render a VNode tree, binding reactive data sources.  */
const renderVNode = (
  vnode: VNode,
  context: RenderContext
): Node => {
  // Make sure we have a view for this tag. If we don't it is not whitelisted.
  const view = getViewByTag(vnode.tag);

  if (typeof view !== 'function') {
    throw new TypeError(`Unknown tag: ${vnode.tag}`);
  }

  // Validate props against the view's schema.
  if (!view.validateProps(vnode.props)) {
    throw new TypeError(`Invalid props for tag: ${vnode.tag}.
      Props: ${JSON.stringify(vnode.props)}`);
  }

  // Create the element
  const element = document.createElement(vnode.tag);

  // Bind each prop to a reactive value (if any) and collect cancels
  const cancels: Array<Cancel> = [];
  for (const [key, value] of Object.entries(vnode.props)) {
    if (isBinding(value)) {
      const boundValue = context[value.name];
      if (boundValue != null) {
        const cancel = effect([boundValue], value => {
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
    if (typeof child === 'string') {
      element.appendChild(document.createTextNode(child));
    } else {
      element.appendChild(render(child, context));
    }
  }

  return element;
}

/** Render a view tree, binding reactive data sources.  */
export const render = (
  vnode: VNode | string | undefined | null,
  context: RenderContext = {}
): Node => {
  if (vnode == null) {
    return document.createTextNode('');
  }
  if (typeof vnode === 'string') {
    return document.createTextNode(vnode);
  }
  return renderVNode(vnode, context);
}

export default render;

const setProp = (element: HTMLElement, key: string, value: any) => {
  // @ts-ignore
  element[key] = value;
}