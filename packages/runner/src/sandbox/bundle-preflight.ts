import {
  findBalancedRegion,
  splitTopLevelStatements,
} from "./token-scanner.ts";

const AMD_LOADER_MARKER = "const { define, require } =";
const DEFINE_MARKER = "define(";
const BUNDLE_PREFIX = "((runtimeDeps={}) => {";
const BUNDLE_SUFFIX = "});";

export function extractBundleRegion(bundleSource: string): string {
  const normalizedSource = normalizeBundleSource(bundleSource);
  if (!normalizedSource.startsWith(BUNDLE_PREFIX)) {
    throw new Error("Bundle is missing the trusted AMD wrapper prelude");
  }
  if (!normalizedSource.endsWith(BUNDLE_SUFFIX)) {
    throw new Error("Bundle is missing the trusted AMD wrapper suffix");
  }

  const body = normalizedSource.slice(
    BUNDLE_PREFIX.length,
    normalizedSource.length - BUNDLE_SUFFIX.length,
  );
  const statements = splitTopLevelStatements(body);
  const firstDefineIndex = statements.findIndex((statement) =>
    stripTrailingSemicolon(statement).startsWith(DEFINE_MARKER)
  );
  if (firstDefineIndex < 0) {
    throw new Error("Bundle does not register any AMD modules");
  }

  const prelude = statements.slice(0, firstDefineIndex);
  if (!prelude.some((statement) => statement.includes(AMD_LOADER_MARKER))) {
    throw new Error("Bundle is missing the trusted AMD loader prelude");
  }

  const returnIndex = statements.findIndex((statement) =>
    stripTrailingSemicolon(statement).startsWith("return require(")
  );
  if (returnIndex < 0 || returnIndex < firstDefineIndex) {
    throw new Error("Bundle is missing the trusted return wrapper");
  }

  return statements.slice(firstDefineIndex, returnIndex).join("");
}

export function verifyBundlePreflight(bundleSource: string): void {
  const normalizedSource = normalizeBundleSource(bundleSource);
  if (!normalizedSource.startsWith(BUNDLE_PREFIX) || !normalizedSource.endsWith(BUNDLE_SUFFIX)) {
    throw new Error("Bundle is missing the trusted AMD wrapper structure");
  }
  const body = normalizedSource.slice(
    BUNDLE_PREFIX.length,
    normalizedSource.length - BUNDLE_SUFFIX.length,
  );
  const statements = splitTopLevelStatements(body);
  let seenDefine = false;
  let seenReturn = false;

  for (const statement of statements) {
    const normalized = stripTrailingSemicolon(statement);
    if (normalized.startsWith(DEFINE_MARKER)) {
      if (seenReturn) {
        throw new Error("Bundle registers modules after the trusted return");
      }
      seenDefine = true;
      continue;
    }
    if (normalized.startsWith("return require(")) {
      seenReturn = true;
      continue;
    }
    if (!seenDefine && isAllowedPreludeStatement(normalized)) {
      continue;
    }
    if (seenDefine && !seenReturn) {
      throw new Error("Bundle region contains untrusted top-level side effects");
    }
    throw new Error("Bundle contains untrusted wrapper epilogue code");
  }

  if (!seenDefine) {
    throw new Error("Bundle does not register any AMD modules");
  }
  if (!seenReturn) {
    throw new Error("Bundle is missing the trusted return wrapper");
  }
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

function isAllowedPreludeStatement(statement: string): boolean {
  return statement.startsWith("const __ctAmdHooks =") ||
    statement.startsWith(AMD_LOADER_MARKER) ||
    statement.startsWith("for (const [name, dep] of Object.entries(runtimeDeps))");
}

function stripTrailingSemicolon(statement: string): string {
  return statement.endsWith(";")
    ? statement.slice(0, -1).trim()
    : statement.trim();
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
