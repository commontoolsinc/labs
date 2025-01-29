declare global {
  namespace JSX {
    interface IntrinsicElements {
      [elemName: string]: any;
    }
  }
}

export const Fragment = "Fragment";

export function h(
  name: string | ((...args: any[]) => any),
  props: { [key: string]: any } | null,
  ...children: Child[]
): VNode {
  if (typeof name === "function")
    return name({
      ...(props ?? {}),
      children: children.flat(),
    });
  else
    return {
      type: "vnode",
      name,
      props: props ?? {},
      children: children.flat(),
    };
}

/**
 * Dynamic properties. Can either be string type (static) or a Mustache
 * variable (dynamic).
 */
export type Props = {
  [key: string]: string | number | boolean | object | Array<any> | null;
};

/** A child in a view can be one of a few things */
export type Child = VNode | string;

/** A "virtual view node", e.g. a virtual DOM element */
export type VNode = {
  type: "vnode";
  name: string;
  props: Props;
  children: Array<Child>;
};

export const isVNode = (value: unknown): value is VNode => {
  return (value as VNode)?.type === "vnode";
};
