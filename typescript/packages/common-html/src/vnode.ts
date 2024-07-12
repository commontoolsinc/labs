import { Hole } from "./hole.js";

export type VNode = {
  type: "vnode";
  tag: string;
  attrs: Attrs;
  children: Children;
};

export type Attrs = { [key: string]: string | Hole };

export type Children = Array<VNode | Hole | string>;

export const create = (
  tag: string,
  attrs: Attrs = {},
  children: Children = [],
): VNode => ({
  type: "vnode",
  tag,
  attrs,
  children,
});

export const isVNode = (value: unknown): value is VNode => {
  return (value as VNode)?.type === "vnode";
};
