import { KNOWN_TAGS, isKnownTag } from './known-tags.js';
import { pipe } from './util.js';
import { Cancel, combineCancels } from '@commontools/common-frp';
import { Signal, effect } from '@commontools/common-frp/signal';

export type Type = string;

export type SignalBinding = {
  "@type": "signal";
  type: Type;
  name: string;
}

/** Is value a binding to a reactive value? */
export const isSignalBinding = (value: any): value is SignalBinding => {
  return (
    value &&
    value["@type"] === "signal" &&
    typeof value.name === "string" &&
    typeof value.name === "string"
  );
}

/** Create a signal binding */
export const signal = (type: Type, name: string): SignalBinding => ({
  "@type": "signal",
  type,
  name
});

export type Value = string | number | boolean | null | object;

export type ReactiveValue = SignalBinding | Value;

export type Props = {
  [key: string]: ReactiveValue;
}

export type Tag = string;

export type VNode = {
  tag: Tag;
  props: Props;
  children: Array<VNode | string>;
}

const vh = (
  tag: string,
  props: Props = {},
  ...children: Array<VNode | string>
): VNode  => ({
  tag,
  props,
  children
});

export type VNodeFactory = (
  props: Props,
  ...children: Array<VNode | string>
) => VNode;

/** Create a tag factory */
const vtag = (tag: string): VNodeFactory => (
  props: Props = {},
  ...children: Array<VNode | string>
): VNode => vh(tag, props, ...children);

/**
 * Hyperscript factory functions for component tags.
 * Each tag function generates a vnode.
 */
export const tags: Readonly<Record<string, VNodeFactory>> = pipe(
  KNOWN_TAGS,
  Object.entries,
  tags => tags.map(([tag, factory]) => [factory, vtag(tag)]),
  Object.fromEntries,
  Object.freeze
);

export type RenderContext = Record<string, Signal<any>>

export const __cancel__ = Symbol('cancel');

/** Render vnode with a render context of reactive data sources */
export const render = (
  vnode: VNode,
  context: RenderContext
) => {
  if (!isKnownTag(vnode.tag)) {
    throw new TypeError(`Unknown tag: ${vnode.tag}`);
  }

  const element = document.createElement(vnode.tag);

  // Bind each prop to a reactive value (if any) and collect cancels
  const cancels: Array<Cancel> = [];
  for (const [key, value] of Object.entries(vnode.props)) {
    if (isSignalBinding(value)) {
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
    if (typeof child === 'string') {
      element.appendChild(document.createTextNode(child));
    } else {
      element.appendChild(render(child, context));
    }
  }

  return element;
}

const setProp = (element: HTMLElement, key: string, value: any) => {
  // @ts-ignore
  element[key] = value;
}