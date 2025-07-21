import ts from "typescript";
import {
  createOpaqueRefTransformer,
  createSchemaTransformer,
} from "../typescript/transformer/mod.ts";
import { getTypeScriptEnvironmentTypes } from "../mod.ts";
import { join } from "@std/path";
import { StaticCache } from "@commontools/static";

// Cache environment types
let envTypesCache: Record<string, string> | undefined;

/**
 * Test utility for transforming TypeScript source code with the OpaqueRef transformer.
 */
export async function transformSource(
  source: string,
  options: {
    mode?: "transform" | "error";
    types?: Record<string, string>;
    logger?: (message: string) => void;
    applySchemaTransformer?: boolean;
  } = {},
): Promise<string> {
  const {
    mode = "transform",
    types = {},
    logger,
    applySchemaTransformer = false,
  } = options;

  // Get environment types if not cached
  if (!envTypesCache) {
    const cache = new StaticCache();
    envTypesCache = await getTypeScriptEnvironmentTypes(cache);
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
      const baseName = name.split("/").pop();
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
      const baseName = name.split("/").pop();
      if (baseName && allTypes[baseName]) return true;
      return false;
    },
    readFile: (name) => {
      if (name === fileName) return source;
      if (name === "lib.d.ts" || name.endsWith("/lib.d.ts")) {
        return allTypes.es2023;
      }
      if (allTypes[name]) return allTypes[name];
      const baseName = name.split("/").pop();
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
        if (name === "@commontools/common" && types["commontools.d.ts"]) {
          return {
            resolvedFileName: "commontools.d.ts",
            extension: ts.Extension.Dts,
            isExternalLibraryImport: false,
          };
        }
        return undefined;
      });
    },
    resolveTypeReferenceDirectives: (
      typeDirectiveNames,
      containingFile,
      redirectedReference,
      options,
    ) => {
      return typeDirectiveNames.map((directive) => {
        const name = typeof directive === "string"
          ? directive
          : directive.fileName;
        if (allTypes[name]) {
          return {
            primary: true,
            resolvedFileName: name,
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

  // Check for errors when logger is provided
  if (logger) {
    const diagnostics = ts.getPreEmitDiagnostics(program);
    if (diagnostics.length > 0) {
      logger("=== TypeScript Diagnostics ===");
      diagnostics.forEach((diagnostic) => {
        const message = ts.flattenDiagnosticMessageText(
          diagnostic.messageText,
          "\n",
        );
        logger(`${diagnostic.file?.fileName || "unknown"}: ${message}`);
      });
      logger("=== End Diagnostics ===");
    }
  }

  // Create the transformers
  const transformers: ts.TransformerFactory<ts.SourceFile>[] = [];

  // Always add OpaqueRef transformer first
  transformers.push(createOpaqueRefTransformer(program, {
    mode,
    logger,
  }));

  // Optionally add schema transformer
  if (applySchemaTransformer) {
    transformers.push(createSchemaTransformer(program, {}));
  }

  // Transform the source file
  const sourceFile = program.getSourceFile(fileName)!;
  const result = ts.transform(sourceFile, transformers);

  // Print the result with 2-space indentation to match Deno style
  const printer = ts.createPrinter({
    newLine: ts.NewLineKind.LineFeed,
    removeComments: false,
  });
  const output = printer.printFile(result.transformed[0]);

  if (logger) {
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

/**
 * Load a fixture file from the fixtures directory
 */
export async function loadFixture(path: string): Promise<string> {
  const fixturesDir = join(import.meta.dirname!, "fixtures");
  const fullPath = join(fixturesDir, path);
  return await Deno.readTextFile(fullPath);
}

/**
 * Load multiple fixtures as a record
 */
export async function loadFixtures(
  paths: string[],
): Promise<Record<string, string>> {
  const fixtures: Record<string, string> = {};
  for (const path of paths) {
    fixtures[path] = await loadFixture(path);
  }
  return fixtures;
}

/**
 * Transform a fixture file
 */
export async function transformFixture(
  fixturePath: string,
  options?: Parameters<typeof transformSource>[1],
): Promise<string> {
  const source = await loadFixture(fixturePath);
  return transformSource(source, options);
}

/**
 * Compare fixture transformations
 */
export async function compareFixtureTransformation(
  inputPath: string,
  expectedPath: string,
  options?: Parameters<typeof transformSource>[1],
): Promise<{ actual: string; expected: string; matches: boolean }> {
  const [actual, expected] = await Promise.all([
    transformFixture(inputPath, options),
    loadFixture(expectedPath),
  ]);

  return {
    actual,
    expected,
    matches: actual.trim() === expected.trim(),
  };
}
