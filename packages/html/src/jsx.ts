import { type VNode } from "@commontools/builder";
export { h } from "@commontools/builder";
export type { Child, Props } from "@commontools/builder";
export { type VNode };

/**
 * Type guard to check if a value is a VNode.
 * @param value - The value to check
 * @returns True if the value is a VNode
 */
export const isVNode = (value: unknown): value is VNode => {
  return (value as VNode)?.type === "vnode";
};
