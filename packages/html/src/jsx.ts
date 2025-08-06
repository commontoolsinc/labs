import { isObject } from "@commontools/utils/types";
import { UI, type VNode } from "@commontools/runner";
export type { Child, Props } from "@commontools/runner";
export { type VNode };

// This declaration is for code within our workspace
// (e.g. shell and @commontools/html tests.)
// Recipe code uses JSX definitions found at:
// `packages/static/assets/types/jsx.d.ts`
declare global {
  namespace JSX {
    interface IntrinsicElements {
      [elemName: string]: any;
    }
  }
}

/**
 * Type guard to check if a value is a VNode.
 * @param value - The value to check
 * @returns True if the value is a VNode
 */
export const isVNode = (value: unknown): value is VNode => {
  while (isObject(value) && UI in value) value = value[UI];
  return (value as VNode)?.type === "vnode";
};
