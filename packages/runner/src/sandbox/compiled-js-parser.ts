export interface SourceRange {
  start: number;
  end: number;
}

export interface StatementChunk extends SourceRange {
  text: string;
}

export interface IdentifierToken extends SourceRange {
  text: string;
}

export interface ParsedBlock extends SourceRange {
  statements: StatementChunk[];
}

export interface ParsedFunction extends SourceRange {
  text: string;
  params: string[];
  body: ParsedBlock;
}

export interface ParsedDefineCall {
  statement: StatementChunk;
  moduleId: string;
  dependencies: string[];
  factory: ParsedFunction;
}

export interface ParsedBundle {
  body: ParsedBlock;
  defineCalls: ParsedDefineCall[];
}

export class CompiledJsParseError extends Error {
  constructor(
    readonly offset: number,
    message: string,
  ) {
    super(message);
    this.name = "CompiledJsParseError";
  }
}

const BLOCK_TERMINATED_KEYWORDS = new Set([
  "class",
  "do",
  "for",
  "function",
  "if",
  "switch",
  "try",
  "while",
]);

const REGEX_PREFIX_KEYWORDS = new Set([
  "case",
  "delete",
  "else",
  "in",
  "instanceof",
  "new",
  "return",
  "throw",
  "typeof",
  "void",
  "yield",
]);

const IDENTIFIER_RE = /^[A-Za-z_$][\w$]*$/;

interface ScanState {
  parenDepth: number;
  braceDepth: number;
  bracketDepth: number;
  regexAllowed: boolean;
}

export function parseCompiledBundleSource(
  source: string,
): ParsedBundle {
  const outer = parseWrappedFunction(source);
  const body = parseBlock(source, outer.body.start, outer.body.end);
  const defineCalls: ParsedDefineCall[] = [];

  for (const statement of body.statements) {
    const defineCall = tryParseDefineCall(source, statement);
    if (defineCall) {
      defineCalls.push(defineCall);
    }
  }

  return {
    body,
    defineCalls,
  };
}

export function stripJsTrivia(
  source: string,
  start = 0,
  end = source.length,
): string {
  let cursor = start;
  let output = "";
  const state: ScanState = {
    parenDepth: 0,
    braceDepth: 0,
    bracketDepth: 0,
    regexAllowed: true,
  };

  while (cursor < end) {
    const tokenStart = skipTrivia(source, cursor, end);
    if (tokenStart >= end) break;
    const tokenEnd = advanceScanner(source, tokenStart, end, state);
    output += source.slice(tokenStart, tokenEnd);
    cursor = tokenEnd;
  }

  return output;
}

export function parseBlock(
  source: string,
  start: number,
  end: number,
): ParsedBlock {
  return {
    start,
    end,
    statements: splitTopLevelStatements(source, start, end),
  };
}

export function parseFunctionText(
  source: string,
  start: number,
  end: number,
): ParsedFunction {
  const text = source.slice(start, end);
  const trimmed = trimRange(source, start, end);
  const inner = stripWholeParentheses(source, trimmed.start, trimmed.end);
  const functionStart = inner.start;
  const firstWord = readLeadingIdentifier(source, functionStart, inner.end);
  let functionKeyword = firstWord;
  if (firstWord?.text === "async") {
    const asyncEnd = skipTrivia(source, firstWord.end, inner.end);
    const maybeFunction = readLeadingIdentifier(source, asyncEnd, inner.end);
    if (maybeFunction?.text === "function") {
      functionKeyword = maybeFunction;
    }
  }

  if (functionKeyword?.text === "function") {
    const paramsStart = skipTrivia(source, functionKeyword.end, inner.end);
    const openParen = expectChar(source, paramsStart, inner.end, "(");
    const closeParen = findMatchingDelimiter(source, openParen, "(", ")");
    const bodyStart = skipTrivia(source, closeParen + 1, inner.end);
    const openBrace = expectChar(source, bodyStart, inner.end, "{");
    const closeBrace = findMatchingDelimiter(source, openBrace, "{", "}");
    const afterBody = skipTrivia(source, closeBrace + 1, inner.end);
    if (afterBody !== inner.end) {
      throw new CompiledJsParseError(
        afterBody,
        "Function expression contains trailing tokens",
      );
    }
    return {
      start: inner.start,
      end: inner.end,
      text,
      params: parseParameterNames(
        source.slice(openParen + 1, closeParen),
        openParen + 1,
      ),
      body: parseBlock(source, openBrace + 1, closeBrace),
    };
  }

  const arrowIndex = findTopLevelArrow(source, inner.start, inner.end);
  if (arrowIndex === undefined) {
    throw new CompiledJsParseError(
      inner.start,
      "Expected a direct function expression",
    );
  }
  const params = parseArrowParameterNames(
    source,
    inner.start,
    arrowIndex,
  );
  const bodyStart = skipTrivia(source, arrowIndex + 2, inner.end);
  const openBrace = expectChar(source, bodyStart, inner.end, "{");
  const closeBrace = findMatchingDelimiter(source, openBrace, "{", "}");
  const afterBody = skipTrivia(source, closeBrace + 1, inner.end);
  if (afterBody !== inner.end) {
    throw new CompiledJsParseError(
      afterBody,
      "Arrow function must use a block body",
    );
  }
  return {
    start: inner.start,
    end: inner.end,
    text,
    params,
    body: parseBlock(source, openBrace + 1, closeBrace),
  };
}

