import ts from "typescript";
import { RawSourceMap, SourceMapConsumer } from "source-map-js";
import * as commonHtml from "@commontools/html";
import * as merkleReference from "merkle-reference";
import turndown from "turndown";
import { createBuilder } from "../builder/factory.ts";
import { h } from "@commontools/api";
import { type IRuntime } from "../runtime.ts";

let DOMParser: any;

type TypeScriptAPI = typeof import("typescript");
const getTSCompiler = (() => {
  let ts: Promise<TypeScriptAPI> | void;
  return function getTSCompiler(): Promise<TypeScriptAPI> {
    if (ts) {
      return ts;
    }
    ts = import("typescript").then((exports) => exports.default);
    return ts;
  };
})();

// NOTE(ja): importing JSDOM in browser throws an error :(
async function getDOMParser() {
  if (DOMParser) {
    return DOMParser;
  }
  if (globalThis.window?.DOMParser) {
    DOMParser = globalThis.window.DOMParser;
  } else {
    const { JSDOM } = await import("jsdom");
    const jsdom = new JSDOM("");
    DOMParser = jsdom.window.DOMParser;
  }
  return DOMParser;
}

const stackTracePattern =
  /at (?:[A-Z][a-zA-Z]+\.)?eval \((.+?)(?:, <anonymous>)?(?:\):|\:)(\d+):(\d+)\)/;

const sourceMaps = new Map<string, RawSourceMap>();
const sourceMapConsumers = new Map<string, SourceMapConsumer>();

// Fixes stack traces to use source map from eval. Strangely, both Deno and
// Chrome at least only observe `sourceURL` but not the source map, so we can
// use the former to find the right source map and then apply this.
export const mapSourceMapsOnStacktrace = (
  stack: string,
): string => {
  const lines = stack.split("\n");
  const mappedLines = lines.map((line) => {
    const match = line.match(stackTracePattern);

    if (match) {
      const fileName = match[1];
      const lineNum = parseInt(match[2], 10);
      const columnNum = parseInt(match[3], 10);

      if (!sourceMaps.has(fileName)) return line;

      if (!sourceMapConsumers.has(fileName)) {
        sourceMapConsumers.set(
          fileName,
          new SourceMapConsumer(sourceMaps.get(fileName)!),
        );
      }

      const originalPosition = sourceMapConsumers.get(fileName)!
        .originalPositionFor({
          line: lineNum,
          column: columnNum,
        });

      // Replace the original line with the mapped position information
      return `    at ${originalPosition.source}:${originalPosition.line}:${originalPosition.column}`;
    } else {
      return line;
    }
  });

  return mappedLines.join("\n");
};

const importCache: Record<string, any> = {};

const ensureRequires = async (
  js: string,
  config: EvalBuildConfig,
): Promise<Record<string, any>> => {
  const requires = /require\((['"])([^'"]+)\1\)/g;
  const sagaCastorPattern =
    /https:\/\/paas\.saga-castor\.ts\.net\/blobby\/blob\/[^/]+\/src/;

  const matches = [...js.matchAll(requires)];
  const localImports: Record<string, any> = {};
  for (const match of matches) {
    const modulePath = match[2];
    if (sagaCastorPattern.test(modulePath)) {
      if (!importCache[modulePath]) {
        // Fetch and compile the module
        const importSrc = await fetch(modulePath).then((resp) => resp.text());
        const importedModule = await tsToExports(importSrc, {
          injection: config.injection,
          fileName: modulePath,
          runtime: config.runtime,
        });
        if (importedModule.errors) {
          throw new Error(
            `Failed to import ${modulePath}: ${importedModule.errors}`,
          );
        }
        importCache[modulePath] = importedModule.exports;
      }
      localImports[modulePath] = importCache[modulePath];
    }
  }
  return localImports;
};

export interface EvalBuildConfig {
  injection?: string;
  fileName?: string;
  runtime: IRuntime;
}

export const tsToExports = async (
  source: string,
  config: EvalBuildConfig,
): Promise<any> => {
  const ts = await getTSCompiler();
  const fileName = config.fileName ??
    merkleReference.refer(source).toString() + ".tsx";

  // Add error handling for compilation
  const result = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      strict: true,
      jsx: ts.JsxEmit.React,
      jsxFactory: "h",
      jsxFragmentFactory: "h.fragment",
      esModuleInterop: true,
      sourceMap: true, // Enable source map generation
      inlineSources: false, // Don't include original source in source maps
      inlineSourceMap: false, // Generate separate source map instead of inline
    },
    reportDiagnostics: true,
    fileName, // Add a filename for better source mapping
  });

  // Check for compilation errors
  if (result.diagnostics && result.diagnostics.length > 0) {
    const errors = result.diagnostics
      .map((diagnostic) => {
        const message = ts.flattenDiagnosticMessageText(
          diagnostic.messageText,
          "\n",
        );
        let locationInfo = "";

        if (diagnostic.file && diagnostic.start !== undefined) {
          const { line, character } = diagnostic.file
            .getLineAndCharacterOfPosition(
              diagnostic.start,
            );
          locationInfo = `[${line + 1}:${character + 1}] `; // +1 because TypeScript uses 0-based positions
        }

        return `Compilation Error: ${locationInfo}${message}`;
      })
      .join("\n");
    throw errors;
  }

  const js = result.outputText;

  // Parse source map if available - sourceMapText is already a JSON string
  try {
    if (result.sourceMapText) {
      const sourceMapData = JSON.parse(result.sourceMapText);
      if (sourceMapData) sourceMaps.set(fileName, sourceMapData);
    }
  } catch (e) {
    console.warn("Failed to parse source map", e);
  }

  let localImports: Record<string, any> | undefined;
  try {
    localImports = await ensureRequires(js, config);
  } catch (e) {
    const error = e as Error;
    // Add source location context if possible
    if (error.stack) {
      error.stack = mapSourceMapsOnStacktrace(error.stack);
    }
    throw error;
  }

  // Custom module resolution
  const customRequire = (moduleName: string) => {
    if (localImports && localImports[moduleName]) {
      return localImports[moduleName];
    }
    switch (moduleName) {
      case "@commontools/html":
        return Object.assign({}, commonHtml, { h });
      case "@commontools/runner":
      case "@commontools/builder":
      case "@commontools/builder/interface":
      case "commontools":
        return createBuilder(config.runtime);
      case "turndown":
        return turndown;
      default:
        throw new Error(`Module not found: ${moduleName}`);
    }
  };

  globalThis.DOMParser ??= await getDOMParser();

  let injection = "";
  if (config.injection) {
    // Enforce injection script being a single line for source map
    // reasons detailed below
    injection = config.injection.split("\n").join("");
  }

  // Important: ${js} is on the first line, so that the source map is accurate
  let wrappedCode =
    `(async function(require) { const exports = {}; ${injection} ${js}
return exports;
})`;

  if (result.sourceMapText) {
    // ${"sourceMappingURL"} prevents confusion with this file's source map
    wrappedCode += `
//# ${"sourceMappingURL"}=data:application/json;base64,${
      btoa(result.sourceMapText)
    }
//# ${"sourceURL"}=${fileName}
`;
  }

  try {
    return await eval(wrappedCode)(customRequire);
  } catch (e) {
    const error = e as Error;
    // Add source location context if possible
    if (error.stack) {
      error.stack = mapSourceMapsOnStacktrace(error.stack);
    }
    throw error;
  }
};
