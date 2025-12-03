import { type HFunction, type RenderNode, type VNode } from "@commontools/api";

/**
 * Fragment element name used for JSX fragments.
 */
const FRAGMENT_ELEMENT = "ct-fragment";

/**
 * JSX factory function for creating virtual DOM nodes.
 * @param name - The element name or component function
 * @param props - Element properties
 * @param children - Child elements
 * @returns A virtual DOM node
 */
export const h: HFunction = Object.assign(
  function h(
    name: string | ((...args: any[]) => VNode),
    props: { [key: string]: any } | null,
    ...children: RenderNode[]
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
  },
  {
    fragment({ children }: { children: RenderNode[] }) {
      return h(FRAGMENT_ELEMENT, null, ...children);
    },
  },
);
