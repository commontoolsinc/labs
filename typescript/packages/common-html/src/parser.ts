import sax from "sax";
import parseMustaches from "./stache.js";
import { isHole } from "./hole.js";
import { create as createNode, Node, Attrs } from "./node.js";
import * as logger from "./logger.js";

/** Parse a template into a simple JSON markup representation */
export const parse = (markup: string): Node => {
  const strict = false;
  const parser = sax.parser(strict, {
    trim: true,
    lowercase: true,
    xmlns: false,
  });

  let root: Node = createNode("documentfragment");
  let stack: Array<Node> = [root];

  parser.onerror = (error: Error) => {
    throw error;
  };

  parser.onopentag = (node) => {
    // We've turned off the namespace feature, so node attributes will
    // contain only string values, not QualifiedAttribute objects.
    const attrs = parseAttrs(node.attributes as { [key: string]: string });
    const next = createNode(node.name, attrs);
    const top = getTop(stack);
    if (!top) {
      throw new ParseError(`No parent tag for ${node.name}`);
    }
    top.children.push(next);
    stack.push(next);
  };

  parser.onclosetag = (tagName) => {
    const node = stack.pop();
    if (!node) {
      throw new ParseError(`Unexpected closing tag ${tagName}`);
    }
  };

  parser.ontext = (text) => {
    const top = getTop(stack);
    const parsed = parseMustaches(text);
    top.children.push(...parsed);
  };

  parser.write(markup).close();

  if (getTop(stack) !== root) {
    throw new ParseError(`Unexpected root node ${root.tag}`);
  }

  logger.debug("Parsed", root);

  return root;
};

export default parse;

const getTop = (stack: Array<Node>): Node | null => stack.at(-1) ?? null;

const parseAttrs = (attrs: { [key: string]: string }): Attrs => {
  const result: Attrs = {};
  for (const [key, value] of Object.entries(attrs)) {
    const parsed = parseMustaches(value);
    const first = parsed.at(0);
    if (parsed.length !== 1) {
      result[key] = "";
    } else if (isHole(first)) {
      result[key] = first;
    } else {
      result[key] = `${value}`;
    }
  }
  return result;
};

export class ParseError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
  }
}
