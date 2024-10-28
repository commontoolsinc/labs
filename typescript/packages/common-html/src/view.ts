import { Parser } from "htmlparser2";
import * as logger from "./logger.js";
import { path } from "@commontools/common-propagator/path.js";
import { markAsStatic } from "@commontools/common-builder";

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

  markAsStatic(view);

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

export type Gettable<T> = {
  get: () => T;
};

export const get = (value: unknown): unknown => {
  const subject = value as Gettable<unknown>;
  if (typeof subject?.get === "function" && subject?.get?.length === 0) {
    return subject.get();
  }
  return subject;
};

/** Get context item by key */
export const getContext = path;

/**
 * Dynamic properties. Can either be string type (static) or a Mustache
 * variable (dynamic).
 */
export type Props = { [key: string]: string | Binding };

/** A child in a view can be one of a few things */
export type Child = VNode | Section | Binding | string;

/** A "virtual view node", e.g. a virtual DOM element */
export type VNode = {
  type: "vnode";
  name: string;
  props: Props;
  children: Array<Child>;
};

/** Create a vnode */
export const vnode = (
  name: string,
  props: Props = {},
  children: Array<Child> = []
): VNode => {
  return { type: "vnode", name, props, children };
};

export const isVNode = (value: unknown): value is VNode => {
  return (value as VNode)?.type === "vnode";
};

/** A mustache variable `{{myvar}}` */
export type Binding = {
  type: "binding";
  name: string;
  path: Array<string>;
};

export const binding = (name: string): Binding => {
  return { type: "binding", name, path: parsePath(name) };
};

export const parsePath = (pathString: string): Array<string> => {
  if (pathString === ".") {
    const path: Array<string> = [];
    logger.debug("parsePath", path);
    return path;
  }
  const path = pathString.split(".");
  logger.debug("parsePath", path);
  return path;
};

export const isBinding = (value: unknown): value is Binding => {
  return (value as Binding)?.type === "binding";
};

export const markupBinding = (name: string) => `{{${name}}}`;

/** A mustache block `{{#myblock}} ... {{/myblock}}` */
export type Section = {
  type: "section";
  name: string;
  path: Array<string>;
  children: Array<Child>;
};

export const section = (name: string, children: Array<Child> = []): Section => {
  return { type: "section", name, path: parsePath(name), children };
};

export const isSection = (value: unknown): value is Section => {
  return (value as Section)?.type === "section";
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

export type BindingToken = {
  type: "binding";
  name: string;
};

export type SectionOpenToken = {
  type: "sectionopen";
  name: string;
};

export type SectionCloseToken = {
  type: "sectionclose";
  name: string;
};

export type Token =
  | TagOpenToken
  | TagCloseToken
  | TextToken
  | BindingToken
  | SectionOpenToken
  | SectionCloseToken;

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
    }
  );

  parser.write(markup);
  parser.end();

  return tokens;
};

const MUSTACHE_REGEXP = /{{([^\}]+)}}/;
const MUSTACHE_REGEXP_G = new RegExp(MUSTACHE_REGEXP, "g");

/** Tokenize Mustache */
export const tokenizeMustache = (text: string): Array<Token> => {
  const tokens: Array<Token> = [];
  MUSTACHE_REGEXP_G.lastIndex = 0;
  let lastIndex = 0;
  let match: RegExpMatchArray | null = null;
  while ((match = MUSTACHE_REGEXP_G.exec(text)) !== null) {
    if (match.index! > lastIndex) {
      const token: TextToken = {
        type: "text",
        value: text.slice(lastIndex, match.index),
      };
      logger.debug("text", token);
      tokens.push(token);
    }
    const body = match[1];
    if (body.startsWith("#")) {
      const token: SectionOpenToken = {
        type: "sectionopen",
        name: body.slice(1),
      };
      logger.debug("sectionopen", token);
      tokens.push(token);
    } else if (body.startsWith("/")) {
      const token: SectionCloseToken = {
        type: "sectionclose",
        name: body.slice(1),
      };
      logger.debug("sectionclose", token);
      tokens.push(token);
    } else {
      const token: BindingToken = { type: "binding", name: body };
      logger.debug("binding", token);
      tokens.push(token);
    }
    lastIndex = MUSTACHE_REGEXP_G.lastIndex;
  }

  if (lastIndex < text.length) {
    const token: TextToken = {
      type: "text",
      value: text.slice(lastIndex),
    };
    logger.debug("text", token);
    tokens.push(token);
  }

  MUSTACHE_REGEXP.lastIndex = 0;

  return tokens;
};

/**
 * Parse a template containing HTML and Mustache into a simple JSON
 * markup representation
 */
export const parse = (markup: string): VNode => {
  let root: VNode = vnode("documentfragment");
  let stack: Array<VNode | Section> = [root];

  for (const token of tokenize(markup)) {
    const top = getTop(stack)!;
    switch (token.type) {
      case "tagopen": {
        const next = vnode(token.name, token.props);
        top.children.push(next);
        stack.push(next);
        break;
      }
      case "tagclose": {
        const top = stack.pop();
        if (!isVNode(top) || top.name !== token.name) {
          throw new ParseError(
            `Unexpected closing tag ${token.name} in ${top?.name}`
          );
        }
        break;
      }
      case "sectionopen": {
        const next = section(token.name);
        top.children.push(next);
        stack.push(next);
        break;
      }
      case "sectionclose": {
        const top = stack.pop();
        if (!isSection(top) || top.name !== token.name) {
          throw new ParseError(
            `Unexpected closing block ${token.name} in ${top?.name}`
          );
        }
        break;
      }
      case "text": {
        top.children.push(token.value);
        break;
      }
      case "binding": {
        top.children.push(binding(token.name));
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
const getTop = (stack: Array<VNode | Section>): VNode | Section | null =>
  stack.at(-1) ?? null;

/** Parse a Mustache var if and only if it is the only element in a string */
export const parseMustacheBinding = (markup: string): Binding | null => {
  const match = markup.match(MUSTACHE_REGEXP);
  if (match == null) {
    return null;
  }
  const body = match[1];
  // Blocks are not allowed
  if (body.startsWith("#") || body.startsWith("/")) {
    throw new ParseError(`Unexpected block ${body}`);
  }
  return binding(body);
};

/** Parse view props from attrs */
const parseProps = (attrs: { [key: string]: string }): Props => {
  const result: Props = {};
  for (const [key, value] of Object.entries(attrs)) {
    const parsed = parseMustacheBinding(value);
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
