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
