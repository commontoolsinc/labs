import ts from "typescript";
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

// NOTE(ja): this isn't currently doing typechecking, but it could...

// NOTE(ja): we should probably send JSON of graph, not the function... but...
// 1. unsure how to run a JSON graph from a recipe
// 2. converting to JSON loses closures (which is we will want, but we
//    currently use closures to get around gaps in the current implementation)

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
        const importedModule = await tsToExports(importSrc);
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
    },
    reportDiagnostics: true,
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

  let localImports: Record<string, any> | undefined;
  try {
    localImports = await ensureRequires(js);
  } catch (e) {
    return { errors: (e as Error).message };
  }

  // Custom module resolution
  const customRequire = (moduleName: string) => {
    if (localImports[moduleName]) {
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

  const DOMParser = await getDOMParser();

  const wrappedCode = `
    (async function(require) {
        const exports = {};
        globalThis.DOMParser = DOMParser;
        ${js}
        return exports;
    })`;

  try {
    const exports = await eval(wrappedCode)(customRequire);
    return { exports };
  } catch (e) {
    return { errors: (e as Error).message };
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
