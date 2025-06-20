import ts from "typescript";
import { createOpaqueRefTransformer } from "./opaque-ref.ts";

/**
 * Test utility for transforming TypeScript source code with the OpaqueRef transformer.
 */
export function transformSource(
  source: string,
  options: {
    mode?: 'transform' | 'error';
    debug?: boolean;
    types?: Record<string, string>;
    logger?: (message: string) => void;
  } = {},
): string {
  const { mode = 'transform', debug = false, types = {}, logger } = options;
  
  // Create a minimal program for testing
  const fileName = "/test.tsx";
  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.AMD,
    jsx: ts.JsxEmit.React,
    jsxFactory: "h",
    strict: true,
  };
  
  // Create a custom compiler host
  const host: ts.CompilerHost = {
    getSourceFile: (name) => {
      if (name === fileName) {
        return ts.createSourceFile(name, source, compilerOptions.target!, true);
      }
      // Handle type files
      if (types[name]) {
        return ts.createSourceFile(name, types[name], compilerOptions.target!, true);
      }
      return undefined;
    },
    writeFile: () => {},
    getCurrentDirectory: () => "/",
    getDirectories: () => [],
    fileExists: (name) => name === fileName || !!types[name],
    readFile: (name) => name === fileName ? source : types[name],
    getCanonicalFileName: (name) => name,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    getDefaultLibFileName: () => "lib.d.ts",
    resolveModuleNames: (moduleNames, containingFile) => {
      return moduleNames.map(name => {
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
  const transformer = createOpaqueRefTransformer(program, { mode, debug, logger });
  
  // Transform the source file
  const sourceFile = program.getSourceFile(fileName)!;
  const result = ts.transform(sourceFile, [transformer]);
  
  // Print the result
  const printer = ts.createPrinter();
  return printer.printFile(result.transformed[0]);
}

/**
 * Test utility for checking if a transformation would occur without actually transforming.
 */
export function checkWouldTransform(
  source: string,
  types: Record<string, string> = {},
): boolean {
  try {
    transformSource(source, { mode: 'error', types });
    return false; // No error means no transformation needed
  } catch (e) {
    return true; // Error means transformation would occur
  }
}