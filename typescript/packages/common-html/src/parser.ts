import { Parser } from "htmlparser2";
import * as logger from "./logger.js";

export type Props = { [key: string]: string | Var };

export type Node = VNode | Block | Var | string;

export type VNode = {
  type: "vnode";
  name: string;
  props: Props;
  children: Array<Node>;
};

export const createVNode = (
  name: string,
  props: Props = {},
  children: Array<Node> = [],
): VNode => {
  return { type: "vnode", name, props, children };
};

export const isVNode = (value: unknown): value is VNode => {
  return (value as VNode)?.type === "vnode";
};

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

export type Block = {
  type: "block";
  name: string;
  children: Array<Node>;
};

export const createBlock = (
  name: string,
  children: Array<Node> = [],
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
        const parsed = tokenizeMustaches(text.trim());
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

const mustacheRegex = /{{(\w+)}}/g;

const tokenizeMustaches = (text: string): Array<Token> => {
  const tokens: Array<Token> = [];
  let lastIndex = 0;
  let match: RegExpMatchArray | null = null;

  while ((match = mustacheRegex.exec(text)) !== null) {
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
    lastIndex = mustacheRegex.lastIndex;
  }

  if (lastIndex < text.length) {
    const token: TextToken = {
      type: "text",
      value: text.slice(lastIndex),
    };
    logger.debug("text", token);
    tokens.push(token);
  }

  mustacheRegex.lastIndex = 0;

  return tokens;
};

/** Parse a template into a simple JSON markup representation */
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

export default parse;

const getTop = (stack: Array<VNode | Block>): VNode | Block | null =>
  stack.at(-1) ?? null;

const parseProps = (attrs: { [key: string]: string }): Props => {
  const result: Props = {};
  for (const [key, value] of Object.entries(attrs)) {
    const parsed = tokenizeMustaches(value);
    const first = parsed.at(0);
    if (parsed.length !== 1) {
      result[key] = "";
    } else if (isVar(first)) {
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
