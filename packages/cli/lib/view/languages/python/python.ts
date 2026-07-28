/**
 * A lossless Python highlighter for the pager. The scanner follows Python's
 * lexical tokens while remaining lenient enough to colour a file during an
 * incomplete edit. It recognises current string prefixes, multiline strings,
 * identifiers, keywords, numeric forms, comments, operators, and delimiters.
 *
 * The scanner consumes the complete document because a triple-quoted string can
 * determine the colour of later lines. It does not execute Python or require a
 * Python installation.
 */
import type { Document, Line, Span, TokenClass } from "../../model.ts";
import { cpLen } from "../../ansi.ts";
import { computeLineStarts, lineIndexOf } from "../../lines.ts";
import type { Highlighter } from "../language.ts";

/** Whether `fileName` names a Python source or stub file. */
export function isPythonPath(fileName: string | undefined): boolean {
  return fileName !== undefined && /\.(py|pyi|pyw)$/i.test(fileName);
}

interface Token {
  readonly start: number;
  readonly end: number;
  readonly cls: TokenClass;
  readonly bracketDepth?: number;
  readonly text?: string;
}

interface StringStart {
  readonly quoteStart: number;
  readonly quote: "'" | '"';
  readonly triple: boolean;
  readonly formatted: boolean;
}

const STRING_PREFIXES = new Set([
  "b",
  "f",
  "r",
  "t",
  "u",
  "br",
  "fr",
  "rb",
  "rf",
  "rt",
  "tr",
]);

const BOOLEAN_WORDS = new Set(["False", "True"]);
const OPERATOR_WORDS = new Set(["and", "in", "is", "not", "or"]);
const CONTROL_WORDS = new Set([
  "break",
  "continue",
  "elif",
  "else",
  "except",
  "finally",
  "for",
  "if",
  "pass",
  "raise",
  "return",
  "try",
  "while",
  "with",
  "yield",
]);
const STORAGE_WORDS = new Set([
  "class",
  "def",
  "del",
  "global",
  "lambda",
  "nonlocal",
]);
const KEYWORDS = new Set([
  "None",
  "as",
  "assert",
  "async",
  "await",
  "from",
  "import",
]);

const OPERATORS = [
  "**=",
  "//=",
  "<<=",
  ">>=",
  ":=",
  "!=",
  "%=",
  "&=",
  "**",
  "*=",
  "+=",
  "-=",
  "->",
  "//",
  "/=",
  "<<",
  "<=",
  "==",
  ">=",
  ">>",
  "@=",
  "^=",
  "|=",
  "%",
  "&",
  "*",
  "+",
  "-",
  "/",
  "<",
  "=",
  ">",
  "@",
  "^",
  "|",
  "~",
] as const;

const ASSIGNMENT_OPERATORS = [
  "**=",
  "//=",
  "<<=",
  ">>=",
  "%=",
  "&=",
  "*=",
  "+=",
  "-=",
  "/=",
  "=",
  "@=",
  "^=",
  "|=",
] as const;

const OPEN_TO_CLOSE = new Map([
  ["(", ")"],
  ["[", "]"],
  ["{", "}"],
]);
const CLOSE_TO_OPEN = new Map([
  [")", "("],
  ["]", "["],
  ["}", "{"],
]);

const ID_START = /^\p{ID_Start}$/u;
const ID_CONTINUE = /^\p{ID_Continue}$/u;

