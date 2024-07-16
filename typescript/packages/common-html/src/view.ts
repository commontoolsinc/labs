import { Parser } from "htmlparser2";
import * as logger from "./logger.js";

/** Parse a markup string and context into a view */
export const view = (markup: string, context: Context): View => {
  // Parse template string to template object
  const root = parse(markup);

  if (root.children.length !== 1) {
    throw new ParseError("Template should have only one root node");
  }

  const template = root.children[0];

  if (!isVNode(template)) {
    throw new ParseError("Template root must be an element");
  }

  const view: View = {
    type: "view",
    template,
    context,
  };

  logger.debug("view", view);

  return view;
};

export default view;

export type View = {
  type: "view";
  template: VNode;
  context: Context;
};

export const isView = (value: unknown): value is View => {
  return (value as View)?.type === "view";
};

export type Context = { [key: string]: unknown };

/**
 * Dynamic properties. Can either be string type (static) or a Mustache
 * variable (dynamic).
 */
export type Props = { [key: string]: string | Var };

/** A child in a view can be one of a few things */
export type Child = VNode | Block | Var | string;

/** A "virtual view node", e.g. a virtual DOM element */
export type VNode = {
  type: "vnode";
  name: string;
  props: Props;
  children: Array<Child>;
};

/** Create a vnode */
export const createVNode = (
  name: string,
  props: Props = {},
  children: Array<Child> = [],
): VNode => {
  return { type: "vnode", name, props, children };
};

export const isVNode = (value: unknown): value is VNode => {
  return (value as VNode)?.type === "vnode";
};

/** A mustache variable `{{myvar}}` */
export type Var = {
  type: "var";
  name: string;
};

export const createVar = (name: string): Var => {
  return { type: "var", name };
};

export const isVar = (value: unknown): value is Var => {
  return (value as Var)?.type === "var";
};

export const markupVar = (name: string) => `{{${name}}}`;

/** A mustache block `{{#myblock}} ... {{/myblock}}` */
export type Block = {
  type: "block";
  name: string;
  children: Array<Child>;
};

export const createBlock = (
  name: string,
  children: Array<Child> = [],
): Block => {
  return { type: "block", name, children };
};

export const isBlock = (value: unknown): value is Block => {
  return (value as Block)?.type === "block";
};

export type TagOpenToken = {
  type: "tagopen";
  name: string;
  props: Props;
};

export type TagCloseToken = {
  type: "tagclose";
  name: string;
};

export type TextToken = {
  type: "text";
  value: string;
};

export type VarToken = {
  type: "var";
  name: string;
};

export type BlockOpenToken = {
  type: "blockopen";
  name: string;
};

export type BlockCloseToken = {
  type: "blockclose";
  name: string;
};

export type Token =
  | TagOpenToken
  | TagCloseToken
  | TextToken
  | VarToken
  | BlockOpenToken
  | BlockCloseToken;

/** Tokenize markup containing HTML and Mustache */
export const tokenize = (markup: string): Array<Token> => {
  const tokens: Array<Token> = [];

  const parser = new Parser(
    {
      onopentag(name, attrs) {
        // We've turned off the namespace feature, so node attributes will
        // contain only string values, not QualifiedAttribute objects.
        const props = parseProps(attrs as { [key: string]: string });
        const token: TagOpenToken = { type: "tagopen", name, props };
        logger.debug("tagopen", token);
        tokens.push(token);
      },
      onclosetag(name) {
        const token: TagCloseToken = { type: "tagclose", name };
        logger.debug("tagclose", token);
        tokens.push(token);
      },
      ontext(text) {
        const parsed = tokenizeMustache(text.trim());
        tokens.push(...parsed);
      },
    },
    {
      lowerCaseTags: true,
      lowerCaseAttributeNames: true,
      xmlMode: false,
    },
  );

  parser.write(markup);
  parser.end();

  return tokens;
};

const MUSTACHE_REGEX_G = /{{(\w+)}}/g;

/** Tokenize Mustache */
export const tokenizeMustache = (text: string): Array<Token> => {
  const tokens: Array<Token> = [];
  MUSTACHE_REGEX_G.lastIndex = 0;
  let lastIndex = 0;
  let match: RegExpMatchArray | null = null;
  while ((match = MUSTACHE_REGEX_G.exec(text)) !== null) {
    if (match.index > lastIndex) {
      const token: TextToken = {
        type: "text",
        value: text.slice(lastIndex, match.index),
      };
      logger.debug("text", token);
      tokens.push(token);
    }
    const body = match[1];
    if (body.startsWith("#")) {
      const token: BlockOpenToken = { type: "blockopen", name: body.slice(1) };
      logger.debug("blockopen", token);
      tokens.push(token);
    } else if (body.startsWith("/")) {
      const token: BlockCloseToken = {
        type: "blockclose",
        name: body.slice(1),
      };
      logger.debug("blockclose", token);
      tokens.push(token);
    } else {
      const token: VarToken = { type: "var", name: body };
      logger.debug("var", token);
      tokens.push(token);
    }
    lastIndex = MUSTACHE_REGEX_G.lastIndex;
  }

  if (lastIndex < text.length) {
    const token: TextToken = {
      type: "text",
      value: text.slice(lastIndex),
    };
    logger.debug("text", token);
    tokens.push(token);
  }

  MUSTACHE_REGEX_G.lastIndex = 0;

  return tokens;
};

/**
 * Parse a template containing HTML and Mustache into a simple JSON
 * markup representation
 */
export const parse = (markup: string): VNode => {
  let root: VNode = createVNode("documentfragment");
  let stack: Array<VNode | Block> = [root];

  for (const token of tokenize(markup)) {
    const top = getTop(stack);
    switch (token.type) {
      case "tagopen": {
        const next = createVNode(token.name, token.props);
        top.children.push(next);
        stack.push(next);
        break;
      }
      case "tagclose": {
        const top = stack.pop();
        if (!isVNode(top) || top.name !== token.name) {
          throw new ParseError(`Unexpected closing tag ${token.name}`);
        }
        break;
      }
      case "blockopen": {
        const next = createBlock(token.name);
        top.children.push(next);
        stack.push(next);
        break;
      }
      case "blockclose": {
        const top = stack.pop();
        if (!isBlock(top) || top.name !== token.name) {
          throw new ParseError(`Unexpected closing block ${token.name}`);
        }
        break;
      }
      case "text": {
        top.children.push(token.value);
        break;
      }
      case "var": {
        top.children.push(createVar(token.name));
        break;
      }
      default: {
        throw new ParseError(`Unexpected token ${JSON.stringify(token)}`);
      }
    }
  }

  return root;
};

/** Get top of stack (last element) */
const getTop = (stack: Array<VNode | Block>): VNode | Block | null =>
  stack.at(-1) ?? null;

const MUSTACHE_VAR_REGEX = /^{{(\w+)}}$/;

/** Parse a Mustache var if and only if it is the only element in a string */
export const parseMustacheVar = (markup: string): Var | null => {
  const match = markup.match(MUSTACHE_VAR_REGEX);
  if (match == null) {
    return null;
  }
  const body = match[1];
  return createVar(body);
};

/** Parse view props from attrs */
const parseProps = (attrs: { [key: string]: string }): Props => {
  const result: Props = {};
  for (const [key, value] of Object.entries(attrs)) {
    const parsed = parseMustacheVar(value);
    if (parsed != null) {
      result[key] = parsed;
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
