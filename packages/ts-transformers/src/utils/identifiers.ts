import ts from "typescript";

const DEFAULT_FALLBACK = "_";

export interface SanitizeIdentifierOptions {
  readonly fallback?: string;
  readonly trimLeadingUnderscores?: boolean;
}

export interface UniqueIdentifierOptions extends SanitizeIdentifierOptions {
  readonly suffixSeparator?: string;
}

export function isSafeIdentifierText(name: string): boolean {
  if (name.length === 0) return false;
  const first = name.codePointAt(0)!;
  if (!ts.isIdentifierStart(first, ts.ScriptTarget.ESNext)) {
    return false;
  }
  for (let i = 1; i < name.length; i++) {
    const code = name.codePointAt(i)!;
    if (!ts.isIdentifierPart(code, ts.ScriptTarget.ESNext)) {
      return false;
    }
  }
  const scanner = ts.createScanner(
    ts.ScriptTarget.ESNext,
    /*skipTrivia*/ false,
    ts.LanguageVariant.Standard,
    name,
  );
  const token = scanner.scan();
  const isWholeToken = scanner.getTokenText().length === name.length;
  if (!isWholeToken) return true;
  return token < ts.SyntaxKind.FirstReservedWord ||
    token > ts.SyntaxKind.LastReservedWord;
}

export function sanitizeIdentifierCandidate(
  raw: string,
  options: SanitizeIdentifierOptions = {},
): string {
  const fallback = options.fallback ?? DEFAULT_FALLBACK;

  let candidate = raw;
  if (options.trimLeadingUnderscores) {
    candidate = candidate.replace(/^_+/, "");
  }

  candidate = candidate.replace(/[^A-Za-z0-9_$]/g, "_");

  if (candidate.length === 0) {
    candidate = fallback;
  }

  const ensureIdentifierStart = (text: string): string => {
    if (text.length === 0) return fallback;
    if (ts.isIdentifierStart(text.charCodeAt(0), ts.ScriptTarget.ESNext)) {
      return text;
    }
    return `${fallback}${text}`;
  };

  candidate = ensureIdentifierStart(candidate);

  if (!isSafeIdentifierText(candidate)) {
    candidate = ensureIdentifierStart(fallback);
  }

  let safe = candidate;
  if (!isSafeIdentifierText(safe)) {
    safe = fallback;
  }

  while (!isSafeIdentifierText(safe)) {
    safe = `${safe}_`;
  }

  return safe;
}

export function getUniqueIdentifier(
  candidate: string,
  used: Set<string>,
  options: UniqueIdentifierOptions = {},
): string {
  const fallback = options.fallback ?? DEFAULT_FALLBACK;
  const separator = options.suffixSeparator ?? "_";

  const base = sanitizeIdentifierCandidate(candidate, options);
  let name = base.length > 0
    ? base
    : sanitizeIdentifierCandidate(fallback, options);

  if (used.has(name)) {
    let index = 1;
    while (true) {
      const next = sanitizeIdentifierCandidate(
        `${name}${separator}${index++}`,
        { ...options, fallback },
      );
      if (!used.has(next)) {
        name = next;
        break;
      }
    }
  }

  used.add(name);
  return name;
}

export function maybeReuseIdentifier(
  identifier: ts.Identifier,
  used: Set<string>,
): ts.Identifier {
  if (!used.has(identifier.text) && isSafeIdentifierText(identifier.text)) {
    used.add(identifier.text);
    return identifier;
  }
  const fresh = getUniqueIdentifier(identifier.text, used);
  return ts.factory.createIdentifier(fresh);
}

export function createSafeIdentifier(
  name: string,
  used: Set<string>,
  options?: UniqueIdentifierOptions,
): ts.Identifier {
  const text = getUniqueIdentifier(name, used, options);
  return ts.factory.createIdentifier(text);
}
