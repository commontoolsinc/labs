/**
 * These are our render types from `api` for use alongside `RuntimeClient`,
 * replacing instances of `Cell` with `CellHandle` for `Props`, `VNode`,
 * and `RenderNode`.
 */

import { isObject } from "@commontools/utils/types";
import { UI } from "@commontools/runner/shared";
import { CellHandle } from "./cell-handle.ts";

export const isVNode = (value: unknown): value is VNode => {
  const visited = new Set<object>();
  while (isObject(value) && UI in value) {
    if (visited.has(value)) return false; // Cycle detected
    visited.add(value);
    value = value[UI];
  }
  return (value as VNode)?.type === "vnode";
};

export type Props = {
  [key: string]:
    | string
    | number
    | boolean
    | object
    | Array<any>
    | null
    | CellHandle<any>;
};

export type RenderNode =
  | InnerRenderNode
  | CellHandle<InnerRenderNode>
  | Array<RenderNode>;

type InnerRenderNode =
  | VNode
  | string
  | number
  | boolean
  | undefined;

export type VNode = {
  type: "vnode";
  name: string;
  props: Props;
  children?: RenderNode;
  [UI]?: VNode;
};
