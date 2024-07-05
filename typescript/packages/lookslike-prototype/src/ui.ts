import { view, tags, render } from "@commontools/common-ui";
import { VNode } from "../../common-ui/lib/hyperscript/view.js";
import { RenderContext } from "../../common-ui/lib/hyperscript/render.js";
import { Graph } from "./reactivity/runtime.js";

export function createElement(
  tree: VNode,
  inputs: RenderContext,
  graph: Graph
) {
  tree.children ||= [];
  tree.props ||= {};
  const test = render.render(tree, inputs);
  return test;
}
