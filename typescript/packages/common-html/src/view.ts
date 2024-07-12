import { Reactive } from "./reactive.js";
import { isVNode, VNode } from "./vnode.js";
import parse from "./parser.js";
import * as logger from "./logger.js";

export type Context = { [key: string]: Reactive<unknown> };

export type View = {
  type: "view";
  template: VNode;
  context: Context;
};

export const isView = (value: unknown): value is View => {
  return (value as View)?.type === "view";
};

export const view = (markup: string, context: Context): View => {
  // Parse template string to template object
  const root = parse(markup);

  if (root.children.length !== 1) {
    throw TypeError("Template should have only one root node");
  }

  const template = root.children[0];

  if (!isVNode(template)) {
    throw TypeError("Template root must be an element");
  }

  const view: View = {
    type: "view",
    template,
    context,
  };

  logger.debug("View", view);

  return view;
};

export default view;
