import { isTrustedRuntimeModuleIdentifier } from "./abi.ts";
import {
  findBalancedRegion,
  splitTopLevelCommaList,
  splitTopLevelStatements,
} from "./token-scanner.ts";

export interface VerifyAMDFactoryOptions {
  moduleId: string;
  dependencies: string[];
  registeredModuleIds: ReadonlySet<string>;
  factorySource: string;
}

const SCHEMA_ASSIGNMENT_PATTERN =
  /^[$A-Z_a-z][\w$]*\.(?:argumentSchema|resultSchema)\s*=/;
const EXPORT_VOID_PATTERN = /^exports\.[A-Za-z_$][\w$]*\s*=\s*void 0$/;
const CHAINED_EXPORT_VOID_PATTERN =
  /^(?:exports\.[A-Za-z_$][\w$]*\s*=\s*){2,}void 0$/;
const USE_STRICT_PATTERN = /^["']use strict["']$/;
const EXPORTS_OBJECT_PATTERN =
  /^Object\.defineProperty\(exports,\s*["'][^"']+["'],\s*\{[\s\S]*\}\)$/;
const EXPORT_STAR_PATTERN = /^__exportStar\([^)]+\)$/;
const IMPORT_STAR_NORMALIZATION_PATTERN =
  /^([A-Za-z_$][\w$]*)\s*=\s*__importStar\(\1\)$/;
const HELPERS_KEEPALIVE_PATTERN = /^void __ctHelpers$/;
const SIMPLE_OBJECT_LITERAL_PATTERN =
  /^\{\s*(?:[A-Za-z_$][\w$]*(?:\s*:\s*[$A-Z_a-z][\w$]*(?:\.[A-Za-z_$][\w$]*)*|\s*:\s*(?:null|undefined|true|false|void 0)|\s*:\s*-?\d+(?:\.\d+)?n?|\s*:\s*["'`][\s\S]*["'`])?)(?:\s*,\s*[A-Za-z_$][\w$]*(?:\s*:\s*[$A-Z_a-z][\w$]*(?:\.[A-Za-z_$][\w$]*)*|\s*:\s*(?:null|undefined|true|false|void 0)|\s*:\s*-?\d+(?:\.\d+)?n?|\s*:\s*["'`][\s\S]*["'`])?)*\s*\}$/;
