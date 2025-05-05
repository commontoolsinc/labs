import type { Cell, Stream } from "@commontools/runner";
declare global {
  namespace JSX {
    interface IntrinsicElements {
      [elemName: string]: any;
    }
  }
}

const FRAGMENT_ELEMENT = "common-fragment";

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

export const isVNode = (value: unknown): value is VNode => {
  return (value as VNode)?.type === "vnode";
};
