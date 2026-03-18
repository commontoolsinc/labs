export function findBalancedRegion(
  source: string,
  openIndex: number,
  openChar = "{",
  closeChar = "}",
): { start: number; end: number } {
  let depth = 0;
  let endIndex: number | undefined;

  scanCode(source, openIndex, (index, current) => {
    if (current === openChar) depth++;
    if (current === closeChar) depth--;
    if (depth === 0) {
      endIndex = index;
      return false;
    }
  });

  if (endIndex !== undefined) {
    return { start: openIndex, end: endIndex };
  }

  throw new Error("Unbalanced bundle wrapper");
}

export function splitTopLevelStatements(source: string): string[] {
  return splitTopLevelDelimited(source, ";", true);
}

export function splitTopLevelCommaList(source: string): string[] {
  return splitTopLevelDelimited(source, ",", false);
}

type ScannerState = {
  inSingle: boolean;
  inDouble: boolean;
  inTemplate: boolean;
  inRegex: boolean;
  inRegexCharClass: boolean;
  regexEscaped: boolean;
  inLineComment: boolean;
  inBlockComment: boolean;
};

function splitTopLevelDelimited(
  source: string,
  delimiter: ";" | ",",
  includeDelimiter: boolean,
): string[] {
  const entries: string[] = [];
  let start = 0;
  let parenDepth = 0;
  let braceDepth = 0;
  let bracketDepth = 0;

  scanCode(source, 0, (index, current) => {
    if (current === "(") parenDepth++;
    if (current === ")") parenDepth--;
    if (current === "{") braceDepth++;
    if (current === "}") braceDepth--;
    if (current === "[") bracketDepth++;
    if (current === "]") bracketDepth--;

    if (
      current === delimiter && parenDepth === 0 && braceDepth === 0 &&
      bracketDepth === 0
    ) {
      const entry = source.slice(start, includeDelimiter ? index + 1 : index)
        .trim();
      if (entry) {
        entries.push(entry);
      }
      start = index + 1;
    }
  });

  const trailing = source.slice(start).trim();
  if (trailing) {
    entries.push(trailing);
  }
  return entries;
}

function scanCode(
  source: string,
  startIndex: number,
  visit: (index: number, current: string) => boolean | void,
): void {
  const state = createScannerState();

  for (let index = startIndex; index < source.length; index++) {
    const current = source[index]!;
    const next = source[index + 1];

    if (state.inLineComment) {
      if (current === "\n") {
        state.inLineComment = false;
      }
      continue;
    }

    if (state.inBlockComment) {
      if (current === "*" && next === "/") {
        state.inBlockComment = false;
        index++;
      }
      continue;
    }

    if (state.inSingle) {
      if (current === "'" && !isEscapedByBackslashes(source, index)) {
        state.inSingle = false;
      }
      continue;
    }

    if (state.inDouble) {
      if (current === `"` && !isEscapedByBackslashes(source, index)) {
        state.inDouble = false;
      }
      continue;
    }

    if (state.inTemplate) {
      if (current === "`" && !isEscapedByBackslashes(source, index)) {
        state.inTemplate = false;
      }
      continue;
    }

    if (state.inRegex) {
      if (state.regexEscaped) {
        state.regexEscaped = false;
        continue;
      }
      if (current === "\\") {
        state.regexEscaped = true;
        continue;
      }
      if (state.inRegexCharClass) {
        if (current === "]") {
          state.inRegexCharClass = false;
        }
        continue;
      }
      if (current === "[") {
        state.inRegexCharClass = true;
        continue;
      }
      if (current === "/") {
        state.inRegex = false;
      }
      continue;
    }

    if (current === "/" && next === "/") {
      state.inLineComment = true;
      index++;
      continue;
    }

    if (current === "/" && next === "*") {
      state.inBlockComment = true;
      index++;
      continue;
    }

    if (current === "'") {
      state.inSingle = true;
      continue;
    }

    if (current === `"`) {
      state.inDouble = true;
      continue;
    }

    if (current === "`") {
      state.inTemplate = true;
      continue;
    }

    if (
      current === "/" && next !== "/" && next !== "*" &&
      canStartRegexLiteral(source, index)
    ) {
      state.inRegex = true;
      state.inRegexCharClass = false;
      state.regexEscaped = false;
      continue;
    }

    if (visit(index, current) === false) {
      return;
    }
  }
}

function createScannerState(): ScannerState {
  return {
    inSingle: false,
    inDouble: false,
    inTemplate: false,
    inRegex: false,
    inRegexCharClass: false,
    regexEscaped: false,
    inLineComment: false,
    inBlockComment: false,
  };
}

function isEscapedByBackslashes(source: string, index: number): boolean {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && source[cursor] === "\\"; cursor--) {
    backslashes++;
  }
  return backslashes % 2 === 1;
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
