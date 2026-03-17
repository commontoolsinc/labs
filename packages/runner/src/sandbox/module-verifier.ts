import {
  TRUSTED_RUNTIME_MODULES,
} from "./abi.ts";
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
const EXPORT_VOID_PATTERN =
  /^exports\.[A-Za-z_$][\w$]*\s*=\s*void 0$/;
const CHAINED_EXPORT_VOID_PATTERN =
  /^(?:exports\.[A-Za-z_$][\w$]*\s*=\s*){2,}void 0$/;
const CONSOLE_STATEMENT_PATTERN =
  /^console\.[A-Za-z_$][\w$]*\(/;
const USE_STRICT_PATTERN = /^["']use strict["']$/;
const EXPORTS_OBJECT_PATTERN =
  /^Object\.defineProperty\(exports,\s*["'][^"']+["'],\s*\{[\s\S]*\}\)$/;
const EXPORT_STAR_PATTERN = /^__exportStar\([^)]+\)$/;
const IMPORT_STAR_NORMALIZATION_PATTERN =
  /^([A-Za-z_$][\w$]*)\s*=\s*__importStar\(\1\)$/;
const HELPER_FRAGMENT_ASSIGNMENT_PATTERN =
  /^[A-Za-z_$][\w$]*\.fragment = __ctHelpers\.h\.fragment$/;
const HELPER_FUNCTION_PATTERN =
  /^function h\([^)]*\)\s*\{[\s\S]*return __ctHelpers\.h\.apply\(null,\s*[A-Za-z_$][\w$]*\);?\s*\}$/;
const LEADING_HELPER_FUNCTION_PATTERN =
  /^function h\([^)]*\)\s*\{[\s\S]*?return __ctHelpers\.h\.apply\(null,\s*[A-Za-z_$][\w$]*\);?\s*\}/;
const SIMPLE_OBJECT_LITERAL_PATTERN =
  /^\{\s*(?:[A-Za-z_$][\w$]*(?:\s*:\s*[$A-Z_a-z][\w$]*(?:\.[A-Za-z_$][\w$]*)*|\s*:\s*(?:null|undefined|true|false|void 0)|\s*:\s*-?\d+(?:\.\d+)?n?|\s*:\s*["'`][\s\S]*["'`])?)(?:\s*,\s*[A-Za-z_$][\w$]*(?:\s*:\s*[$A-Z_a-z][\w$]*(?:\.[A-Za-z_$][\w$]*)*|\s*:\s*(?:null|undefined|true|false|void 0)|\s*:\s*-?\d+(?:\.\d+)?n?|\s*:\s*["'`][\s\S]*["'`])?)*\s*\}$/;