export function tryParseDefineCall(
  source: string,
  statement: StatementChunk,
): ParsedDefineCall | undefined {
  const trimmed = trimRange(source, statement.start, statement.end);
  const call = tryParseCallExpression(source, trimmed.start, trimmed.end);
  if (!call || call.callee !== "define") {
    return undefined;
  }
  if (call.args.length !== 3) {
    throw new CompiledJsParseError(
      call.start,
      "AMD define() calls must include id, dependencies, and factory",
    );
  }
  const moduleId = parseStringLiteralValue(
    source,
    call.args[0].start,
    call.args[0].end,
  );
  const dependencies = parseStringArrayLiteral(
    source,
    call.args[1].start,
    call.args[1].end,
  );
  const factory = parseFunctionText(
    source,
    call.args[2].start,
    call.args[2].end,
  );
  return {
    statement,
    moduleId,
    dependencies,
    factory,
  };
}

export function splitTopLevelCommaList(
  source: string,
  start: number,
  end: number,
): SourceRange[] {
  const parts: SourceRange[] = [];
  let cursor = skipTrivia(source, start, end);
  let segmentStart = cursor;
  const state: ScanState = {
    parenDepth: 0,
    braceDepth: 0,
    bracketDepth: 0,
    regexAllowed: true,
  };

  while (cursor < end) {
    const char = source[cursor];
    if (
      char === "," &&
      state.parenDepth === 0 &&
      state.braceDepth === 0 &&
      state.bracketDepth === 0
    ) {
      const part = trimRange(source, segmentStart, cursor);
      if (part.start < part.end) {
        parts.push(part);
      }
      cursor++;
      cursor = skipTrivia(source, cursor, end);
      segmentStart = cursor;
      state.regexAllowed = true;
      continue;
    }
    cursor = advanceScanner(source, cursor, end, state);
  }

  const tail = trimRange(source, segmentStart, end);
  if (tail.start < tail.end) {
    parts.push(tail);
  }
  return parts;
}

export function findTopLevelEquals(
  source: string,
  start: number,
  end: number,
): number | undefined {
  const state: ScanState = {
    parenDepth: 0,
    braceDepth: 0,
    bracketDepth: 0,
    regexAllowed: true,
  };

  for (let cursor = start; cursor < end;) {
    const char = source[cursor];
    if (
      char === "=" &&
      state.parenDepth === 0 &&
      state.braceDepth === 0 &&
      state.bracketDepth === 0 &&
      source[cursor + 1] !== "=" &&
      source[cursor + 1] !== ">" &&
      source[cursor - 1] !== "+" &&
      source[cursor - 1] !== "-" &&
      source[cursor - 1] !== "*" &&
      source[cursor - 1] !== "/" &&
      source[cursor - 1] !== "%" &&
      source[cursor - 1] !== "^" &&
      source[cursor - 1] !== "&" &&
      source[cursor - 1] !== "|" &&
      source[cursor - 1] !== "?" &&
      source[cursor - 1] !== "!" &&
      source[cursor - 1] !== "<" &&
      source[cursor - 1] !== ">"
    ) {
      return cursor;
    }
    cursor = advanceScanner(source, cursor, end, state);
  }

  return undefined;
}

