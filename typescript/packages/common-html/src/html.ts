import parse from "./parser.js";
import { Node, isNode } from "./node.js";
import * as hole from "./hole.js";
import { Named, NamedReactive, Reactive } from "./reactive.js";
import * as logger from "./logger.js";

export const html = (
  strings: TemplateStringsArray,
  ...values: Array<NamedReactive<unknown>>
): Renderable => {
  // Create pairs of name/value. Generate name if needed.
  const namedValues: Array<[string, Reactive<unknown>]> = values.map(
    (value) => {
      const name = (value as NamedReactive<unknown>)?.name ?? cid();
      return [name, value];
    },
  );

  // Flatten template string
  const templateString = strings.reduce((result, string, i) => {
    const namedValue = namedValues[i];
    if (namedValue != null) {
      const [name] = namedValue;
      return result + string + hole.markup(name);
    } else {
      return result + string;
    }
  }, "");

  logger.debug("Flattened", templateString);

  // Parse template string to template object
  const root = parse(templateString);

  if (root.children.length !== 1) {
    throw TypeError("Template have one root node");
  }

  const template = root.children[0];

  if (!isNode(template)) {
    throw TypeError("Template root must be an element");
  }

  // Build context object from entries, indexing by name.
  const context = Object.fromEntries(namedValues);

  const renderable: Renderable = {
    type: "renderable",
    template,
    context,
  };

  logger.debug("Renderable", renderable);

  return renderable;
};

export default html;

export type Context = { [key: string]: Reactive<unknown> };

export type Renderable = {
  type: "renderable";
  template: Node;
  context: Context;
};

export const isRenderable = (value: unknown): value is Renderable => {
  return (value as Renderable)?.type === "renderable";
};

let _cid = 0;
// Generate client ID
const cid = () => `cid${_cid++}`;
