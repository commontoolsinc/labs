import parse from "./parser.js";
import { Node, isNode } from "./node.js";
import * as hole from "./hole.js";

export const html = (
  strings: TemplateStringsArray,
  ...values: Named[]
): Renderable => {
  const templateMarkup = flattenTemplateStrings(strings, values);
  const root = parse(templateMarkup);

  if (root.children.length !== 1) {
    throw TypeError("Template have one root node");
  }

  const template = root.children[0];

  if (!isNode(template)) {
    throw TypeError("Template root must be an element");
  }

  const context = Object.freeze(indexContext(values));

  return Object.freeze({
    type: "renderable",
    template,
    context,
  })
};

export default html;

export type Renderable = {
  type: "renderable";
  template: Node;
  context: Context;
};

export type Context = { [key: string]: Named };

export type Named = {
  name: string;
};

const indexContext = (items: Named[]): Context => {
  return Object.fromEntries(items.map((item) => [item.name, item]));
}

const flattenTemplateStrings = (
  strings: TemplateStringsArray,
  values: Named[]
): string => {
  return strings.reduce((result, string, i) => {
    const value = values[i];
    return result + string + (value ? hole.markup(value.name) : "");
  }, "");
}