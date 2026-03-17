import {
  SES_SENTINEL_PREFIX,
  TRUSTED_RUNTIME_MODULES,
} from "./abi.ts";
import {
  findBalancedRegion,
  splitTopLevelStatements,
} from "./token-scanner.ts";

export interface VerifyAMDFactoryOptions {
  moduleId: string;
  dependencies: string[];
  registeredModuleIds: ReadonlySet<string>;
  factorySource: string;
}

const WRAPPER_PATTERN =
  /^\/\*__CT_TOPLEVEL__:[^*]+\*\/const\s+[$A-Z_a-z][\w$]*\s*=\s*__(?:ct_builder|ct_fn|ct_pure_fn|ct_data)\(/;
const SCHEMA_ASSIGNMENT_PATTERN =
  /^[$A-Z_a-z][\w$]*\.(?:argumentSchema|resultSchema)\s*=/;
const EXPORT_ASSIGNMENT_PATTERN =
  /^exports\.[A-Za-z_$][\w$]*\s*=/;
const CONSOLE_STATEMENT_PATTERN =
  /^console\.[A-Za-z_$][\w$]*\(/;
const USE_STRICT_PATTERN = /^["']use strict["']$/;
const EXPORTS_OBJECT_PATTERN =
  /^Object\.defineProperty\(exports,\s*["']__esModule["'],\s*\{\s*value:\s*true\s*\}\)$/;

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
  if (!body.includes(SES_SENTINEL_PREFIX)) {
    throw new Error("Factory is missing SES top-level sentinels");
  }
  if (/require\s*\(\s*\[/.test(body)) {
    throw new Error("AMD async require() is not allowed in verified factories");
  }
  if (/__importStar|__importDefault/.test(body)) {
    throw new Error("Lowered dynamic import helpers are not allowed");
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
  const { end } = findBalancedRegion(trimmed, bodyStart);
  if (trimmed.slice(end + 1).trim() !== "") {
    throw new Error("Factory source contains trailing code after the body");
  }
  return trimmed.slice(bodyStart + 1, end);
}

function isAllowedStatement(statement: string): boolean {
  const normalized = stripTrailingSemicolon(statement.trim());
  if (!normalized) {
    return true;
  }
  if (
    USE_STRICT_PATTERN.test(normalized) ||
    EXPORTS_OBJECT_PATTERN.test(normalized) ||
    CONSOLE_STATEMENT_PATTERN.test(normalized) ||
    SCHEMA_ASSIGNMENT_PATTERN.test(normalized) ||
    EXPORT_ASSIGNMENT_PATTERN.test(normalized)
  ) {
    return true;
  }

  if (!normalized.startsWith(SES_SENTINEL_PREFIX)) {
    return false;
  }

  if (!WRAPPER_PATTERN.test(normalized)) {
    return false;
  }

  if (/=>|(?:^|[^\w$.])(?:new|class)\b/.test(normalized)) {
    return false;
  }

  return !/(?:^|[^\w$.])(?:globalThis|window|document)\b/.test(normalized);
}

function stripTrailingSemicolon(statement: string): string {
  return statement.endsWith(";")
    ? statement.slice(0, -1).trim()
    : statement;
}