const HELPER_CALL_PATTERN =
  /^const\s+([A-Za-z_$][\w$]*)\s*=\s*((?:__ctHelpers\.)?__(?:ct_builder|ct_fn|ct_pure_fn|ct_data))\(/;
const SENTINEL_PATTERN = /^\/\*__CT_TOPLEVEL__:(.+?)\*\/\s*([\s\S]+)$/;
const STRING_LITERAL_PATTERN = /^"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'$/;
const FORBIDDEN_AUTHORITY_PATTERN =
  /(?:^|[^\w$.])globalThis\b|(?:^|[^\w$.])(?:window|document)\s*\.|(?:^|[^\w$.])eval\s*\(|(?:^|[^\w$.])Function\s*\(/;

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
      TRUSTED_RUNTIME_MODULES.has(dependency) ||
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
  const compact = normalized.replace(/\s+/g, " ").trim();
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
    CONSOLE_STATEMENT_PATTERN.test(compactWithoutComments) ||
    SCHEMA_ASSIGNMENT_PATTERN.test(compactWithoutComments) ||
    EXPORT_VOID_PATTERN.test(compactWithoutComments) ||
    CHAINED_EXPORT_VOID_PATTERN.test(compactWithoutComments) ||
    EXPORT_STAR_PATTERN.test(compactWithoutComments) ||
    IMPORT_STAR_NORMALIZATION_PATTERN.test(compactWithoutComments) ||
    HELPER_FRAGMENT_ASSIGNMENT_PATTERN.test(compactWithoutComments) ||
    HELPER_FUNCTION_PATTERN.test(compactWithoutComments) ||
    isSafeExportAssignment(compactWithoutComments)
  ) {
    return true;
  }

  return isCanonicalWrapperStatement(compactWithoutComments);
}

function stripTrailingSemicolon(statement: string): string {
  return statement.endsWith(";")
    ? statement.slice(0, -1).trim()
    : statement;
}

function stripTrustedLeadingScaffolding(statement: string): string {
  let remaining = statement.trimStart();
  const sentinelIndex = remaining.indexOf("/*__CT_TOPLEVEL__:");
  if (sentinelIndex > 0) {
    const prefix = remaining.slice(0, sentinelIndex);
    if (isTrustedScaffoldingPrefix(prefix)) {
      return remaining.slice(sentinelIndex).trimStart();
    }
  }
  while (remaining) {
    const strippedComments = stripAllowedLeadingComments(remaining);
    if (strippedComments !== remaining) {
      remaining = strippedComments;
      continue;
    }

    if (remaining.startsWith("/*__CT_TOPLEVEL__:")) {
      return remaining;
    }

    if (remaining.startsWith("function h(")) {
      const bodyStart = remaining.indexOf("{");
      if (bodyStart < 0) {
        return remaining;
      }
      const { end } = findBalancedRegion(remaining, bodyStart);
      const helperSource = remaining.slice(0, end + 1).trim();
      if (!LEADING_HELPER_FUNCTION_PATTERN.test(helperSource)) {
        return remaining;
      }
      remaining = remaining.slice(end + 1).trimStart();
      continue;
    }

    return remaining;
  }
  return remaining;
}

function isTrustedScaffoldingPrefix(statement: string): boolean {
  let remaining = statement.trimStart();
  while (remaining) {
    const strippedComments = stripAllowedLeadingComments(remaining);
    if (strippedComments !== remaining) {
      remaining = strippedComments;
      continue;
    }

    if (remaining.startsWith("function h(")) {
      const bodyStart = remaining.indexOf("{");
      if (bodyStart < 0) {
        return false;
      }
      const { end } = findBalancedRegion(remaining, bodyStart);
      const helperSource = remaining.slice(0, end + 1).trim();
      if (!LEADING_HELPER_FUNCTION_PATTERN.test(helperSource)) {
        return false;
      }
      remaining = remaining.slice(end + 1).trimStart();
      continue;
    }

    return false;
  }
  return true;
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
  return /^"(?:lift|handler|pattern|recipe)"$/.test(args[0]!.trim()) &&
    isTrustedItemId(args[1]!) &&
    hasFunctionExpressionShape(args[2]!);
}

function isValidFunctionWrapper(args: string[]): boolean {
  if (args.length !== 2) {
    return false;
  }
  return isTrustedItemId(args[0]!) && hasFunctionExpressionShape(args[1]!);
}

function isValidPureFunctionWrapper(args: string[]): boolean {
  if (args.length !== 3) {
    return false;
  }
  return isTrustedItemId(args[0]!) &&
    isTrustedCaptureManifest(args[1]!) &&
    isTrustedFunctionExpression(args[2]!);
}

function isValidDataWrapper(args: string[]): boolean {
  if (args.length !== 3) {
    return false;
  }
  return isTrustedItemId(args[0]!) && isTrustedCaptureManifest(args[1]!);
}

function isTrustedItemId(source: string): boolean {
  const value = source.trim();
  return STRING_LITERAL_PATTERN.test(value) && value.length > 2;
}

function isTrustedCaptureManifest(source: string): boolean {
  const trimmed = source.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) {
    return false;
  }
  const entriesSource = trimmed.slice(1, -1).trim();
  if (!entriesSource) {
    return true;
  }
  return splitTopLevelCommaList(entriesSource).every((entry) =>
    STRING_LITERAL_PATTERN.test(entry.trim())
  );
}

function isTrustedFunctionExpression(source: string): boolean {
  if (!hasFunctionExpressionShape(source)) {
    return false;
  }
  const trimmed = source.trim();
  const paramsStart = trimmed.indexOf("(");
  const { end: paramsEnd } = findBalancedRegion(trimmed, paramsStart, "(", ")");
  const bodyStart = trimmed.indexOf("{", paramsEnd + 1);
  const bodyEnd = trimmed.lastIndexOf("}");
  const body = trimmed.slice(bodyStart + 1, bodyEnd);
  return !FORBIDDEN_AUTHORITY_PATTERN.test(body);
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
