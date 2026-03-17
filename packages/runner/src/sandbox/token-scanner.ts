export function findBalancedRegion(
  source: string,
  openIndex: number,
  openChar = "{",
  closeChar = "}",
): { start: number; end: number } {
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  let inRegex = false;
  let inRegexCharClass = false;
  let regexEscaped = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let index = openIndex; index < source.length; index++) {
    const current = source[index]!;
    const next = source[index + 1];
    const prev = source[index - 1];

    if (inLineComment) {
      if (current === "\n") inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (prev === "*" && current === "/") inBlockComment = false;
      continue;
    }
    if (inSingle) {
      if (current === "'" && prev !== "\\") inSingle = false;
      continue;
    }
    if (inDouble) {
      if (current === `"` && prev !== "\\") inDouble = false;
      continue;
    }
    if (inTemplate) {
      if (current === "`" && prev !== "\\") inTemplate = false;
      continue;
    }
    if (inRegex) {
      if (regexEscaped) {
        regexEscaped = false;
        continue;
      }
      if (current === "\\") {
        regexEscaped = true;
        continue;
      }
      if (inRegexCharClass) {
        if (current === "]") inRegexCharClass = false;
        continue;
      }
      if (current === "[") {
        inRegexCharClass = true;
        continue;
      }
      if (current === "/") {
        inRegex = false;
      }
      continue;
    }

    if (current === "/" && next === "/") {
      inLineComment = true;
      index++;
      continue;
    }
    if (current === "/" && next === "*") {
      inBlockComment = true;
      index++;
      continue;
    }
    if (current === "'") {
      inSingle = true;
      continue;
    }
    if (current === `"`) {
      inDouble = true;
      continue;
    }
    if (current === "`") {
      inTemplate = true;
      continue;
    }
    if (
      current === "/" && next !== "/" && next !== "*" &&
      canStartRegexLiteral(source, index)
    ) {
      inRegex = true;
      inRegexCharClass = false;
      regexEscaped = false;
      continue;
    }

    if (current === openChar) depth++;
    if (current === closeChar) depth--;
    if (depth === 0) {
      return { start: openIndex, end: index };
    }
  }

  throw new Error("Unbalanced bundle wrapper");
}

export function splitTopLevelStatements(source: string): string[] {
  const statements: string[] = [];
  let start = 0;
  let parenDepth = 0;
  let braceDepth = 0;
  let bracketDepth = 0;
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  let inRegex = false;
  let inRegexCharClass = false;
  let regexEscaped = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let index = 0; index < source.length; index++) {
    const current = source[index]!;
    const next = source[index + 1];
    const prev = source[index - 1];

    if (inLineComment) {
      if (current === "\n") inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (prev === "*" && current === "/") inBlockComment = false;
      continue;
    }
    if (inSingle) {
      if (current === "'" && prev !== "\\") inSingle = false;
      continue;
    }
    if (inDouble) {
      if (current === `"` && prev !== "\\") inDouble = false;
      continue;
    }
    if (inTemplate) {
      if (current === "`" && prev !== "\\") inTemplate = false;
      continue;
    }
    if (inRegex) {
      if (regexEscaped) {
        regexEscaped = false;
        continue;
      }
      if (current === "\\") {
        regexEscaped = true;
        continue;
      }
      if (inRegexCharClass) {
        if (current === "]") inRegexCharClass = false;
        continue;
      }
      if (current === "[") {
        inRegexCharClass = true;
        continue;
      }
      if (current === "/") {
        inRegex = false;
      }
      continue;
    }

    if (current === "/" && next === "/") {
      inLineComment = true;
      index++;
      continue;
    }
    if (current === "/" && next === "*") {
      inBlockComment = true;
      index++;
      continue;
    }
    if (current === "'") {
      inSingle = true;
      continue;
    }
    if (current === `"`) {
      inDouble = true;
      continue;
    }
    if (current === "`") {
      inTemplate = true;
      continue;
    }
    if (
      current === "/" && next !== "/" && next !== "*" &&
      canStartRegexLiteral(source, index)
    ) {
      inRegex = true;
      inRegexCharClass = false;
      regexEscaped = false;
      continue;
    }

    if (current === "(") parenDepth++;
    if (current === ")") parenDepth--;
    if (current === "{") braceDepth++;
    if (current === "}") braceDepth--;
    if (current === "[") bracketDepth++;
    if (current === "]") bracketDepth--;

    if (
      current === ";" && parenDepth === 0 && braceDepth === 0 &&
      bracketDepth === 0
    ) {
      const statement = source.slice(start, index + 1).trim();
      if (statement) {
        statements.push(statement);
      }
      start = index + 1;
    }
  }

  const trailing = source.slice(start).trim();
  if (trailing) {
    statements.push(trailing);
  }
  return statements;
}

const REGEX_PREFIX_KEYWORDS = new Set([
  "case",
  "delete",
  "in",
  "instanceof",
  "new",
  "return",
  "throw",
  "typeof",
  "void",
  "yield",
]);

function canStartRegexLiteral(source: string, index: number): boolean {
  let cursor = index - 1;
  while (cursor >= 0 && /\s/.test(source[cursor]!)) {
    cursor--;
  }
  if (cursor < 0) {
    return true;
  }

  const previous = source[cursor]!;
  if (/[[({,;:=!&|?+\-*%^~<>]/.test(previous)) {
    return true;
  }

  if (/[A-Za-z_$]/.test(previous)) {
    const end = cursor + 1;
    let start = cursor;
    while (start > 0 && /[A-Za-z0-9_$]/.test(source[start - 1]!)) {
      start--;
    }
    return REGEX_PREFIX_KEYWORDS.has(source.slice(start, end));
  }

  return false;
}
