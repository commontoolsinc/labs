import { Parser } from "htmlparser2";
import { parse as parseMustaches, isHole } from "./hole.js";
import { create as createVNode, VNode, Props } from "./vnode.js";
import * as logger from "./logger.js";

export type TagOpenToken = {
  type: "tagopen";
  tag: string;
  props: Props;
};

export type TagCloseToken = {
  type: "tagclose";
  tag: string;
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
      onopentag(tag, attrs) {
        // We've turned off the namespace feature, so node attributes will
        // contain only string values, not QualifiedAttribute objects.
        const props = parseProps(attrs as { [key: string]: string });
        const token: TagOpenToken = { type: "tagopen", tag, props };
        logger.debug("tagopen", token);
        tokens.push(token);
      },
      onclosetag(tag) {
        const token: TagCloseToken = { type: "tagclose", tag };
        logger.debug("tagopen", token);
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
    const stash = match[1];
    if (stash.startsWith("#")) {
      const token: BlockOpenToken = { type: "blockopen", name: stash.slice(1) };
      logger.debug("blockopen", token);
      tokens.push(token);
    } else if (stash.startsWith("/")) {
      const token: BlockCloseToken = {
        type: "blockclose",
        name: stash.slice(1),
      };
      logger.debug("blockclose", token);
      tokens.push(token);
    } else {
      const token: VarToken = { type: "var", name: stash };
      logger.debug("var", token);
      tokens.push(token);
    }
    lastIndex = mustacheRegex.lastIndex;
  }

  if (lastIndex < text.length) {
    const token: TextToken = {
      type: "text",
      value: text.slice(lastIndex, match.index),
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
  let stack: Array<VNode> = [root];

  for (const token of tokenize(markup)) {
    const top = getTop(stack);
    switch (token.type) {
      case "tagopen": {
        const next = createVNode(token.tag, token.props);
        top.children.push(next);
        stack.push(next);
        break;
      }
      case "tagclose": {
        const vnode = stack.pop();
        if (vnode.tag !== token.tag) {
          throw new ParseError(`Unexpected closing tag ${token.tag}`);
        }
        break;
      }
      case "text": {
        top.children.push(token.value);
        break;
      }
      case "var": {
        top.children.push(token);
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

const getTop = (stack: Array<VNode>): VNode | null => stack.at(-1) ?? null;

const parseProps = (attrs: { [key: string]: string }): Props => {
  const result: Props = {};
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