const HELPER_CALL_PATTERN =
  /^const\s+([A-Za-z_$][\w$]*)\s*=\s*((?:__ctHelpers\.)?__(?:ct_builder|ct_fn|ct_pure_fn|ct_data))\(/;
const SENTINEL_PATTERN = /^\/\*__CT_TOPLEVEL__:(.+?)\*\/\s*([\s\S]+)$/;
const STRING_LITERAL_PATTERN = /^"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'$/;
const FORBIDDEN_AUTHORITY_PATTERN =
  /(?:^|[^\w$.])globalThis\b|(?:^|[^\w$.])(?:window|document)\s*\.|(?:^|[^\w$.])eval\s*\(|(?:^|[^\w$.])Function\s*\(/;
const FORBIDDEN_CALLBACK_PATTERN = /(?:^|[^\w$.])require(?:$|[^\w$])/;

export function verifyAMDFactory(options: VerifyAMDFactoryOptions): void {
  verifyDependencies(options.dependencies, options.registeredModuleIds);
  verifyFactorySource(options.factorySource);
}

function verifyDependencies(
  dependencies: string[],
  registeredModuleIds: ReadonlySet<string>,
): void {
  for (const dependency of dependencies) {
    if (
      dependency === "exports" || dependency === "require" ||
      dependency === "module"
    ) {
      continue;
    }
    if (
      isTrustedRuntimeModuleIdentifier(dependency) ||
      registeredModuleIds.has(dependency)
    ) {
      continue;
    }
    throw new Error(`Untrusted AMD dependency: ${dependency}`);
  }
}

function verifyFactorySource(source: string): void {
  const body = extractFactoryBody(source);
  if (/require\s*\(\s*\[/.test(body)) {
    throw new Error("AMD async require() is not allowed in verified factories");
  }
  if (/__importStar|__importDefault/.test(body)) {
    // The AMD bundle's index-module scaffolding uses these helpers safely.
    // They are allowed only as top-level scaffolding statements below.
  }

  for (const statement of splitTopLevelStatements(body)) {
    for (const part of splitVerifiableStatements(statement)) {
      if (isAllowedStatement(part)) {
        continue;
      }
      throw new Error(
        `Factory contains a non-canonical top-level statement: ${part}`,
      );
    }
  }
}

function extractFactoryBody(source: string): string {
  const trimmed = source.trim();
  if (!trimmed.startsWith("function")) {
    throw new Error("Factory must be a function declaration");
  }
  const bodyStart = trimmed.indexOf("{");
  if (bodyStart < 0) {
    throw new Error("Factory is missing a body");
  }
  if (!trimmed.endsWith("}")) {
    throw new Error("Factory source contains trailing code after the body");
  }
  return trimmed.slice(bodyStart + 1, -1);
}

function isAllowedStatement(statement: string): boolean {
  const normalized = stripTrailingSemicolon(statement.trim());
  const commentStripped = stripTrustedLeadingScaffolding(normalized);
  const compactWithoutComments = commentStripped.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return true;
  }
  if (!compactWithoutComments) {
    return true;
  }

  if (
    USE_STRICT_PATTERN.test(compactWithoutComments) ||
    EXPORTS_OBJECT_PATTERN.test(compactWithoutComments) ||
    isTrustedConsoleStatement(compactWithoutComments) ||
    SCHEMA_ASSIGNMENT_PATTERN.test(compactWithoutComments) ||
    EXPORT_VOID_PATTERN.test(compactWithoutComments) ||
    CHAINED_EXPORT_VOID_PATTERN.test(compactWithoutComments) ||
    EXPORT_STAR_PATTERN.test(compactWithoutComments) ||
    IMPORT_STAR_NORMALIZATION_PATTERN.test(compactWithoutComments) ||
    HELPERS_KEEPALIVE_PATTERN.test(compactWithoutComments) ||
    isSafeExportAssignment(compactWithoutComments)
  ) {
    return true;
  }

  return isCanonicalWrapperStatement(compactWithoutComments);
}

function stripTrailingSemicolon(statement: string): string {
  return statement.endsWith(";") ? statement.slice(0, -1).trim() : statement;
}

function stripTrustedLeadingScaffolding(statement: string): string {
  const remaining = statement.trimStart();
  const sentinelIndex = remaining.indexOf("/*__CT_TOPLEVEL__:");
  if (sentinelIndex > 0) {
    const prefix = remaining.slice(0, sentinelIndex);
    if (stripAllowedLeadingComments(prefix).length === 0) {
      return remaining.slice(sentinelIndex).trimStart();
    }
  }
  return stripAllowedLeadingComments(remaining);
}

function stripAllowedLeadingComments(statement: string): string {
  let remaining = statement.trimStart();
  while (remaining.startsWith("//") || remaining.startsWith("/*")) {
    if (remaining.startsWith("/*__CT_TOPLEVEL__:")) {
      return remaining;
    }

    if (remaining.startsWith("//")) {
      const newlineIndex = remaining.indexOf("\n");
      if (newlineIndex < 0) {
        return "";
      }
      remaining = remaining.slice(newlineIndex + 1).trimStart();
      continue;
    }

    const commentEnd = remaining.indexOf("*/");
    if (commentEnd < 0) {
      return remaining;
    }
    remaining = remaining.slice(commentEnd + 2).trimStart();
  }
  return remaining;
}

function isSafeExportAssignment(statement: string): boolean {
  const match = statement.match(
    /^exports\.([A-Za-z_$][\w$]*)\s*=\s*([\s\S]+)$/,
  );
  if (!match) {
    return false;
  }
  const rhs = match[2]!.trim();
  return /^[$A-Z_a-z][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(rhs) ||
    SIMPLE_OBJECT_LITERAL_PATTERN.test(rhs) ||
    /^(?:null|undefined|true|false|void 0)$/.test(rhs) ||
    /^-?\d+(?:\.\d+)?n?$/.test(rhs) ||
    /^["'`][\s\S]*["'`]$/.test(rhs);
}

function isTrustedConsoleStatement(statement: string): boolean {
  const match = statement.match(/^console\.([A-Za-z_$][\w$]*)\s*\(/);
  if (!match) {
    return false;
  }

  const openParenIndex = statement.indexOf("(", match[0].length - 1);
  if (openParenIndex < 0) {
    return false;
  }
  const { end: closeParenIndex } = findBalancedRegion(
    statement,
    openParenIndex,
    "(",
    ")",
  );
  if (statement.slice(closeParenIndex + 1).trim().length > 0) {
    return false;
  }

  const argsSource = statement.slice(openParenIndex + 1, closeParenIndex)
    .trim();
  if (!argsSource) {
    return true;
  }

  return splitTopLevelCommaList(argsSource).every((arg) =>
    isTrustedDataExpression(arg, new Set())
  );
}

function splitVerifiableStatements(statement: string): string[] {
  const trimmed = statement.trim();
  const sentinelIndex = trimmed.indexOf("/*__CT_TOPLEVEL__:");
  if (sentinelIndex <= 0) {
    return [statement];
  }

  const prefix = trimmed.slice(0, sentinelIndex).trim();
  const suffix = trimmed.slice(sentinelIndex).trim();
  return [prefix, suffix].filter((part) => part.length > 0);
}

function isCanonicalWrapperStatement(statement: string): boolean {
  const sentinelMatch = statement.match(SENTINEL_PATTERN);
  if (!sentinelMatch) {
    return false;
  }

  const sentinelKind = sentinelMatch[1]!.split(":").at(-1);
  const remainder = sentinelMatch[2]!.trim();
  const helperMatch = remainder.match(HELPER_CALL_PATTERN);
  if (!helperMatch) {
    return false;
  }

  const helperName = helperMatch[2]!;
  const openParenIndex = remainder.indexOf("(", helperMatch[0].length - 1);
  if (openParenIndex < 0) {
    return false;
  }
  const closeParenIndex = remainder.lastIndexOf(")");
  if (closeParenIndex <= openParenIndex) {
    return false;
  }
  if (remainder.slice(closeParenIndex + 1).trim().length > 0) {
    return false;
  }

  const argsSource = remainder.slice(openParenIndex + 1, closeParenIndex);
  const args = splitTopLevelCommaList(argsSource);
  if (helperName.endsWith("__ct_builder")) {
    return sentinelKind === "builder" && isValidBuilderWrapper(args);
  }
  if (helperName.endsWith("__ct_fn")) {
    return sentinelKind === "fn" && isValidFunctionWrapper(args);
  }
  if (helperName.endsWith("__ct_pure_fn")) {
    return sentinelKind === "pure-fn" && isValidPureFunctionWrapper(args);
  }
  if (helperName.endsWith("__ct_data")) {
    return sentinelKind === "data" && isValidDataWrapper(args);
  }
  return false;
}

function isValidBuilderWrapper(args: string[]): boolean {
  if (args.length !== 3) {
    return false;
  }
  return /^"(?:lift|handler|pattern)"$/.test(args[0]!.trim()) &&
    isTrustedItemId(args[1]!) &&
    isTrustedFunctionExpression(args[2]!);
}

function isValidFunctionWrapper(args: string[]): boolean {
  if (args.length !== 2) {
    return false;
  }
  return isTrustedItemId(args[0]!) && isTrustedFunctionExpression(args[1]!);
}

function isValidPureFunctionWrapper(args: string[]): boolean {
  if (args.length !== 3) {
    return false;
  }
  const captureIds = parseTrustedCaptureManifest(args[1]!);
  if (!captureIds) {
    return false;
  }
  if (!isTrustedItemId(args[0]!)) {
    return false;
  }
  if (!isTrustedFunctionExpression(args[2]!, new Set(captureIds))) {
    return false;
  }
  return true;
}

function isValidDataWrapper(args: string[]): boolean {
  if (args.length !== 3) {
    return false;
  }
  const captureIds = parseTrustedCaptureManifest(args[1]!);
  if (!captureIds) {
    return false;
  }
  return isTrustedItemId(args[0]!) &&
    isTrustedDataExpression(args[2]!, new Set(captureIds));
}

function isTrustedItemId(source: string): boolean {
  const value = source.trim();
  return STRING_LITERAL_PATTERN.test(value) && value.length > 2;
}

function parseTrustedCaptureManifest(source: string): string[] | null {
  const trimmed = source.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) {
    return null;
  }
  const entriesSource = trimmed.slice(1, -1).trim();
  if (!entriesSource) {
    return [];
  }
  const entries = splitTopLevelCommaList(entriesSource);
  if (!entries.every((entry) => STRING_LITERAL_PATTERN.test(entry.trim()))) {
    return null;
  }
  return entries.map((entry) => stripStringLiteralQuotes(entry.trim()));
}

function isTrustedFunctionExpression(
  source: string,
  allowedCaptures?: ReadonlySet<string>,
): boolean {
  if (!hasFunctionExpressionShape(source)) {
    return false;
  }
  const trimmed = source.trim();
  const paramsStart = trimmed.indexOf("(");
  const { end: paramsEnd } = findBalancedRegion(trimmed, paramsStart, "(", ")");
  const bodyStart = trimmed.indexOf("{", paramsEnd + 1);
  const bodyEnd = trimmed.lastIndexOf("}");
  const body = trimmed.slice(bodyStart + 1, bodyEnd);
  if (
    FORBIDDEN_AUTHORITY_PATTERN.test(body) ||
    FORBIDDEN_CALLBACK_PATTERN.test(body)
  ) {
    return false;
  }
  if (allowedCaptures) {
    const paramsSource = trimmed.slice(paramsStart + 1, paramsEnd);
    const params = extractSimpleParamNames(paramsSource);
    if (!params) {
      return false;
    }
    const freeIds = extractFreeIdentifiers(body, params);
    if (!freeIds) {
      return false;
    }
    for (const id of freeIds) {
      if (!allowedCaptures.has(id) && !WELL_KNOWN_IDENTIFIERS.has(id)) {
        return false;
      }
    }
  }
  return true;
}

function hasFunctionExpressionShape(source: string): boolean {
  const trimmed = source.trim();
  if (!trimmed.startsWith("function")) {
    return false;
  }
  const paramsStart = trimmed.indexOf("(");
  if (paramsStart < 0) {
    return false;
  }
  const { end: paramsEnd } = findBalancedRegion(trimmed, paramsStart, "(", ")");
  const bodyStart = trimmed.indexOf("{", paramsEnd + 1);
  if (bodyStart < 0) {
    return false;
  }
  const bodyEnd = trimmed.lastIndexOf("}");
  if (bodyEnd <= bodyStart) {
    return false;
  }
  if (trimmed.slice(bodyEnd + 1).trim().length > 0) {
    return false;
  }
  return true;
}

function isTrustedDataExpression(
  source: string,
  captureIds: ReadonlySet<string>,
): boolean {
  const trimmed = stripTrustedParens(source.trim());
  if (!trimmed) {
    return false;
  }

  if (
    STRING_LITERAL_PATTERN.test(trimmed) ||
    isTrustedTemplateLiteral(trimmed) ||
    /^(?:null|undefined|true|false|void 0)$/.test(trimmed) ||
    /^[+-]?\d+(?:\.\d+)?n?$/.test(trimmed)
  ) {
    return true;
  }

  if (/^[$A-Z_a-z][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(trimmed)) {
    const [root] = trimmed.split(".", 1);
    return root === "undefined" || captureIds.has(root!);
  }

  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    const entriesSource = trimmed.slice(1, -1).trim();
    if (!entriesSource) {
      return true;
    }
    return splitTopLevelCommaList(entriesSource).every((entry) =>
      isTrustedDataExpression(entry, captureIds)
    );
  }

  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    const entriesSource = trimmed.slice(1, -1).trim();
    if (!entriesSource) {
      return true;
    }
    return splitTopLevelCommaList(entriesSource).every((entry) =>
      isTrustedObjectProperty(entry, captureIds)
    );
  }

  return false;
}

function isTrustedTemplateLiteral(source: string): boolean {
  if (!source.startsWith("`") || !source.endsWith("`")) {
    return false;
  }

  let escaped = false;
  for (let index = 1; index < source.length - 1; index++) {
    const current = source[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (current === "\\") {
      escaped = true;
      continue;
    }
    if (current === "$" && source[index + 1] === "{") {
      return false;
    }
  }

  return true;
}

function isTrustedObjectProperty(
  source: string,
  captureIds: ReadonlySet<string>,
): boolean {
  const trimmed = source.trim();
  if (!trimmed || trimmed.startsWith("...")) {
    return false;
  }

  const colonIndex = findTopLevelPropertyColon(trimmed);
  if (colonIndex < 0) {
    return /^[$A-Z_a-z][\w$]*$/.test(trimmed) && captureIds.has(trimmed);
  }

  const key = trimmed.slice(0, colonIndex).trim();
  const value = trimmed.slice(colonIndex + 1).trim();
  return isTrustedObjectKey(key) && isTrustedDataExpression(value, captureIds);
}

function isTrustedObjectKey(source: string): boolean {
  const trimmed = source.trim();
  return /^[$A-Z_a-z][\w$]*$/.test(trimmed) ||
    STRING_LITERAL_PATTERN.test(trimmed) ||
    /^[+-]?\d+(?:\.\d+)?$/.test(trimmed);
}

function findTopLevelPropertyColon(source: string): number {
  let parenDepth = 0;
  let braceDepth = 0;
  let bracketDepth = 0;
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  let escaped = false;

  for (let index = 0; index < source.length; index++) {
    const current = source[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }

    if (inSingle) {
      if (current === "\\") escaped = true;
      else if (current === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      if (current === "\\") escaped = true;
      else if (current === '"') inDouble = false;
      continue;
    }
    if (inTemplate) {
      if (current === "\\") escaped = true;
      else if (current === "`") inTemplate = false;
      continue;
    }

    if (current === "'") {
      inSingle = true;
      continue;
    }
    if (current === '"') {
      inDouble = true;
      continue;
    }
    if (current === "`") {
      inTemplate = true;
      continue;
    }
    if (current === "(") parenDepth++;
    else if (current === ")") parenDepth--;
    else if (current === "{") braceDepth++;
    else if (current === "}") braceDepth--;
    else if (current === "[") bracketDepth++;
    else if (current === "]") bracketDepth--;
    else if (
      current === ":" && parenDepth === 0 && braceDepth === 0 &&
      bracketDepth === 0
    ) {
      return index;
    }
  }

  return -1;
}

function stripTrustedParens(source: string): string {
  let current = source.trim();
  while (current.startsWith("(") && current.endsWith(")")) {
    const region = findBalancedRegion(current, 0, "(", ")");
    if (region.end !== current.length - 1) {
      break;
    }
    current = current.slice(1, -1).trim();
  }
  return current;
}

function stripStringLiteralQuotes(source: string): string {
  return source.slice(1, -1);
}

// Identifiers that are always allowed inside pure function bodies
// (JS builtins, keywords, etc.)
const WELL_KNOWN_IDENTIFIERS = new Set([
  "Object",
  "Array",
  "Map",
  "Set",
  "WeakMap",
  "WeakSet",
  "Promise",
  "Math",
  "JSON",
  "Number",
  "String",
  "Boolean",
  "BigInt",
  "Date",
  "RegExp",
  "Error",
  "TypeError",
  "RangeError",
  "console",
  "undefined",
  "null",
  "true",
  "false",
  "NaN",
  "Infinity",
  "parseInt",
  "parseFloat",
  "isNaN",
  "isFinite",
  "encodeURIComponent",
  "decodeURIComponent",
  "encodeURI",
  "decodeURI",
  "arguments",
  "this",
]);

const IDENTIFIER_PATTERN = /[$A-Z_a-z][\w$]*/g;

function extractSimpleParamNames(source: string): Set<string> | null {
  const trimmed = source.trim();
  if (!trimmed) {
    return new Set();
  }
  if (/[{\[=]|\.\.\./.test(trimmed)) {
    return null;
  }

  const params = new Set<string>();
  for (const entry of splitTopLevelCommaList(trimmed)) {
    const name = entry.trim();
    if (!/^[$A-Z_a-z][\w$]*$/.test(name)) {
      return null;
    }
    params.add(name);
  }
  return params;
}

function extractFreeIdentifiers(
  body: string,
  params: ReadonlySet<string>,
): Set<string> | null {
  const cleaned = stripNonCodeSegments(body);
  if (/\bfunction\b|=>/.test(cleaned)) {
    return null;
  }
  if (/\b(?:const|let|var)\s*[\[{]/.test(cleaned)) {
    return null;
  }

  const locals = new Set(params);
  const declared = extractDeclaredIdentifiers(cleaned);
  if (!declared) {
    return null;
  }
  for (const name of declared) {
    locals.add(name);
  }

  const freeIds = new Set<string>();
  for (const match of cleaned.matchAll(IDENTIFIER_PATTERN)) {
    const id = match[0];
    const index = match.index!;
    if (JS_KEYWORDS.has(id)) {
      continue;
    }
    if (index > 0 && cleaned[index - 1] === ".") {
      continue;
    }
    const next = nextNonWhitespaceChar(cleaned, index + id.length);
    if (next === ":") {
      continue;
    }
    if (!locals.has(id)) {
      freeIds.add(id);
    }
  }
  return freeIds;
}

function extractDeclaredIdentifiers(source: string): Set<string> | null {
  const locals = new Set<string>();

  const variableDeclarations = source.matchAll(
    /\b(?:const|let|var)\s+([^;]+)/g,
  );
  for (const declaration of variableDeclarations) {
    const declarators = splitTopLevelCommaList(declaration[1]!.trim());
    for (const declarator of declarators) {
      const match = declarator.trim().match(/^([$A-Z_a-z][\w$]*)\b/);
      if (!match) {
        return null;
      }
      locals.add(match[1]!);
    }
  }

  for (
    const match of source.matchAll(
      /\b(?:class|function)\s+([$A-Z_a-z][\w$]*)\b/g,
    )
  ) {
    locals.add(match[1]!);
  }

  for (
    const match of source.matchAll(/\bcatch\s*\(\s*([$A-Z_a-z][\w$]*)\s*\)/g)
  ) {
    locals.add(match[1]!);
  }

  return locals;
}

function stripNonCodeSegments(source: string): string {
  return preserveTemplateInterpolations(source)
    .replace(/\/\/[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/\/(?:[^/\\\n]|\\.)+\/[dgimsuy]*/g, "/re/");
}

function preserveTemplateInterpolations(source: string): string {
  let result = "";
  let index = 0;

  while (index < source.length) {
    if (source[index] !== "`") {
      result += source[index]!;
      index++;
      continue;
    }

    const [cleaned, end] = flattenTemplateLiteral(source, index);
    result += cleaned;
    index = end;
  }

  return result;
}

function flattenTemplateLiteral(
  source: string,
  start: number,
): [string, number] {
  let result = ' "" ';
  let index = start + 1;

  while (index < source.length) {
    const current = source[index]!;
    if (current === "\\") {
      index += 2;
      continue;
    }
    if (current === "`") {
      return [`${result} "" `, index + 1];
    }
    if (current === "$" && source[index + 1] === "{") {
      const [expression, end] = extractTemplateExpression(source, index + 2);
      result += ` (${expression}) `;
      index = end;
      continue;
    }
    index++;
  }

  return [result, index];
}

function extractTemplateExpression(
  source: string,
  start: number,
): [string, number] {
  let result = "";
  let depth = 1;
  let index = start;

  while (index < source.length) {
    const current = source[index]!;
    const next = source[index + 1];

    if (current === "'" || current === '"') {
      const end = consumeQuotedSegment(source, index, current);
      result += source.slice(index, end);
      index = end;
      continue;
    }

    if (current === "/" && next === "/") {
      const end = consumeLineComment(source, index);
      result += source.slice(index, end);
      index = end;
      continue;
    }

    if (current === "/" && next === "*") {
      const end = consumeBlockComment(source, index);
      result += source.slice(index, end);
      index = end;
      continue;
    }

    if (current === "`") {
      const [cleaned, end] = flattenTemplateLiteral(source, index);
      result += cleaned;
      index = end;
      continue;
    }

    if (current === "/" && isRegexLiteralStart(source, index)) {
      const end = consumeRegexLiteral(source, index);
      result += source.slice(index, end);
      index = end;
      continue;
    }

    if (current === "{") {
      depth++;
      result += current;
      index++;
      continue;
    }

    if (current === "}") {
      depth--;
      if (depth === 0) {
        return [result, index + 1];
      }
      result += current;
      index++;
      continue;
    }

    result += current;
    index++;
  }

  return [result, index];
}

function consumeQuotedSegment(
  source: string,
  start: number,
  quote: '"' | "'",
): number {
  let index = start + 1;
  while (index < source.length) {
    const current = source[index]!;
    if (current === "\\") {
      index += 2;
      continue;
    }
    index++;
    if (current === quote) {
      break;
    }
  }
  return index;
}

function consumeLineComment(source: string, start: number): number {
  const newlineIndex = source.indexOf("\n", start + 2);
  return newlineIndex >= 0 ? newlineIndex : source.length;
}

function consumeBlockComment(source: string, start: number): number {
  const endIndex = source.indexOf("*/", start + 2);
  return endIndex >= 0 ? endIndex + 2 : source.length;
}

function consumeRegexLiteral(source: string, start: number): number {
  let index = start + 1;
  let inCharacterClass = false;

  while (index < source.length) {
    const current = source[index]!;
    if (current === "\\") {
      index += 2;
      continue;
    }
    if (current === "[") {
      inCharacterClass = true;
      index++;
      continue;
    }
    if (current === "]" && inCharacterClass) {
      inCharacterClass = false;
      index++;
      continue;
    }
    if (current === "/" && !inCharacterClass) {
      index++;
      while (/[A-Za-z]/.test(source[index] ?? "")) {
        index++;
      }
      return index;
    }
    if (current === "\n") {
      return index;
    }
    index++;
  }

  return index;
}

function isRegexLiteralStart(source: string, index: number): boolean {
  let previousIndex = index - 1;
  while (previousIndex >= 0 && /\s/.test(source[previousIndex]!)) {
    previousIndex--;
  }
  if (previousIndex < 0) {
    return true;
  }

  const previous = source[previousIndex]!;
  if ("([{,:;!?=+-*%^&|~<>".includes(previous)) {
    return true;
  }

  if (previous === "/") {
    return true;
  }

  if (!/[$\w]/.test(previous)) {
    return false;
  }

  let wordStart = previousIndex;
  while (wordStart >= 0 && /[$\w]/.test(source[wordStart]!)) {
    wordStart--;
  }
  return REGEX_PREFIX_KEYWORDS.has(
    source.slice(wordStart + 1, previousIndex + 1),
  );
}

function nextNonWhitespaceChar(
  source: string,
  start: number,
): string | undefined {
  for (let index = start; index < source.length; index++) {
    const current = source[index]!;
    if (!/\s/.test(current)) {
      return current;
    }
  }
  return undefined;
}

const JS_KEYWORDS = new Set([
  "break",
  "case",
  "catch",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "export",
  "finally",
  "for",
  "function",
  "if",
  "import",
  "in",
  "instanceof",
  "let",
  "new",
  "of",
  "return",
  "switch",
  "throw",
  "try",
  "typeof",
  "var",
  "void",
  "while",
  "with",
]);

const REGEX_PREFIX_KEYWORDS = new Set([
  "case",
  "delete",
  "do",
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
