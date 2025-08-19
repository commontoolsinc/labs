import { isObject } from "@commontools/utils/types";
import { UI, type VNode } from "@commontools/runner";
export type { Props, RenderNode } from "@commontools/runner";
export { type VNode };

/**
 * Type guard to check if a value is a VNode.
 * @param value - The value to check
 * @returns True if the value is a VNode
 */
export const isVNode = (value: unknown): value is VNode => {
  while (isObject(value) && UI in value) value = value[UI];
  return (value as VNode)?.type === "vnode";
};
