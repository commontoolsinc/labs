import ts from "typescript";
import { join } from "@std/path";
import { StaticCache } from "@commontools/static";
import {
  createModularOpaqueRefTransformer,
  createSchemaTransformer,
} from "../src/mod.ts";
import { assertDefined } from "../src/core/assert.ts";
const ENV_TYPE_ENTRIES = ["es2023", "dom", "jsx"] as const;

type EnvTypeKey = (typeof ENV_TYPE_ENTRIES)[number];
let envTypesCache: Record<EnvTypeKey, string> | undefined;

export interface TransformOptions {
  mode?: "transform" | "error";
  types?: Record<string, string>;
  logger?: (message: string) => void;
  applySchemaTransformer?: boolean;
  applyOpaqueRefTransformer?: boolean;
  before?: Array<(program: ts.Program) => ts.TransformerFactory<ts.SourceFile>>;
  after?: Array<(program: ts.Program) => ts.TransformerFactory<ts.SourceFile>>;
}

export async function transformSource(
  source: string,
  options: TransformOptions = {},
): Promise<string> {
  const {
    mode = "transform",
    types = {},
    logger,
    applySchemaTransformer = false,
    applyOpaqueRefTransformer = true,
    before = [],
    after = [],
  } = options;

  if (!envTypesCache) {
    envTypesCache = await loadEnvironmentTypes();
  }

  const fileName = "/test.tsx";
  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.CommonJS,
    jsx: ts.JsxEmit.React,
    jsxFactory: "h",
    strict: true,
  };

  const allTypes: Record<string, string> = {
    ...envTypesCache,
    ...types,
  };

  const host: ts.CompilerHost = {
    getSourceFile: (name) => {
      if (name === fileName) {
        return ts.createSourceFile(name, source, compilerOptions.target!, true);
      }
      if (name === "lib.d.ts" || name.endsWith("/lib.d.ts")) {
        return ts.createSourceFile(
          name,
          allTypes.es2023 || "",
          compilerOptions.target!,
          true,
        );
      }
      if (allTypes[name]) {
        return ts.createSourceFile(
          name,
          allTypes[name],
          compilerOptions.target!,
          true,
        );
      }
      const baseName = baseNameFromPath(name);
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
      const baseName = baseNameFromPath(name);
      if (baseName && allTypes[baseName]) return true;
      return false;
    },
    readFile: (name) => {
      if (name === fileName) return source;
      if (name === "lib.d.ts" || name.endsWith("/lib.d.ts")) {
        return allTypes.es2023;
      }
      if (allTypes[name]) return allTypes[name];
      const baseName = baseNameFromPath(name);
      if (baseName && allTypes[baseName]) return allTypes[baseName];
      return undefined;
    },
    getCanonicalFileName: (name) => name,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    getDefaultLibFileName: () => "lib.d.ts",
    resolveModuleNames: (moduleNames) => {
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
    resolveTypeReferenceDirectives: (typeDirectiveNames) =>
      typeDirectiveNames.map((directive) => {
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
      }),
  };

  const program = ts.createProgram([fileName], compilerOptions, host);

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

  const beforeTransformers = before.map((factory) => factory(program));
  const afterTransformers = after.map((factory) => factory(program));

  const transformers: ts.TransformerFactory<ts.SourceFile>[] = [
    ...beforeTransformers,
  ];
  if (applyOpaqueRefTransformer) {
    transformers.push(createModularOpaqueRefTransformer(program, { mode }));
  }
  if (applySchemaTransformer) {
    transformers.push(createSchemaTransformer(program));
  }
  transformers.push(...afterTransformers);

  const sourceFile = assertDefined(
    program.getSourceFile(fileName),
    "Expected virtual source file to be present in program",
  );
  const result = ts.transform(sourceFile, transformers);
  const printer = ts.createPrinter({
    newLine: ts.NewLineKind.LineFeed,
    removeComments: false,
  });
  const transformedFile = assertDefined(
    result.transformed[0],
    "Expected transformer pipeline to return a source file",
  );
  const output = printer.printFile(transformedFile);
  result.dispose?.();

  if (logger) {
    logger(`\n=== TEST TRANSFORMER OUTPUT ===\n${output}\n=== END OUTPUT ===`);
  }

  return output;
}

export async function loadFixture(path: string): Promise<string> {
  const fixturesDir = join(import.meta.dirname!, "fixtures");
  const fullPath = join(fixturesDir, path);
  const text = await Deno.readTextFile(fullPath);
  return text.trim();
}

export async function transformFixture(
  fixturePath: string,
  options?: TransformOptions,
): Promise<string> {
  const source = await loadFixture(fixturePath);
  const output = await transformSource(source, options);
  return output.trim();
}

export async function compareFixtureTransformation(
  inputPath: string,
  expectedPath: string,
  options?: TransformOptions,
): Promise<{ actual: string; expected: string; matches: boolean }> {
  const [actual, expected] = await Promise.all([
    transformFixture(inputPath, options),
    loadFixture(expectedPath),
  ]);

  const actualNormalized = actual.trim();
  const expectedNormalized = expected.trim();

  return {
    actual: actualNormalized,
    expected: expectedNormalized,
    matches: actualNormalized === expectedNormalized,
  };
}

async function loadEnvironmentTypes(): Promise<Record<EnvTypeKey, string>> {
  const cache = new StaticCache();
  const entries = await Promise.all(
    ENV_TYPE_ENTRIES.map(async (key) =>
      [key, await cache.getText(`types/${key}.d.ts`)] as const
    ),
  );
  return Object.fromEntries(entries) as Record<EnvTypeKey, string>;
}

function baseNameFromPath(path: string): string | undefined {
  const segments = path.split("/");
  return segments.length > 0 ? segments[segments.length - 1] : undefined;
}