/** Tokenise `text` into a gapless sequence that covers every source character. */
function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  const brackets: string[] = [];
  let declaration: "class" | "function" | undefined;
  let previous: Token | undefined;
  let i = 0;

  const add = (
    start: number,
    end: number,
    cls: TokenClass,
    bracketDepth?: number,
    tokenText?: string,
  ): Token => {
    const token = bracketDepth === undefined
      ? { start, end, cls, text: tokenText }
      : { start, end, cls, bracketDepth, text: tokenText };
    tokens.push(token);
    return token;
  };

  while (i < text.length) {
    const c = text[i];
    if (isWhitespace(c)) {
      let end = i + 1;
      while (end < text.length && isWhitespace(text[end])) end++;
      add(i, end, "whitespace");
      i = end;
      continue;
    }

    if (c === "#") {
      let end = i + 1;
      while (end < text.length && text[end] !== "\n") end++;
      add(i, end, "comment");
      i = end;
      continue;
    }

    const string = stringStartAt(text, i);
    if (string) {
      const end = scanString(text, string);
      const token = add(
        i,
        end,
        string.formatted ? "template" : "string",
      );
      previous = token;
      declaration = undefined;
      i = end;
      continue;
    }

    if (isDigit(c) || (c === "." && isDigit(text[i + 1]))) {
      const end = scanNumber(text, i);
      const token = add(i, end, "number");
      previous = token;
      declaration = undefined;
      i = end;
      continue;
    }

    if (isIdentifierStart(text, i)) {
      const end = scanIdentifier(text, i);
      const word = text.slice(i, end);
      let cls: TokenClass;
      if (declaration !== undefined) {
        cls = declaration === "function" ? "functionName" : "interfaceName";
        declaration = undefined;
      } else {
        cls = identifierClass(text, i, end, word, previous, brackets.length);
      }
      const token = add(i, end, cls, undefined, word);
      previous = token;
      if (word === "def") declaration = "function";
      else if (word === "class") declaration = "class";
      i = end;
      continue;
    }

    if (OPEN_TO_CLOSE.has(c)) {
      const token = add(i, i + 1, "bracket", brackets.length, c);
      brackets.push(c);
      previous = token;
      declaration = undefined;
      i++;
      continue;
    }

    const expectedOpen = CLOSE_TO_OPEN.get(c);
    if (expectedOpen !== undefined) {
      if (brackets.at(-1) === expectedOpen) brackets.pop();
      const token = add(i, i + 1, "bracket", brackets.length, c);
      previous = token;
      declaration = undefined;
      i++;
      continue;
    }

    if (text.startsWith("...", i)) {
      const token = add(i, i + 3, "keyword", undefined, "...");
      previous = token;
      declaration = undefined;
      i += 3;
      continue;
    }

    const operator = OPERATORS.find((candidate) =>
      text.startsWith(candidate, i)
    );
    if (operator !== undefined) {
      const token = add(
        i,
        i + operator.length,
        "operator",
        undefined,
        operator,
      );
      previous = token;
      declaration = undefined;
      i += operator.length;
      continue;
    }

    if (c === "," || c === ":" || c === "." || c === ";" || c === "\\") {
      const token = add(i, i + 1, "punctuation", undefined, c);
      previous = token;
      declaration = undefined;
      i++;
      continue;
    }

    const size = codePointSize(text, i);
    const token = add(i, i + size, "plain");
    previous = token;
    declaration = undefined;
    i += size;
  }
  return tokens;
}

function identifierClass(
  text: string,
  start: number,
  end: number,
  word: string,
  previous: Token | undefined,
  bracketDepth: number,
): TokenClass {
  if (BOOLEAN_WORDS.has(word)) return "boolean";
  if (OPERATOR_WORDS.has(word)) return "operator";
  if (CONTROL_WORDS.has(word)) return "controlKeyword";
  if (STORAGE_WORDS.has(word)) return "storageKeyword";
  if (KEYWORDS.has(word)) return "keyword";
  if (softKeywordAt(text, start, end, word, bracketDepth)) {
    return word === "type" ? "storageKeyword" : "controlKeyword";
  }
  if (previous?.text === ".") return "propertyName";
  const next = skipHorizontalWhitespace(text, end);
  if (text[next] === "(" || previous?.text === "@") return "callName";
  return "identifier";
}

/**
 * `match`, `case`, and `type` are soft keywords. They retain identifier colour
 * in assignments and calls, while their statement forms receive keyword colour.
 */
function softKeywordAt(
  text: string,
  start: number,
  end: number,
  word: string,
  bracketDepth: number,
): boolean {
  if (word !== "match" && word !== "case" && word !== "type") {
    return false;
  }
  if (word === "type") {
    if (!firstTokenInSimpleStatement(text, start)) return false;
    const next = skipHorizontalWhitespaceAndLineJoins(text, end);
    if (!isIdentifierStart(text, next)) return false;
    const afterName = skipHorizontalWhitespaceAndLineJoins(
      text,
      scanIdentifier(text, next),
    );
    return text[afterName] === "=" ||
      (text[afterName] === "[" && typeParameterListEndsAtEquals(
        text,
        afterName,
      ));
  }
  const next = skipHorizontalWhitespace(text, end);
  if (bracketDepth > 0) return false;
  if (!firstTokenOnPhysicalLine(text, start)) return false;
  if (next === end && (text[end] === "." || text[end] === "[")) {
    return false;
  }
  return statementColonAfter(text, end);
}

