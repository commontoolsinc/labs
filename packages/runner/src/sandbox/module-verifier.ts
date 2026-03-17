import {
  TRUSTED_RUNTIME_MODULES,
} from "./abi.ts";
import {
  splitTopLevelStatements,
} from "./token-scanner.ts";

export interface VerifyAMDFactoryOptions {
  moduleId: string;
  dependencies: string[];
  registeredModuleIds: ReadonlySet<string>;
  factorySource: string;
}

const WRAPPER_PATTERN =
  /^\/\*__CT_TOPLEVEL__:[^*]+\*\/\s*(?:const\s+[$A-Z_a-z][\w$]*\s*=|exports\.[A-Za-z_$][\w$]*\s*=)\s*(?:__ctHelpers\.)?__(?:ct_builder|ct_fn|ct_pure_fn|ct_data)\(/;
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
    if (!isAllowedStatement(statement)) {
      throw new Error(
        `Factory contains a non-canonical top-level statement: ${statement}`,
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

  if (!compactWithoutComments.startsWith("/*__CT_TOPLEVEL__:")) {
    return false;
  }

  if (!WRAPPER_PATTERN.test(compactWithoutComments)) {
    return false;
  }

  return true;
}

function stripTrailingSemicolon(statement: string): string {
  return statement.endsWith(";")
    ? statement.slice(0, -1).trim()
    : statement;
}

function stripTrustedLeadingScaffolding(statement: string): string {
  let remaining = statement.trimStart();
  while (remaining) {
    const strippedComments = stripAllowedLeadingComments(remaining);
    if (strippedComments !== remaining) {
      remaining = strippedComments;
      continue;
    }

    if (remaining.startsWith("/*__CT_TOPLEVEL__:")) {
      return remaining;
    }

    const helperMatch = remaining.match(LEADING_HELPER_FUNCTION_PATTERN);
    if (helperMatch) {
      remaining = remaining.slice(helperMatch[0].length).trimStart();
      continue;
    }

    return remaining;
  }
  return remaining;
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
