import { VNode, Child } from "./view.js";

declare global {
  namespace JSX {
    interface IntrinsicElements {
      [elemName: string]: any;
    }
  }
}

const Fragment = "Fragment";

function h(
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

export { h, Fragment };
