import { getAMDLoader } from "../../../js-compiler/typescript/bundler/amd-loader.ts";
import {
  findBalancedRegion,
  splitTopLevelStatements,
} from "./token-scanner.ts";

const BUNDLE_PREFIX = "((runtimeDeps={}) => {";
const BUNDLE_SUFFIX = "});";

const TRUSTED_PRELUDE_STATEMENTS = [
  stripNewLines("const __ctAmdHooks = runtimeDeps.__ctAmdHooks ?? {};"),
  stripNewLines(
    `const { define, require } = (${getAMDLoader.toString()})(__ctAmdHooks);`,
  ),
  stripNewLines(
    `for (const [name, dep] of Object.entries(runtimeDeps)) {
      if (name === "__ctAmdHooks") continue;
      define(name, ["exports"], exports => Object.assign(exports, dep));
    }`,
  ),
];

const DEFINE_PATTERN = /^define\("([^"]+)",\s*\[/;
const RETURN_MAIN_PATTERN = /^const main = require\("([^"]+)"\)$/;
const EXPORT_MAP_INIT_PATTERN = /^const exportMap = Object\.create\(null\)$/;
const EXPORT_MAP_ASSIGNMENT_PATTERN =
  /^exportMap\["[^"]+"\] = require\("([^"]+)"\)$/;
const RETURN_OBJECT_PATTERN = /^return \{\s*main,\s*exportMap\s*\}$/;
const RETURN_REQUIRE_PATTERN = /^return require\("([^"]+)"\)$/;
const TRUSTED_TS_HELPER_PATTERNS = [
  /^var __createBinding = \(this && this\.__createBinding\) \|\| \(Object\.create \? \(function\(o, m, k, k2\) \{[\s\S]*\}\) : \(function\(o, m, k, k2\) \{[\s\S]*\}\)\)$/,
  /^var __exportStar = \(this && this\.__exportStar\) \|\| function\(m, exports\) \{[\s\S]*\}$/,
  /^var __importDefault = \(this && this\.__importDefault\) \|\| function ?\(mod\) \{[\s\S]*\}$/,
  /^var __setModuleDefault = \(this && this\.__setModuleDefault\) \|\| \(Object\.create \? \(function\(o, v\) \{[\s\S]*\}\) : function\(o, v\) \{[\s\S]*\}\)$/,
  /^var __importStar = \(this && this\.__importStar\) \|\| \(function ?\(\) \{[\s\S]*return function ?\(mod\) \{[\s\S]*\};?[\s\S]*\}\)\(\)$/,
];

export function extractBundleRegion(bundleSource: string): string {
  return parseBundle(bundleSource).defineStatements.join("");
}

export function extractDefinedModuleIds(bundleSource: string): string[] {
  return parseBundle(bundleSource).defineStatements.map((statement) => {
    const match = stripTrailingSemicolon(statement).match(DEFINE_PATTERN);
    if (!match) {
      throw new Error("Bundle contains a malformed define() registration");
    }
    return match[1]!;
  });
}

export function verifyBundlePreflight(bundleSource: string): void {
  parseBundle(bundleSource);
}

function parseBundle(bundleSource: string): { defineStatements: string[] } {
  const normalizedSource = normalizeBundleSource(bundleSource);
  if (
    !normalizedSource.startsWith(BUNDLE_PREFIX) ||
    !normalizedSource.endsWith(BUNDLE_SUFFIX)
  ) {
    throw new Error("Bundle is missing the trusted AMD wrapper structure");
  }

  const body = normalizedSource.slice(
    BUNDLE_PREFIX.length,
    normalizedSource.length - BUNDLE_SUFFIX.length,
  );
  const statements = splitTopLevelStatements(body);

  if (statements.length < TRUSTED_PRELUDE_STATEMENTS.length + 2) {
    throw new Error("Bundle is missing the trusted AMD wrapper structure");
  }

  for (let index = 0; index < TRUSTED_PRELUDE_STATEMENTS.length; index++) {
    if (
      normalizeTrustedStatement(statements[index]!) !==
        normalizeTrustedStatement(TRUSTED_PRELUDE_STATEMENTS[index]!)
    ) {
      throw new Error("Bundle is missing the trusted AMD wrapper prelude");
    }
  }

  const remainingStatements = statements.slice(
    TRUSTED_PRELUDE_STATEMENTS.length,
  );
  let helperIndex = 0;
  while (
    helperIndex < remainingStatements.length &&
    isTrustedTSHelperStatement(remainingStatements[helperIndex]!)
  ) {
    helperIndex++;
  }

  const statementsAfterHelpers = remainingStatements.slice(helperIndex);
  const defineStatements: string[] = [];
  let index = 0;
  while (
    index < statementsAfterHelpers.length &&
    DEFINE_PATTERN.test(stripTrailingSemicolon(statementsAfterHelpers[index]!))
  ) {
    defineStatements.push(statementsAfterHelpers[index]!);
    index++;
  }

  if (defineStatements.length === 0) {
    throw new Error("Bundle does not register any AMD modules");
  }

  const returnStatements = statementsAfterHelpers.slice(index).map(
    stripTrailingSemicolon,
  );
  if (!isTrustedReturnWrapper(returnStatements)) {
    throw new Error("Bundle is missing the trusted return wrapper");
  }

  return { defineStatements };
}

function isTrustedReturnWrapper(statements: string[]): boolean {
  if (statements.length === 1) {
    return RETURN_REQUIRE_PATTERN.test(statements[0]!);
  }
  if (statements.length < 3) {
    return false;
  }
  if (
    !RETURN_MAIN_PATTERN.test(statements[0]!) ||
    !EXPORT_MAP_INIT_PATTERN.test(statements[1]!)
  ) {
    return false;
  }

  const middleStatements = statements.slice(2, -1);
  if (middleStatements.length === 0) {
    return false;
  }
  if (
    !middleStatements.every((statement) =>
      EXPORT_MAP_ASSIGNMENT_PATTERN.test(statement)
    )
  ) {
    return false;
  }
  return RETURN_OBJECT_PATTERN.test(statements.at(-1)!);
}

function normalizeBundleSource(bundleSource: string): string {
  return bundleSource
    .split("\n")
    .filter((line) =>
      !line.startsWith("//# sourceMappingURL=") &&
      !line.startsWith("//# sourceURL=")
    )
    .join("\n")
    .trim();
}

function stripTrailingSemicolon(statement: string): string {
  return statement.endsWith(";")
    ? statement.slice(0, -1).trim()
    : statement.trim();
}

function stripNewLines(input: string): string {
  return input.replace(/\n/g, "");
}

function isTrustedTSHelperStatement(statement: string): boolean {
  const normalized = normalizeTrustedStatement(statement);
  return TRUSTED_TS_HELPER_PATTERNS.some((pattern) => pattern.test(normalized));
}

function normalizeTrustedStatement(statement: string): string {
  return stripTrailingSemicolon(statement).replace(/\s+/g, " ").trim();
}

export function extractFirstFactoryBody(defineSource: string): string {
  const factoryIndex = defineSource.indexOf("function");
  if (factoryIndex < 0) {
    throw new Error("AMD module is missing a factory function");
  }
  const bodyStart = defineSource.indexOf("{", factoryIndex);
  if (bodyStart < 0) {
    throw new Error("AMD factory is missing a body");
  }
  const { end } = findBalancedRegion(defineSource, bodyStart);
  return defineSource.slice(bodyStart + 1, end);
}
