import ts from "typescript";
import * as commonHtml from "@commontools/common-html";
import * as commonBuilder from "@commontools/common-builder";
import * as commonSystem from "@commontools/common-system";
import * as zod from "zod";
import * as zodToJsonSchema from "zod-to-json-schema";

import * as collectionSugar from "./sugar/build.js";
import * as querySugar from "./sugar/query.js";
import * as eventSugar from "./sugar/event.js";
import * as zodSugar from "./sugar/zod.js";
import * as sugar from "./sugar.js";
import * as spellUtil from "./spells/spell.jsx";
import * as merkleReference from "merkle-reference";

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
        const importSrc = await fetch(modulePath).then(resp => resp.text());
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
      .map(diagnostic => {
        const message = ts.flattenDiagnosticMessageText(
          diagnostic.messageText,
          "\n",
        );
        let locationInfo = "";

        if (diagnostic.file && diagnostic.start !== undefined) {
          const { line, character } =
            diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
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
      case "../sugar/build.js":
        return collectionSugar;
      case "../sugar/query.js":
        return querySugar;
      case "../sugar/event.js":
        return eventSugar;
      case "../sugar/zod.js":
        return zodSugar;
      case "../sugar.js":
        return sugar;
      case "./spell.jsx":
        return spellUtil;
      case "@commontools/common-html":
        return commonHtml;
      case "@commontools/common-builder":
        return commonBuilder;
      case "@commontools/common-system":
        return commonSystem;
      case "zod":
        return zod;
      case "merkle-reference":
        return merkleReference;
      case "zod-to-json-schema":
        return zodToJsonSchema;
      default:
        throw new Error(`Module not found: ${moduleName}`);
    }
  };

  const wrappedCode = `
    (function(require) {
        const exports = {};
        ${js}
        return exports;
    })(${customRequire.toString()})`;

  try {
    const exports = eval(wrappedCode);
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