export function collectIdentifierTokens(
  source: string,
  start: number,
  end: number,
): IdentifierToken[] {
  const identifiers: IdentifierToken[] = [];
  const state: ScanState = {
    parenDepth: 0,
    braceDepth: 0,
    bracketDepth: 0,
    regexAllowed: true,
  };

  for (let cursor = start; cursor < end;) {
    const tokenStart = skipTrivia(source, cursor, end);
    if (tokenStart >= end) {
      break;
    }
    const identifier = tryReadIdentifier(source, tokenStart, end);
    if (identifier) {
      identifiers.push(identifier);
      state.regexAllowed = !endsExpression(identifier.text);
      cursor = identifier.end;
      continue;
    }
    cursor = advanceScanner(source, tokenStart, end, state);
  }

  return identifiers;
}

export function locationFromOffset(
  source: string,
  offset: number,
): { line: number; column: number } {
  let line = 1;
  let column = 1;
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source[i] === "\n") {
      line++;
      column = 1;
    } else {
      column++;
    }
  }
  return { line, column };
}

function parseWrappedFunction(source: string): ParsedFunction {
  const trimmed = trimRange(source, 0, source.length);
  if (trimmed.start === trimmed.end) {
    throw new CompiledJsParseError(0, "Compiled bundle cannot be empty");
  }

  const candidates: SourceRange[] = [];
  const seen = new Set<string>();
  const pushCandidate = (range: SourceRange) => {
    const key = `${range.start}:${range.end}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(range);
  };

  const stripped = stripWholeParentheses(source, trimmed.start, trimmed.end);
  pushCandidate(stripped);

  let semicolonTrimmed = stripped;
  if (source[semicolonTrimmed.end - 1] === ";") {
    semicolonTrimmed = trimRange(
      source,
      semicolonTrimmed.start,
      semicolonTrimmed.end - 1,
    );
    pushCandidate(stripWholeParentheses(
      source,
      semicolonTrimmed.start,
      semicolonTrimmed.end,
    ));
  }

  let manuallyUnwrapped = semicolonTrimmed;
  while (
    manuallyUnwrapped.start < manuallyUnwrapped.end &&
    source[manuallyUnwrapped.start] === "(" &&
    source[manuallyUnwrapped.end - 1] === ")"
  ) {
    manuallyUnwrapped = trimRange(
      source,
      manuallyUnwrapped.start + 1,
      manuallyUnwrapped.end - 1,
    );
    pushCandidate(manuallyUnwrapped);
    const manuallyStripped = stripWholeParentheses(
      source,
      manuallyUnwrapped.start,
      manuallyUnwrapped.end,
    );
    pushCandidate(manuallyStripped);
    if (
      manuallyStripped.start === manuallyUnwrapped.start &&
      manuallyStripped.end === manuallyUnwrapped.end
    ) {
      break;
    }
    manuallyUnwrapped = manuallyStripped;
  }

  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      return parseFunctionText(source, candidate.start, candidate.end);
    } catch (error) {
      lastError = error;
    }
  }

  if (lastError instanceof Error) {
    throw lastError;
  }
  throw new CompiledJsParseError(0, "Expected a direct function expression");
}

function splitTopLevelStatements(
  source: string,
  start: number,
  end: number,
): StatementChunk[] {
  const statements: StatementChunk[] = [];
  let cursor = skipTrivia(source, start, end);

  while (cursor < end) {
    const statementStart = cursor;
    const firstWord = tryReadIdentifier(source, cursor, end)?.text;
    const blockTerminated = firstWord
      ? BLOCK_TERMINATED_KEYWORDS.has(firstWord)
      : false;
    const state: ScanState = {
      parenDepth: 0,
      braceDepth: 0,
      bracketDepth: 0,
      regexAllowed: true,
    };

    while (cursor < end) {
      const beforeBraceDepth = state.braceDepth;
      const before = cursor;
      const char = source[cursor];
      cursor = advanceScanner(source, cursor, end, state);

      if (
        char === ";" &&
        state.parenDepth === 0 &&
        state.braceDepth === 0 &&
        state.bracketDepth === 0
      ) {
        statements.push({
          start: statementStart,
          end: cursor,
          text: source.slice(statementStart, cursor),
        });
        break;
      }

      if (
        blockTerminated &&
        char === "}" &&
        beforeBraceDepth === 1 &&
        state.parenDepth === 0 &&
        state.braceDepth === 0 &&
        state.bracketDepth === 0 &&
        firstWord !== undefined &&
        shouldTerminateAfterBlock(source, cursor, end, firstWord)
      ) {
        statements.push({
          start: statementStart,
          end: cursor,
          text: source.slice(statementStart, cursor),
        });
        break;
      }

      if (cursor === before) {
        throw new CompiledJsParseError(
          cursor,
          "Parser did not make progress",
        );
      }
    }

    if (cursor >= end) {
      const tail = trimRange(source, statementStart, end);
      if (tail.start < tail.end) {
        statements.push({
          start: statementStart,
          end,
          text: source.slice(statementStart, end),
        });
      }
      break;
    }

    cursor = skipTrivia(source, cursor, end);
  }

  return statements;
}

function shouldTerminateAfterBlock(
  source: string,
  cursor: number,
  end: number,
  keyword: string,
): boolean {
  if (keyword !== "if") {
    return true;
  }
  const next = tryReadIdentifier(source, skipTrivia(source, cursor, end), end);
  return next?.text !== "else";
}

function parseArrowParameterNames(
  source: string,
  start: number,
  arrowIndex: number,
): string[] {
  const paramsRange = trimRange(source, start, arrowIndex);
  const stripped = stripWholeParentheses(
    source,
    paramsRange.start,
    paramsRange.end,
  );
  const raw = source.slice(stripped.start, stripped.end).trim();
  if (!raw) return [];
  const simple = extractSimpleParameterName(raw);
  if (IDENTIFIER_RE.test(simple)) {
    return [simple];
  }
  return parseParameterNames(raw, stripped.start);
}

function parseParameterNames(
  sourceOrSlice: string,
  baseOffset: number,
): string[] {
  const params = splitTopLevelCommaList(
    sourceOrSlice,
    0,
    sourceOrSlice.length,
  );
  return params.map((range) => {
    const name = extractSimpleParameterName(
      sourceOrSlice.slice(range.start, range.end).trim(),
    );
    if (!IDENTIFIER_RE.test(name)) {
      throw new CompiledJsParseError(
        baseOffset + range.start,
        "Factory parameters must be simple identifiers",
      );
    }
    return name;
  });
}

function extractSimpleParameterName(param: string): string {
  const equals = findTopLevelEquals(param, 0, param.length);
  const candidate = equals === undefined
    ? param
    : param.slice(0, equals).trim();
  return candidate;
}

function parseStringArrayLiteral(
  source: string,
  start: number,
  end: number,
): string[] {
  const trimmed = trimRange(source, start, end);
  const open = expectChar(source, trimmed.start, trimmed.end, "[");
  const close = findMatchingDelimiter(source, open, "[", "]");
  const after = skipTrivia(source, close + 1, trimmed.end);
  if (after !== trimmed.end) {
    throw new CompiledJsParseError(
      after,
      "Array literal contains trailing tokens",
    );
  }
  const elements = splitTopLevelCommaList(source, open + 1, close);
  return elements.map((element) =>
    parseStringLiteralValue(source, element.start, element.end)
  );
}

export function parseStringLiteralValue(
  source: string,
  start: number,
  end: number,
): string {
  const trimmed = trimRange(source, start, end);
  const quote = source[trimmed.start];
  if ((quote !== "'" && quote !== '"') || source[trimmed.end - 1] !== quote) {
    throw new CompiledJsParseError(
      trimmed.start,
      "Expected a string literal",
    );
  }

  let value = "";
  for (let i = trimmed.start + 1; i < trimmed.end - 1; i++) {
    const char = source[i];
    if (char === "\\") {
      i++;
      if (i >= trimmed.end - 1) {
        throw new CompiledJsParseError(i, "Unterminated string escape");
      }
      value += source[i];
      continue;
    }
    value += char;
  }
  return value;
}

export function tryParseCallExpression(
  source: string,
  start: number,
  end: number,
): {
  start: number;
  end: number;
  callee: string;
  args: SourceRange[];
} | undefined {
  let trimmed = trimRange(source, start, end);
  if (source[trimmed.end - 1] === ";") {
    trimmed = trimRange(source, trimmed.start, trimmed.end - 1);
  }
  let openParen: number | undefined;
  for (let cursor = trimmed.start; cursor < trimmed.end;) {
    const char = source[cursor];
    if (char === "(") {
      const closeParen = findMatchingDelimiter(source, cursor, "(", ")");
      if (skipTrivia(source, closeParen + 1, trimmed.end) === trimmed.end) {
        openParen = cursor;
        break;
      }
      cursor = closeParen + 1;
      continue;
    }
    const state: ScanState = {
      parenDepth: 0,
      braceDepth: 0,
      bracketDepth: 0,
      regexAllowed: true,
    };
    cursor = advanceScanner(source, cursor, trimmed.end, state);
  }
  if (openParen === undefined) {
    return undefined;
  }
  const closeParen = findMatchingDelimiter(source, openParen, "(", ")");
  const callee = source.slice(trimmed.start, openParen).trim();
  return {
    start: trimmed.start,
    end: trimmed.end,
    callee,
    args: splitTopLevelCommaList(source, openParen + 1, closeParen),
  };
}

function expectChar(
  source: string,
  start: number,
  end: number,
  expected: string,
): number {
  const cursor = skipTrivia(source, start, end);
  if (source[cursor] !== expected) {
    throw new CompiledJsParseError(
      cursor,
      `Expected '${expected}'`,
    );
  }
  return cursor;
}

function findMatchingDelimiter(
  source: string,
  openIndex: number,
  openChar: "(" | "[" | "{",
  closeChar: ")" | "]" | "}",
): number {
  let depth = 0;
  const state: ScanState = {
    parenDepth: 0,
    braceDepth: 0,
    bracketDepth: 0,
    regexAllowed: true,
  };

  for (let cursor = openIndex; cursor < source.length;) {
    const char = source[cursor];
    if (char === openChar) {
      depth++;
      if (char === "(") {
        state.parenDepth++;
      } else if (char === "[") {
        state.bracketDepth++;
      } else {
        state.braceDepth++;
      }
      state.regexAllowed = true;
    } else if (char === closeChar) {
      depth--;
      if (char === ")") {
        state.parenDepth = Math.max(0, state.parenDepth - 1);
      } else if (char === "]") {
        state.bracketDepth = Math.max(0, state.bracketDepth - 1);
      } else {
        state.braceDepth = Math.max(0, state.braceDepth - 1);
      }
      state.regexAllowed = false;
      if (depth === 0) {
        return cursor;
      }
    }

    if (char === openChar || char === closeChar) {
      cursor++;
      continue;
    }

    cursor = advanceScanner(source, cursor, source.length, state);
  }

  throw new CompiledJsParseError(
    openIndex,
    `Unterminated '${openChar}${closeChar}' pair`,
  );
}

export function stripWholeParentheses(
  source: string,
  start: number,
  end: number,
): SourceRange {
  let range = trimRange(source, start, end);
  while (source[range.start] === "(") {
    const close = findMatchingDelimiter(source, range.start, "(", ")");
    if (skipTrivia(source, close + 1, range.end) !== range.end) {
      break;
    }
    range = trimRange(source, range.start + 1, close);
  }
  return range;
}

export function trimRange(
  source: string,
  start: number,
  end: number,
): SourceRange {
  const state: ScanState = {
    parenDepth: 0,
    braceDepth: 0,
    bracketDepth: 0,
    regexAllowed: true,
  };

  let cursor = skipTrivia(source, start, end);
  let firstTokenStart: number | undefined;
  let lastTokenEnd = cursor;

  while (cursor < end) {
    const tokenStart = skipTrivia(source, cursor, end);
    if (tokenStart >= end) {
      break;
    }
    if (firstTokenStart === undefined) {
      firstTokenStart = tokenStart;
    }
    const tokenEnd = advanceScanner(source, tokenStart, end, state);
    lastTokenEnd = tokenEnd;
    cursor = tokenEnd;
  }

  if (firstTokenStart === undefined) {
    return { start: end, end };
  }

  return { start: firstTokenStart, end: lastTokenEnd };
}

function skipTrivia(
  source: string,
  start: number,
  end: number,
): number {
  let cursor = start;
  while (cursor < end) {
    const char = source[cursor];
    if (/\s/.test(char)) {
      cursor++;
      continue;
    }
    if (char === "/" && source[cursor + 1] === "/") {
      cursor += 2;
      while (cursor < end && source[cursor] !== "\n") cursor++;
      continue;
    }
    if (char === "/" && source[cursor + 1] === "*") {
      cursor += 2;
      while (
        cursor + 1 < end &&
        !(source[cursor] === "*" && source[cursor + 1] === "/")
      ) {
        cursor++;
      }
      if (cursor + 1 >= end) {
        throw new CompiledJsParseError(
          start,
          "Unterminated block comment",
        );
      }
      cursor += 2;
      continue;
    }
    break;
  }
  return cursor;
}

function advanceScanner(
  source: string,
  start: number,
  end: number,
  state: ScanState,
): number {
  const cursor = start;
  if (cursor >= end) return cursor;

  const char = source[cursor];

  if (char === "'" || char === '"') {
    state.regexAllowed = false;
    return scanStringLiteral(source, cursor, char, end);
  }

  if (char === "`") {
    state.regexAllowed = false;
    return scanTemplateLiteral(source, cursor, end);
  }

  if (char === "/") {
    if (source[cursor + 1] === "/" || source[cursor + 1] === "*") {
      return skipTrivia(source, cursor, end);
    }
    if (state.regexAllowed || looksLikeRegexStart(source, cursor)) {
      state.regexAllowed = false;
      return scanRegexLiteral(source, cursor, end);
    }
    state.regexAllowed = true;
    return cursor + (source[cursor + 1] === "=" ? 2 : 1);
  }

  const identifier = tryReadIdentifier(source, cursor, end);
  if (identifier) {
    state.regexAllowed = !endsExpression(identifier.text);
    return identifier.end;
  }

  if (isDigit(char) || (char === "." && isDigit(source[cursor + 1] ?? ""))) {
    state.regexAllowed = false;
    return scanNumberLiteral(source, cursor, end);
  }

  switch (char) {
    case "(":
      state.parenDepth++;
      state.regexAllowed = true;
      return cursor + 1;
    case ")":
      state.parenDepth = Math.max(0, state.parenDepth - 1);
      state.regexAllowed = false;
      return cursor + 1;
    case "[":
      state.bracketDepth++;
      state.regexAllowed = true;
      return cursor + 1;
    case "]":
      state.bracketDepth = Math.max(0, state.bracketDepth - 1);
      state.regexAllowed = false;
      return cursor + 1;
    case "{":
      state.braceDepth++;
      state.regexAllowed = true;
      return cursor + 1;
    case "}":
      state.braceDepth = Math.max(0, state.braceDepth - 1);
      state.regexAllowed = false;
      return cursor + 1;
    case ".":
      state.regexAllowed = false;
      return cursor + 1;
    case "+":
    case "-":
      state.regexAllowed = true;
      if (source[cursor + 1] === char) return cursor + 2;
      return cursor + 1;
    case "=":
      state.regexAllowed = true;
      if (source[cursor + 1] === ">" || source[cursor + 1] === "=") {
        return cursor + 2 + Number(source[cursor + 2] === "=");
      }
      return cursor + 1;
    case "!":
    case "<":
    case ">":
      state.regexAllowed = true;
      if (source[cursor + 1] === "=") {
        return cursor + 2 + Number(source[cursor + 2] === "=");
      }
      return cursor + 1;
    case "&":
    case "|":
      state.regexAllowed = true;
      if (source[cursor + 1] === char) return cursor + 2;
      return cursor + 1;
    case ",":
    case ":":
    case ";":
    case "?":
    case "*":
    case "%":
    case "^":
    case "~":
      state.regexAllowed = true;
      return cursor + 1;
    default:
      state.regexAllowed = false;
      return cursor + 1;
  }
}

