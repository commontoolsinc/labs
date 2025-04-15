import ts from "typescript";
import { RawSourceMap, SourceMapConsumer } from "source-map-js";
import * as commonHtml from "@commontools/html";
import * as commonBuilder from "@commontools/builder";
import * as zod from "zod";
import * as zodToJsonSchema from "zod-to-json-schema";
import * as merkleReference from "merkle-reference";
import turndown from "turndown";

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
  /at eval \(eval at .+?\), (?:eval|<anonymous>|Function):(\d+):(\d+)\)/;

// Deno and browser compatible source map processing
// Maps JavaScript error locations back to TypeScript source code
const extractSourceLocation = (
  stack: string | undefined,
  sourceMapData: RawSourceMap | null,
): string => {
  if (!stack) return "Unknown error";
  if (!sourceMapData) return stack;

  const consumer = new SourceMapConsumer(sourceMapData);

  const lines = stack.split("\n");
  const mappedLines = lines.map((line) => {
    const match = line.match(stackTracePattern);

    if (match) {
      const lineNum = parseInt(match[1], 10);
      const columnNum = parseInt(match[2], 10);

      const originalPosition = consumer.originalPositionFor({
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

const ensureRequires = async (js: string): Promise<Record<string, any>> => {
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
        const importedModule = await tsToExports(importSrc, modulePath);
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

export const tsToExports = async (
  src: string,
  fileName?: string,
): Promise<{ exports?: any; errors?: string }> => {
  const ts = await getTSCompiler();

  // Add error handling for compilation
  const result = ts.transpileModule(src, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      strict: true,
      jsx: ts.JsxEmit.React,
      jsxFactory: "h",
      jsxFragmentFactory: "Fragment",
      esModuleInterop: true,
      sourceMap: true, // Enable source map generation
      inlineSources: true, // Include original source in source maps
      inlineSourceMap: false, // Generate separate source map instead of inline
    },
    reportDiagnostics: true,
    fileName: fileName ?? `${merkleReference.refer(src)}.tsx`, // Add a filename for better source mapping
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
    return { errors };
  }

  const js = result.outputText;

  // Parse source map if available - sourceMapText is already a JSON string
  let sourceMapData: RawSourceMap | null = null;
  try {
    if (result.sourceMapText) {
      sourceMapData = JSON.parse(result.sourceMapText);
    }
  } catch (e) {
    console.warn("Failed to parse source map", e);
  }

  let localImports: Record<string, any> | undefined;
  try {
    localImports = await ensureRequires(js);
  } catch (e) {
    const error = e as Error;
    // Add source location context if possible
    const errorWithContext = extractSourceLocation(error.stack, sourceMapData);
    return { errors: errorWithContext };
  }

  // Custom module resolution
  const customRequire = (moduleName: string) => {
    if (localImports && localImports[moduleName]) {
      return localImports[moduleName];
    }
    switch (moduleName) {
      case "@commontools/html":
        return commonHtml;
      case "@commontools/builder":
        return commonBuilder;
      case "zod":
        return zod;
      case "merkle-reference":
        return merkleReference;
      case "zod-to-json-schema":
        return zodToJsonSchema;
      case "turndown":
        return turndown;
      default:
        throw new Error(`Module not found: ${moduleName}`);
    }
  };

  globalThis.DOMParser ??= await getDOMParser();

  // Important that ${js} is on the first line, so that the source map is accurate
  const wrappedCode = `(async function(require) { const exports = {}; ${js}
return exports;
})
//# ${"sourceMappingURL"}=data:application/json;base64,${
    btoa(JSON.stringify(sourceMapData))
  }`;

  try {
    const exports = await eval(wrappedCode)(customRequire);
    return { exports };
  } catch (e) {
    const error = e as Error;
    // Add source location context if possible
    const errorWithContext = extractSourceLocation(
      error.stack,
      sourceMapData,
    );
    return { errors: errorWithContext };
  }
};

export const buildRecipe = async (
  src: string,
): Promise<{ recipe?: commonBuilder.Recipe; errors?: string }> => {
  if (!src) {
    return { errors: "No source code provided" };
  }

  const { exports, errors } = await tsToExports(src);

  if (errors) {
    return { errors };
  }

  return { recipe: exports.default };
};
