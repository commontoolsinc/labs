import type { Cell, Stream } from "@commontools/runner";
declare global {
  namespace JSX {
    interface IntrinsicElements {
      [elemName: string]: any;
    }
  }
}

/**
 * Fragment element name used for JSX fragments.
 */
const FRAGMENT_ELEMENT = "common-fragment";

/**
 * JSX factory function for creating virtual DOM nodes.
 * @param name - The element name or component function
 * @param props - Element properties
 * @param children - Child elements
 * @returns A virtual DOM node
 */
export const h = Object.assign(function h(
  name: string | ((...args: any[]) => any),
  props: { [key: string]: any } | null,
  ...children: Child[]
): VNode {
  if (typeof name === "function") {
    return name({
      ...(props ?? {}),
      children: children.flat(),
    });
  } else {
    return {
      type: "vnode",
      name,
      props: props ?? {},
      children: children.flat(),
    };
  }
}, {
  fragment({ children }: { children: Child[] }) {
    return h(FRAGMENT_ELEMENT, null, children);
  },
});

/**
 * Dynamic properties. Can either be string type (static) or a Mustache
 * variable (dynamic).
 */
export type Props = {
  [key: string]:
    | string
    | number
    | boolean
    | object
    | Array<any>
    | null
    | Cell<any>
    | Stream<any>;
};

/** A child in a view can be one of a few things */
export type Child =
  | VNode
  | string
  | number
  | boolean
  | Cell<Child>
  | Array<Child>;

/** A "virtual view node", e.g. a virtual DOM element */
export type VNode = {
  type: "vnode";
  name: string;
  props: Props;
  children: Array<Child> | Cell<Array<Child>>;
};

/**
 * Type guard to check if a value is a VNode.
 * @param value - The value to check
 * @returns True if the value is a VNode
 */
export const isVNode = (value: unknown): value is VNode => {
  return (value as VNode)?.type === "vnode";
};
