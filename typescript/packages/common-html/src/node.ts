import { Hole } from "./hole.js";

export type Node = {
  type: "node";
  tag: string;
  attrs: Attrs;
  children: Children;
};

export type Attrs = { [key: string]: string | Hole };

export type Children = Array<Node | Hole | string>;

export const create = (
  tag: string,
  attrs: Attrs = {},
  children: Children = []
): Node => ({
  type: "node",
  tag,
  attrs,
  children,
});

export const isNode = (value: unknown): value is Node => {
  return (value as Node)?.type === "node";
};