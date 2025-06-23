import ts from "typescript";
import { createOpaqueRefTransformer } from "../typescript/transformer/mod.ts";
import { getTypeScriptEnvironmentTypes } from "../mod.ts";

// Cache environment types
let envTypesCache: Record<string, string> | undefined;

/**
 * Test utility for transforming TypeScript source code with the OpaqueRef transformer.
 */
export async function transformSource(
  source: string,
  options: {
    mode?: "transform" | "error";
    debug?: boolean;
    types?: Record<string, string>;
    logger?: (message: string) => void;
  } = {},
): Promise<string> {
  const { mode = "transform", debug = false, types = {}, logger } = options;
  
  // Get environment types if not cached
  if (!envTypesCache) {
    envTypesCache = await getTypeScriptEnvironmentTypes();
  }

  // Create a minimal program for testing
  const fileName = "/test.tsx";
  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.CommonJS,
    jsx: ts.JsxEmit.React,
    jsxFactory: "h",
    strict: true,
  };

  // Combine all types
  const allTypes = { ...envTypesCache, ...types };

  // Create a custom compiler host
  const host: ts.CompilerHost = {
    getSourceFile: (name) => {
      if (name === fileName) {
        return ts.createSourceFile(name, source, compilerOptions.target!, true);
      }
      
      // Check for lib.d.ts -> map to es2023
      if (name === "lib.d.ts" || name.endsWith("/lib.d.ts")) {
        return ts.createSourceFile(
          name,
          allTypes.es2023 || "",
          compilerOptions.target!,
          true,
        );
      }
      
      // Handle type files
      if (allTypes[name]) {
        return ts.createSourceFile(
          name,
          allTypes[name],
          compilerOptions.target!,
          true,
        );
      }
      // Check for commontools.d.ts without path
      const baseName = name.split('/').pop();
      if (baseName && allTypes[baseName]) {
        return ts.createSourceFile(
          name,
          allTypes[baseName],
          compilerOptions.target!,
          true,
        );
      }
      return undefined;
    },
    writeFile: () => {},
    getCurrentDirectory: () => "/",
    getDirectories: () => [],
    fileExists: (name) => {
      if (name === fileName) return true;
      if (name === "lib.d.ts" || name.endsWith("/lib.d.ts")) return true;
      if (allTypes[name]) return true;
      const baseName = name.split('/').pop();
      if (baseName && allTypes[baseName]) return true;
      return false;
    },
    readFile: (name) => {
      if (name === fileName) return source;
      if (name === "lib.d.ts" || name.endsWith("/lib.d.ts")) return allTypes.es2023;
      if (allTypes[name]) return allTypes[name];
      const baseName = name.split('/').pop();
      if (baseName && allTypes[baseName]) return allTypes[baseName];
      return undefined;
    },
    getCanonicalFileName: (name) => name,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    getDefaultLibFileName: () => "lib.d.ts",
    resolveModuleNames: (moduleNames, containingFile) => {
      return moduleNames.map((name) => {
        if (name === "commontools" && types["commontools.d.ts"]) {
          return {
            resolvedFileName: "commontools.d.ts",
            extension: ts.Extension.Dts,
            isExternalLibraryImport: false,
          };
        }
        return undefined;
      });
    },
  };

  // Create the program
  const program = ts.createProgram([fileName], compilerOptions, host);

  // Create the transformer
  const transformer = createOpaqueRefTransformer(program, {
    mode,
    debug,
    logger,
  });

  // Transform the source file
  const sourceFile = program.getSourceFile(fileName)!;
  const result = ts.transform(sourceFile, [transformer]);

  // Print the result
  const printer = ts.createPrinter();
  const output = printer.printFile(result.transformed[0]);
  
  if (debug && logger) {
    logger(`\n=== TEST TRANSFORMER OUTPUT ===\n${output}\n=== END OUTPUT ===`);
  }
  
  return output;
}

/**
 * Test utility for checking if a transformation would occur without actually transforming.
 */
export async function checkWouldTransform(
  source: string,
  types: Record<string, string> = {},
): Promise<boolean> {
  try {
    await transformSource(source, { mode: "error", types });
    return false; // No error means no transformation needed
  } catch (e) {
    return true; // Error means transformation would occur
  }
}
