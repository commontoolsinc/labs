import { Hole } from "./hole.js";

export type VNode = {
  type: "vnode";
  tag: string;
  props: Props;
  children: Children;
};

export type Props = { [key: string]: string | Hole };

export type Children = Array<VNode | Hole | string>;

export const create = (
  tag: string,
  props: Props = {},
  children: Children = [],
): VNode => ({
  type: "vnode",
  tag,
  props,
  children,
});

export const isVNode = (value: unknown): value is VNode => {
  return (value as VNode)?.type === "vnode";
};