function typeParameterListEndsAtEquals(text: string, start: number): boolean {
  const brackets = ["["];
  let i = start + 1;
  while (i < text.length && brackets.length > 0) {
    const c = text[i];
    if (c === "#") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    const string = stringStartAt(text, i);
    if (string) {
      i = scanString(text, string);
      continue;
    }
    if (OPEN_TO_CLOSE.has(c)) {
      brackets.push(c);
      i++;
      continue;
    }
    const expectedOpen = CLOSE_TO_OPEN.get(c);
    if (expectedOpen !== undefined && brackets.at(-1) === expectedOpen) {
      brackets.pop();
      i++;
      continue;
    }
    i += codePointSize(text, i);
  }
  return brackets.length === 0 &&
    text[skipHorizontalWhitespaceAndLineJoins(text, i)] === "=";
}

function statementColonAfter(text: string, start: number): boolean {
  const brackets: string[] = [];
  let lambdaParameters = 0;
  let content = false;
  let i = start;
  while (i < text.length) {
    const c = text[i];
    if (c === "\n" || c === "\r") {
      if (brackets.length === 0) return false;
      i++;
      continue;
    }
    if (isHorizontalWhitespace(c)) {
      i++;
      continue;
    }
    if (c === "#") {
      if (brackets.length === 0) return false;
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (
      c === "\\" &&
      (text[i + 1] === "\n" ||
        (text[i + 1] === "\r" && text[i + 2] === "\n"))
    ) {
      i += text[i + 1] === "\r" ? 3 : 2;
      continue;
    }
    const string = stringStartAt(text, i);
    if (string) {
      content = true;
      i = scanString(text, string);
      continue;
    }
    if (brackets.length === 0 && isIdentifierStart(text, i)) {
      const end = scanIdentifier(text, i);
      if (text.slice(i, end) === "lambda") lambdaParameters++;
      content = true;
      i = end;
      continue;
    }
    if (OPEN_TO_CLOSE.has(c)) {
      brackets.push(c);
      content = true;
      i++;
      continue;
    }
    const expectedOpen = CLOSE_TO_OPEN.get(c);
    if (expectedOpen !== undefined) {
      if (brackets.at(-1) === expectedOpen) brackets.pop();
      content = true;
      i++;
      continue;
    }
    if (c === ":" && brackets.length === 0) {
      if (text[i + 1] === "=") {
        content = true;
        i += 2;
        continue;
      }
      if (lambdaParameters > 0) {
        lambdaParameters--;
        content = true;
        i++;
        continue;
      }
      return content;
    }
    const assignment = brackets.length === 0
      ? assignmentOperatorAt(text, i)
      : undefined;
    if (assignment !== undefined) {
      if (lambdaParameters === 0 || assignment !== "=") return false;
      content = true;
      i += assignment.length;
      continue;
    }
    content = true;
    i += codePointSize(text, i);
  }
  return false;
}

function assignmentOperatorAt(
  text: string,
  start: number,
): string | undefined {
  if (
    text[start] === "=" &&
    (text[start + 1] === "=" ||
      text[start - 1] === "<" ||
      text[start - 1] === ">" ||
      text[start - 1] === "!" ||
      text[start - 1] === "=")
  ) {
    return undefined;
  }
  return ASSIGNMENT_OPERATORS.find((operator) =>
    text.startsWith(operator, start)
  );
}

function firstTokenOnPhysicalLine(text: string, start: number): boolean {
  const lineStart = text.lastIndexOf("\n", start - 1) + 1;
  for (let i = lineStart; i < start; i++) {
    if (!isHorizontalWhitespace(text[i])) return false;
  }
  return true;
}

function firstTokenInSimpleStatement(text: string, start: number): boolean {
  const lineStart = text.lastIndexOf("\n", start - 1) + 1;
  let i = start - 1;
  while (i >= lineStart && isHorizontalWhitespace(text[i])) i--;
  if (i < lineStart || text[i] === ";") return true;
  if (text[i] !== ":") return false;
  const firstWord = /^[ \t\f\v]*([A-Za-z]+)/.exec(
    text.slice(lineStart, i),
  )?.[1];
  return firstWord !== undefined && INLINE_SUITE_WORDS.has(firstWord);
}

const INLINE_SUITE_WORDS = new Set([
  "async",
  "case",
  "class",
  "def",
  "elif",
  "else",
  "except",
  "finally",
  "for",
  "if",
  "match",
  "try",
  "while",
  "with",
]);

function stringStartAt(text: string, start: number): StringStart | null {
  let quoteStart = start;
  let prefix = "";
  if (text[start] !== "'" && text[start] !== '"') {
    for (const length of [2, 1]) {
      const candidate = text.slice(start, start + length).toLowerCase();
      const quote = text[start + length];
      if (
        STRING_PREFIXES.has(candidate) && (quote === "'" || quote === '"')
      ) {
        prefix = candidate;
        quoteStart = start + length;
        break;
      }
    }
  }
  const quote = text[quoteStart];
  if (quote !== "'" && quote !== '"') return null;
  return {
    quoteStart,
    quote,
    triple: text.startsWith(quote.repeat(3), quoteStart),
    formatted: prefix.includes("f") || prefix.includes("t"),
  };
}

function scanString(text: string, string: StringStart): number {
  const width = string.triple ? 3 : 1;
  const delimiter = string.quote.repeat(width);
  let i = string.quoteStart + width;
  while (i < text.length) {
    if (text.startsWith(delimiter, i)) return i + width;
    const c = text[i];
    if (!string.triple && (c === "\n" || c === "\r")) return i;
    if (c === "\\") {
      if (
        string.formatted &&
        (text[i + 1] === "{" || text[i + 1] === "}")
      ) {
        i++;
      } else {
        i = scanEscape(text, i);
      }
      continue;
    }
    if (string.formatted && c === "{") {
      if (text[i + 1] === "{") {
        i += 2;
      } else {
        i = scanReplacementField(text, i + 1, string.triple);
      }
      continue;
    }
    i += codePointSize(text, i);
  }
  return text.length;
}

/**
 * Find the end of one formatted-string replacement field. Nested collections
 * and nested strings shield their braces, including Python 3.12's same-quote
 * f-string expressions.
 */
function scanReplacementField(
  text: string,
  start: number,
  outerMultiline: boolean,
): number {
  const brackets: string[] = [];
  let formatSpec = false;
  let firstLineBreak: number | undefined;
  let i = start;
  while (i < text.length) {
    const c = text[i];
    if (
      !outerMultiline && firstLineBreak === undefined &&
      (c === "\n" || c === "\r")
    ) {
      firstLineBreak = i;
    }
    if (formatSpec) {
      if (c === "{") {
        if (text[i + 1] === "{") {
          i += 2;
        } else {
          i = scanReplacementField(text, i + 1, outerMultiline);
        }
        continue;
      }
      if (c === "}") return i + 1;
      i += codePointSize(text, i);
      continue;
    }
    if (c === "#") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    const nested = stringStartAt(text, i);
    if (nested) {
      i = scanString(text, nested);
      continue;
    }
    if (OPEN_TO_CLOSE.has(c)) {
      brackets.push(c);
      i++;
      continue;
    }
    const expectedOpen = CLOSE_TO_OPEN.get(c);
    if (expectedOpen !== undefined) {
      if (c === "}" && brackets.length === 0) return i + 1;
      if (brackets.at(-1) === expectedOpen) brackets.pop();
      i++;
      continue;
    }
    if (c === ":" && brackets.length === 0 && text[i + 1] !== "=") {
      formatSpec = true;
      i++;
      continue;
    }
    if (c === "\\") {
      i = scanEscape(text, i);
      continue;
    }
    i += codePointSize(text, i);
  }
  return firstLineBreak ?? text.length;
}

function scanEscape(text: string, start: number): number {
  return text[start + 1] === "\r" && text[start + 2] === "\n"
    ? start + 3
    : Math.min(text.length, start + 2);
}

function scanNumber(text: string, start: number): number {
  let i = start;
  if (text[i] === ".") {
    i = scanDigitPart(text, i + 1, isDigit);
  } else if (
    text[i] === "0" &&
    (text[i + 1] === "b" || text[i + 1] === "B")
  ) {
    i = scanBasedInteger(text, i + 2, (c) => c === "0" || c === "1");
    return i;
  } else if (
    text[i] === "0" &&
    (text[i + 1] === "o" || text[i + 1] === "O")
  ) {
    i = scanBasedInteger(text, i + 2, (c) => c >= "0" && c <= "7");
    return i;
  } else if (
    text[i] === "0" &&
    (text[i + 1] === "x" || text[i + 1] === "X")
  ) {
    i = scanBasedInteger(text, i + 2, isHexDigit);
    return i;
  } else {
    i = scanDigitPart(text, i, isDigit);
    if (text[i] === ".") {
      i = scanDigitPart(text, i + 1, isDigit);
    }
  }
  if (text[i] === "e" || text[i] === "E") {
    let exponent = i + 1;
    if (text[exponent] === "+" || text[exponent] === "-") exponent++;
    if (isDigit(text[exponent])) i = scanDigitPart(text, exponent, isDigit);
  }
  return scanImaginarySuffix(text, i);
}

function scanBasedInteger(
  text: string,
  start: number,
  digit: (value: string) => boolean,
): number {
  let i = start;
  if (text[i] === "_" && digit(text[i + 1])) i++;
  return scanDigitPart(text, i, digit);
}

function scanDigitPart(
  text: string,
  start: number,
  digit: (value: string) => boolean,
): number {
  let i = start;
  while (
    digit(text[i]) ||
    (text[i] === "_" && digit(text[i - 1]) && digit(text[i + 1]))
  ) {
    i++;
  }
  return i;
}

function scanImaginarySuffix(text: string, end: number): number {
  return text[end] === "j" || text[end] === "J" ? end + 1 : end;
}

function scanIdentifier(text: string, start: number): number {
  let i = start + codePointSize(text, start);
  while (isIdentifierContinue(text, i)) i += codePointSize(text, i);
  return i;
}

function isIdentifierStart(text: string, offset: number): boolean {
  const value = codePointAt(text, offset);
  return value === "_" || (value !== undefined && ID_START.test(value));
}

function isIdentifierContinue(text: string, offset: number): boolean {
  const value = codePointAt(text, offset);
  return value === "_" || (value !== undefined && ID_CONTINUE.test(value));
}

function codePointAt(text: string, offset: number): string | undefined {
  const point = text.codePointAt(offset);
  return point === undefined ? undefined : String.fromCodePoint(point);
}

function codePointSize(text: string, offset: number): number {
  return (text.codePointAt(offset) ?? 0) > 0xffff ? 2 : 1;
}

function isDigit(value: string | undefined): boolean {
  return value !== undefined && value >= "0" && value <= "9";
}

function isHexDigit(value: string): boolean {
  return isDigit(value) ||
    (value >= "a" && value <= "f") ||
    (value >= "A" && value <= "F");
}

function isWhitespace(value: string): boolean {
  return isHorizontalWhitespace(value) || value === "\n" || value === "\r";
}

function isHorizontalWhitespace(value: string): boolean {
  return value === " " || value === "\t" || value === "\f" || value === "\v";
}

function skipHorizontalWhitespace(text: string, start: number): number {
  let i = start;
  while (i < text.length && isHorizontalWhitespace(text[i])) i++;
  return i;
}

function skipHorizontalWhitespaceAndLineJoins(
  text: string,
  start: number,
): number {
  let i = start;
  while (i < text.length) {
    i = skipHorizontalWhitespace(text, i);
    if (text[i] !== "\\") return i;
    if (text[i + 1] === "\n") {
      i += 2;
      continue;
    }
    if (text[i + 1] === "\r" && text[i + 2] === "\n") {
      i += 3;
      continue;
    }
    return i;
  }
  return i;
}

/** Split whole-document tokens across physical lines and compute span columns. */
export function pythonHighlightLines(text: string): Line[] {
  const lineStarts = computeLineStarts(text);
  const rawLines = text.split("\n");
  const spans: Span[][] = rawLines.map(() => []);
  const columns = rawLines.map(() => 0);
  for (const token of tokenize(text)) {
    let position = token.start;
    let line = lineIndexOf(lineStarts, position);
    while (position < token.end && line < rawLines.length) {
      const lineEnd = line + 1 < lineStarts.length
        ? lineStarts[line + 1] - 1
        : text.length;
      const segmentEnd = Math.min(token.end, lineEnd);
      if (segmentEnd > position) {
        const segment = text.slice(position, segmentEnd);
        spans[line].push(
          token.bracketDepth === undefined
            ? {
              col: columns[line],
              text: segment,
              cls: token.cls,
            }
            : {
              col: columns[line],
              text: segment,
              cls: token.cls,
              bracketDepth: token.bracketDepth,
            },
        );
        columns[line] += cpLen(segment);
      }
      if (segmentEnd < token.end) {
        line++;
        position = lineStarts[line] ?? token.end;
      } else {
        position = segmentEnd;
      }
    }
  }
  return rawLines.map((line, index) => ({
    text: line,
    spans: spans[index],
  }));
}

/** A full Python document with syntax colouring and no semantic structure. */
export function pythonDocument(text: string): Document {
  return {
    text,
    lines: pythonHighlightLines(text),
    structure: [],
    flatStructure: [],
    definitions: new Map(),
  };
}

/** Whole-document highlighting preserves multiline-string state after edits. */
export function createPythonHighlighter(initial: string): Highlighter {
  let lines = pythonHighlightLines(initial);
  return {
    get lines() {
      return lines;
    },
    update(text: string): readonly Line[] {
      lines = pythonHighlightLines(text);
      return lines;
    },
  };
}
