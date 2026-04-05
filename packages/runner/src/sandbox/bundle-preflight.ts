import { getAMDLoader } from "../../../js-compiler/typescript/bundler/amd-loader.ts";
import { getLogger } from "@commonfabric/utils/logger";
import {
  CompiledJsParseError,
  parseCompiledBundleSource,
  type ParsedBundle,
  stripJsTrivia,
} from "./compiled-js-parser.ts";

const logger = getLogger("bundle-preflight");

const ALLOWED_TSLIB_HELPERS = new Set([
  "__createBinding",
  "__exportStar",
  "__importDefault",
  "__setModuleDefault",
]);

const IDENT = String.raw`([A-Za-z_$][\w$]*)`;
const CANONICAL_CREATE_BINDING_PATTERN = new RegExp(
  String
    .raw`^var__createBinding=\(this&&this\.__createBinding\)\|\|\(Object\.create\?\(function\(${IDENT},${IDENT},${IDENT},${IDENT}\)\{if\(\4===undefined\)\4=\3;var${IDENT}=Object\.getOwnPropertyDescriptor\(\2,\3\);if\(!\5\|\|\("get"in\5\?!\2\.__esModule:\5\.writable\|\|\5\.configurable\)\)\{\5=\{enumerable:true,get:function\(\)\{return\2\[\3\];\}\};\}Object\.defineProperty\(\1,\4,\5\);\}\):\(function\(\1,\2,\3,\4\)\{if\(\4===undefined\)\4=\3;\1\[\4\]=\2\[\3\];\}\)\);?$`,
);
const CANONICAL_EXPORT_STAR_PATTERNS = [
  new RegExp(
    String
      .raw`^var__exportStar=\(this&&this\.__exportStar\)\|\|function\(${IDENT},${IDENT}\)\{for\(var${IDENT}in\1\)if\(\3!==("default"|'default')&&!Object\.prototype\.hasOwnProperty\.call\(\2,\3\)\)__createBinding\(\2,\1,\3\);\};?$`,
  ),
  new RegExp(
    String
      .raw`^var__exportStar=function\(${IDENT},${IDENT}\)\{for\(var${IDENT}in\1\)if\(\3!==("default"|'default')&&!Object\.prototype\.hasOwnProperty\.call\(\2,\3\)\)__createBinding\(\2,\1,\3\);\};?$`,
  ),
];
const CANONICAL_SET_MODULE_DEFAULT_PATTERN = new RegExp(
  String
    .raw`^var__setModuleDefault=\(this&&this\.__setModuleDefault\)\|\|\(Object\.create\?\(function\(${IDENT},${IDENT}\)\{Object\.defineProperty\(\1,"default",\{enumerable:true,value:\2\}\);\}\):function\(\1,\2\)\{\1\["default"\]=\2;\}\);?$`,
);

const CANONICAL_LOADER_BINDINGS = [
  normalizeExact(
    `const { define, require } = (${
      getAMDLoader.toString().replace(/\n/g, "")
    })();`,
  ),
  normalizeExact(
    `const { define, require } = (${
      getAMDLoader.toString().replace(/\n/g, "")
    })(__ctAmdHooks);`,
  ),
  normalizeExact(
    `const __ctAmdHooks = runtimeDeps.__ctAmdHooks ?? {}; const { define, require } = (${
      getAMDLoader.toString().replace(/\n/g, "")
    })(__ctAmdHooks);`,
  ),
];
const CANONICAL_AMD_HOOKS_BINDINGS = [
  normalizeExact(`const __ctAmdHooks = runtimeDeps.__ctAmdHooks ?? {};`),
];
const CANONICAL_RUNTIME_DEPS_LOOPS = [
  normalizeExact(
    `for (const [name, dep] of Object.entries(runtimeDeps)) { define(name, ["exports"], exports => Object.assign(exports, dep)); }`,
  ),
  normalizeExact(
    `for (const [name, dep] of Object.entries(runtimeDeps)) { if (name === "__ctAmdHooks") continue; define(name, ["exports"], exports => Object.assign(exports, dep)); }`,
  ),
];
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
    logger.timeStart("parseBundle");
    let bundle: ParsedBundle;
    try {
      bundle = parseCompiledBundleSource(source);
    } finally {
      logger.timeEnd("parseBundle");
    }
    preflightParsedCompiledBundle(source, bundle, filename);
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

export function preflightParsedCompiledBundle(
  source: string,
  bundle: ParsedBundle,
  filename = "<bundle>",
): void {
  try {
    let phase: "bootstrap" | "define" | "tail" = "bootstrap";
    let sawDefine = false;
    const defineStatementStarts = new Set(
      bundle.defineCalls.map(({ statement }) => statement.start),
    );

    logger.timeStart("scanStatements");
    try {
      for (const statement of bundle.body.statements) {
        if (isBootstrapStatement(source, statement.start, statement.end)) {
          if (phase !== "bootstrap") {
            throw new BundlePreflightError(
              "Bundle bootstrap helpers must appear before module definitions",
            );
          }
          continue;
        }

        if (defineStatementStarts.has(statement.start)) {
          if (phase === "tail") {
            throw new BundlePreflightError(
              "AMD module definitions must appear before bundle return wiring",
            );
          }
          phase = "define";
          sawDefine = true;
          continue;
        }

        if (isTailStatement(source, statement.start, statement.end)) {
          phase = "tail";
          continue;
        }

        throw new BundlePreflightError(
          "Compiled bundle contains unsupported top-level executable code",
        );
      }
    } finally {
      logger.timeEnd("scanStatements");
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

function isBootstrapStatement(
  source: string,
  start: number,
  end: number,
): boolean {
  const normalized = normalizeExact(source, start, end);
  return CANONICAL_AMD_HOOKS_BINDINGS.includes(normalized) ||
    CANONICAL_LOADER_BINDINGS.includes(normalized) ||
    CANONICAL_RUNTIME_DEPS_LOOPS.includes(normalized) ||
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
    case "__createBinding":
      return CANONICAL_CREATE_BINDING_PATTERN.test(normalized);
    case "__exportStar":
      return CANONICAL_EXPORT_STAR_PATTERNS.some((pattern) =>
        pattern.test(normalized)
      );
    case "__setModuleDefault":
      return CANONICAL_SET_MODULE_DEFAULT_PATTERN.test(normalized);
    default:
      return false;
  }
}

function isTailStatement(
  source: string,
  start: number,
  end: number,
): boolean {
  const normalized = normalizeExact(source, start, end);
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

function normalizeExact(
  source: string,
  start = 0,
  end = source.length,
): string {
  return stripJsTrivia(source, start, end).replace(/\s+/g, "");
}