function looksLikeRegexStart(source: string, cursor: number): boolean {
  let index = cursor - 1;
  while (index >= 0 && /\s/.test(source[index])) {
    index--;
  }

  if (index < 0) {
    return true;
  }

  return /[=([{,:;!?*%^&|<>]/.test(source[index]);
}

function scanStringLiteral(
  source: string,
  start: number,
  quote: string,
  end: number,
): number {
  let cursor = start + 1;
  while (cursor < end) {
    const char = source[cursor];
    if (char === "\\") {
      cursor += 2;
      continue;
    }
    if (char === quote) {
      return cursor + 1;
    }
    if (char === "\n" || char === "\r") {
      throw new CompiledJsParseError(start, "Unterminated string literal");
    }
    cursor++;
  }
  throw new CompiledJsParseError(start, "Unterminated string literal");
}

function scanTemplateLiteral(
  source: string,
  start: number,
  end: number,
): number {
  let cursor = start + 1;
  while (cursor < end) {
    const char = source[cursor];
    if (char === "\\") {
      cursor += 2;
      continue;
    }
    if (char === "`") {
      return cursor + 1;
    }
    if (char === "$" && source[cursor + 1] === "{") {
      cursor = scanTemplateExpression(source, cursor + 2, end);
      continue;
    }
    cursor++;
  }
  throw new CompiledJsParseError(start, "Unterminated template literal");
}

function scanTemplateExpression(
  source: string,
  start: number,
  end: number,
): number {
  const state: ScanState = {
    parenDepth: 0,
    braceDepth: 1,
    bracketDepth: 0,
    regexAllowed: true,
  };
  let cursor = start;
  while (cursor < end) {
    const char = source[cursor];
    if (
      char === "}" &&
      state.parenDepth === 0 &&
      state.bracketDepth === 0 &&
      state.braceDepth === 1
    ) {
      return cursor + 1;
    }
    cursor = advanceScanner(source, cursor, end, state);
  }
  throw new CompiledJsParseError(start, "Unterminated template expression");
}

function scanRegexLiteral(
  source: string,
  start: number,
  end: number,
): number {
  let cursor = start + 1;
  let inClass = false;
  while (cursor < end) {
    const char = source[cursor];
    if (char === "\\") {
      cursor += 2;
      continue;
    }
    if (char === "\n" || char === "\r") {
      throw new CompiledJsParseError(start, "Unterminated regular expression");
    }
    if (char === "[") {
      inClass = true;
      cursor++;
      continue;
    }
    if (char === "]") {
      inClass = false;
      cursor++;
      continue;
    }
    if (char === "/" && !inClass) {
      cursor++;
      while (cursor < end && /[A-Za-z]/.test(source[cursor])) {
        cursor++;
      }
      return cursor;
    }
    cursor++;
  }
  throw new CompiledJsParseError(start, "Unterminated regular expression");
}

function scanNumberLiteral(
  source: string,
  start: number,
  end: number,
): number {
  let cursor = start;
  while (
    cursor < end &&
    /[0-9A-Za-z_.$]/.test(source[cursor])
  ) {
    cursor++;
  }
  return cursor;
}

function readLeadingIdentifier(
  source: string,
  start: number,
  end: number,
): { text: string; start: number; end: number } | undefined {
  return tryReadIdentifier(source, skipTrivia(source, start, end), end);
}

function tryReadIdentifier(
  source: string,
  start: number,
  end: number,
): { text: string; start: number; end: number } | undefined {
  if (start >= end || !isIdentifierStart(source[start])) {
    return undefined;
  }
  let cursor = start + 1;
  while (cursor < end && isIdentifierPart(source[cursor])) {
    cursor++;
  }
  return {
    text: source.slice(start, cursor),
    start,
    end: cursor,
  };
}

function findTopLevelArrow(
  source: string,
  start: number,
  end: number,
): number | undefined {
  const state: ScanState = {
    parenDepth: 0,
    braceDepth: 0,
    bracketDepth: 0,
    regexAllowed: true,
  };

  for (let cursor = start; cursor < end;) {
    if (
      source[cursor] === "=" &&
      source[cursor + 1] === ">" &&
      state.parenDepth === 0 &&
      state.braceDepth === 0 &&
      state.bracketDepth === 0
    ) {
      return cursor;
    }
    cursor = advanceScanner(source, cursor, end, state);
  }
  return undefined;
}

function endsExpression(token: string): boolean {
  return !REGEX_PREFIX_KEYWORDS.has(token);
}

function isIdentifierStart(char: string | undefined): boolean {
  return !!char && /[A-Za-z_$]/.test(char);
}

function isIdentifierPart(char: string | undefined): boolean {
  return !!char && /[\w$]/.test(char);
}

function isDigit(char: string | undefined): boolean {
  return !!char && /[0-9]/.test(char);
}
