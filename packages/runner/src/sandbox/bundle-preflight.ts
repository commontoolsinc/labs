import { getAMDLoader } from "../../../js-compiler/typescript/bundler/amd-loader.ts";
import {
  CompiledJsParseError,
  parseCompiledBundleSource,
  stripJsTrivia,
  tryParseDefineCall,
} from "./compiled-js-parser.ts";

const ALLOWED_TSLIB_HELPERS = new Set([
  "__createBinding",
  "__exportStar",
  "__importDefault",
  "__importStar",
  "__setModuleDefault",
]);

const CANONICAL_LOADER_BINDING = normalizeExact(
  `const { define, require } = (${
    getAMDLoader.toString().replace(/\n/g, "")
  })();`,
);
const CANONICAL_RUNTIME_DEPS_LOOP = normalizeExact(
  `for (const [name, dep] of Object.entries(runtimeDeps)) { define(name, ["exports"], exports => Object.assign(exports, dep)); }`,
);
const CANONICAL_CONSOLE_BINDING = normalizeExact(
  `const console = globalThis.console;`,
);
const CANONICAL_EXPORT_MAP_INIT = normalizeExact(
  `const exportMap = Object.create(null);`,
);
const CANONICAL_EXPORT_MAP_RETURN = normalizeExact(
  `return { main, exportMap };`,
);

export class BundlePreflightError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BundlePreflightError";
  }
}

export function preflightCompiledBundle(
  source: string,
  filename = "<bundle>",
): void {
  try {
    const bundle = parseCompiledBundleSource(source);
    let phase: "bootstrap" | "define" | "tail" = "bootstrap";
    let sawDefine = false;

    for (const statement of bundle.body.statements) {
      if (isBootstrapStatement(statement.text)) {
        if (phase !== "bootstrap") {
          throw new BundlePreflightError(
            "Bundle bootstrap helpers must appear before module definitions",
          );
        }
        continue;
      }

      if (tryParseDefineCall(source, statement)) {
        if (phase === "tail") {
          throw new BundlePreflightError(
            "AMD module definitions must appear before bundle return wiring",
          );
        }
        phase = "define";
        sawDefine = true;
        continue;
      }

      if (isTailStatement(statement.text)) {
        phase = "tail";
        continue;
      }

      throw new BundlePreflightError(
        "Compiled bundle contains unsupported top-level executable code",
      );
    }

    if (!sawDefine) {
      throw new BundlePreflightError(
        "Compiled bundle must register at least one AMD module",
      );
    }
  } catch (error) {
    if (error instanceof BundlePreflightError) {
      throw error;
    }
    if (error instanceof CompiledJsParseError) {
      throw new BundlePreflightError(
        `${filename}: ${error.message}`,
      );
    }
    throw error;
  }
}

function isBootstrapStatement(source: string): boolean {
  const normalized = normalizeExact(source);
  return normalized === CANONICAL_LOADER_BINDING ||
    normalized === CANONICAL_RUNTIME_DEPS_LOOP ||
    normalized === CANONICAL_CONSOLE_BINDING ||
    isAllowedTsLibHelperDeclaration(normalized);
}

function isAllowedTsLibHelperDeclaration(normalized: string): boolean {
  const match = normalized.match(/^var([A-Za-z_$][\w$]*)=/);
  if (!match || !ALLOWED_TSLIB_HELPERS.has(match[1])) {
    return false;
  }

  switch (match[1]) {
    case "__importDefault":
      return /^var__importDefault=\(this&&this\.__importDefault\)\|\|function\(\w+\)\{return\(\w+&&\w+\.__esModule\)\?\w+:\{"default":\w+\};\};?$/
        .test(normalized);
    case "__importStar":
      return /^var__importStar=\(this&&this\.__importStar\)\|\|function\(\w+\)\{.*return\w+;\};?$/
        .test(normalized) ||
        /^var__importStar=\(function\(\)\{.*returnfunction\(\w+\)\{.*return\w+;\};\}\)\(\);?$/
          .test(normalized) ||
        /^var__importStar=\(this&&this\.__importStar\)\|\|\(function\(\)\{.*returnfunction\(\w+\)\{.*return\w+;\};\}\)\(\);?$/
          .test(normalized);
    case "__createBinding":
      return /^var__createBinding=\(this&&this\.__createBinding\)\|\|\(Object\.create\?.+:.+\);?$/
        .test(normalized);
    case "__setModuleDefault":
      return /^var__setModuleDefault=\(this&&this\.__setModuleDefault\)\|\|\(Object\.create\?.+:.+\);?$/
        .test(normalized);
    case "__exportStar":
      return /^var__exportStar=\(this&&this\.__exportStar\)\|\|function\(\w+,\w+\)\{.*\};?$/
        .test(normalized) ||
        /^var__exportStar=function\(\w+,\w+\)\{.*\};?$/.test(normalized);
    default:
      return false;
  }
}

function isTailStatement(source: string): boolean {
  const normalized = normalizeExact(source);
  return isReturnRequireStatement(normalized) ||
    isMainBindingStatement(normalized) ||
    normalized === CANONICAL_EXPORT_MAP_INIT ||
    isExportMapAssignment(normalized) ||
    normalized === CANONICAL_EXPORT_MAP_RETURN;
}

function isReturnRequireStatement(normalized: string): boolean {
  return /^returnrequire\((['"]).+\1\);?$/.test(normalized);
}

function isMainBindingStatement(normalized: string): boolean {
  return /^constmain=require\((['"]).+\1\);?$/.test(normalized);
}

function isExportMapAssignment(normalized: string): boolean {
  return /^exportMap\[(["']).+\1\]=require\((['"]).+\2\);?$/.test(normalized);
}

function normalizeExact(source: string): string {
  return stripJsTrivia(source.replace(/\n/g, "")).replace(/\s+/g, "");
}
