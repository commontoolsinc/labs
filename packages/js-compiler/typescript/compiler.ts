import {
  Compiler,
  JsScript,
  Program,
  ProgramResolver,
  Source,
} from "../interface.ts";
import type {
  CompilerHost,
  CompilerOptions,
  FileReference,
  ModuleResolutionHost,
  ResolvedModuleWithFailedLookupLocations,
  ResolvedProjectReference,
  ResolvedTypeReferenceDirectiveWithFailedLookupLocations,
  ScriptTarget,
  SourceFile,
  StringLiteralLike,
} from "typescript";
import ts from "typescript";
import * as path from "@std/path";
import { getLogger } from "@commontools/utils/logger";
import { getCompilerOptions, TARGET } from "./options.ts";
import { bundleAMDOutput } from "./bundler/mod.ts";
import { parseSourceMap } from "../source-map.ts";
import { resolveProgram } from "./resolver.ts";
import {
  Checker,
  type DiagnosticMessageTransformer,
  TransformerDiagnosticInfo,
  TransformerError,
} from "./diagnostics/mod.ts";

const DEBUG_VIRTUAL_FS = false;
const VFS_TYPES_DIR = "$types/";

// Create a separate debug logger for VirtualFs operations
const vfsLogger = getLogger("virtualfs", {
  enabled: DEBUG_VIRTUAL_FS,
  level: "debug",
});

// Mapping from virtual type path (e.g. `$types/es2023.d.ts`)
type TypeLibs = Record<string, string>;

class VirtualFs implements ModuleResolutionHost {
  private readonly types: Record<string, string>;
  private readonly fsRead: Record<string, string>;
  private readonly fsWrite: Record<string, string> = Object.create(null);
  private readonly debug: boolean;
  constructor(
    input: Program,
    typeLib: TypeLibs,
    debug?: boolean,
  ) {
    this.fsRead = input.files.reduce((acc, file) => {
      acc[file.name] = file.contents;
      return acc;
    }, Object.create(null));
    this.types = typeLib;
    this.debug = !!debug;
  }

  writeFile(fileName: unknown, content: unknown) {
    if (typeof fileName !== "string") {
      throw new Error("file name not string:" + typeof fileName);
    }
    if (typeof content !== "string") {
      throw new Error("content not string:" + typeof content);
    }
    vfsLogger.debug(
      "vfs",
      () => `writeFile - ${fileName} (${content.length} chars)`,
    );
    this.fsWrite[fileName] = content;
  }

  getCurrentDirectory(): string {
    vfsLogger.debug("vfs", () => "getCurrentDirectory - returning /");
    return "/";
  }

  getDirectories(_path: string): string[] {
    throw new Error("getDirectories() not implemented.");
  }

  fileExists(fileName: string): boolean {
    const exists = !!this.innerRead(fileName);
    vfsLogger.debug("vfs", () => `fileExists - ${fileName}: ${exists}`);
    return exists;
  }

  readFile(fileName: string): string | undefined {
    const content = this.innerRead(fileName);
    vfsLogger.debug(
      "vfs",
      () =>
        `readFile - ${fileName}: ${
          content ? content.length + " chars" : "not found"
        }`,
    );
    return content;
  }

  useCaseSensitiveFileNames() {
    return true;
  }

  getWrites(): Record<string, string> {
    return this.fsWrite;
  }

  private innerRead(fileName: string): string | undefined {
    let innerRecord;
    if (fileName.startsWith(VFS_TYPES_DIR)) {
      innerRecord = this.types;
    } else {
      innerRecord = this.fsRead;
    }
    const content = innerRecord[fileName];
    vfsLogger.debug(
      "vfs",
      () => `innerRead - ${fileName}: ${content ? "found" : "not found"}`,
    );
    return content;
  }
}

class TypeScriptHost extends VirtualFs implements CompilerHost {
  private allowedRuntimeModules: string[];
  constructor(
    source: Program,
    typeLibs: TypeLibs,
    allowedRuntimeModules: string[],
  ) {
    super(source, typeLibs, DEBUG_VIRTUAL_FS);
    this.allowedRuntimeModules = allowedRuntimeModules;
  }

  getDefaultLibFileName(_options: CompilerOptions): string {
    return "lib.d.ts";
  }

  getDefaultLibLocation(): string {
    return VFS_TYPES_DIR;
  }

  getEnvironmentVariable(_name: string): string | undefined {
    return undefined;
  }

  resolveTypeReferenceDirectiveReferences?<T extends FileReference | string>(
    _typeDirectiveReferences: readonly T[],
    _containingFile: string,
    _redirectedReference: ResolvedProjectReference | undefined,
    _options: CompilerOptions,
    _containingSourceFile: SourceFile | undefined,
    _reusedNames: readonly T[] | undefined,
  ): readonly ResolvedTypeReferenceDirectiveWithFailedLookupLocations[] {
    throw new Error("ResolveTypeReferenceDirectiveReferences");
  }

  getCanonicalFileName(fileName: string): string {
    return fileName;
  }

  getNewLine() {
    return "\n";
  }

  getSourceFile(
    fileName: string,
    languageVersion: ScriptTarget,
    _onError?: (message: string) => void,
  ): SourceFile | undefined {
    const sourceText = this.readFile(fileName);
    return sourceText !== undefined
      ? ts.createSourceFile(fileName, sourceText, languageVersion)
      : undefined;
  }

  resolveModuleNameLiterals(
    moduleLiterals: readonly StringLiteralLike[],
    containingFile: string,
  ): readonly ResolvedModuleWithFailedLookupLocations[] {
    return moduleLiterals.map((literal) => {
      const name = literal.text;
      if (name[0] === "." || name[0] === "/") {
        const resolved = path.join(path.dirname(containingFile), name);
        return {
          resolvedModule: {
            resolvedFileName: resolved,
            extension: ts.Extension.Ts,
          },
        };
      }
      // This module could not be found in the input
      // e.g. `@commontools/foo`. If a type definition was provided
      // with the same identifier with a `.d.ts` extension, that will be used
      // for types, leaving the module implementation resolution to runtime.
      if (this.allowedRuntimeModules.includes(name)) {
        return {
          resolvedModule: {
            resolvedFileName: `${name}.d.ts`,
            extension: ts.Extension.Dts,
            isExternalLibraryImport: true,
            packageId: undefined,
          },
        };
      }
      return { resolvedModule: undefined };
    });
  }
}

/**
 * Result from a transformer pipeline that can include diagnostics.
 */
export interface TransformerPipelineResult {
  factories: ts.TransformerFactory<ts.SourceFile>[];
  getDiagnostics?: () => readonly TransformerDiagnosticInfo[];
}

/**
 * Type for beforeTransformers - can return either:
 * - An array of transformer factories (legacy/simple case)
 * - A TransformerPipelineResult with factories and optional getDiagnostics
 */
export type BeforeTransformersResult =
  | ts.TransformerFactory<ts.SourceFile>[]
  | TransformerPipelineResult;

export interface TypeScriptCompilerOptions {
  // Filename for the output JS, used internally
  // with source maps.
  filename?: string;
  // Skip type checking.
  noCheck?: boolean;
  // Extra scripts to inject into the output bundle.
  injectedScript?: string;
  // Optional mapping of runtime module name e.g. `"@commontools/framework"`,
  // and its corresponding type definitions.
  runtimeModules?: string[];
  // Transformations to run before JS transforms.
  // Can return either an array of transformer factories (simple case)
  // or a TransformerPipelineResult with factories and getDiagnostics.
  beforeTransformers?: (
    program: ts.Program,
  ) => BeforeTransformersResult;
  // Return the transformed program.
  getTransformedProgram?: (program: Program) => void;
  // Whether the bundling process results in the bundle, upon invocation,
  // evaluating to the main entry's exports (false|undefined),
  // or an object containing the main/default export and a map of all files'
  // exports (true).
  // Changes the bundle's evaluation signature from
  // ```ts
  //   ({ runtimeDeps: Record<string, any> }) =>
  //     Record<string, any>;
  // ```
  // to
  //
  // ```ts
  //   ({ runtimeDeps: Record<string, any> }) =>
  //     { main: Record<string, any>, exportMap: Record<string, Record<string, any>> }`
  // ```
  bundleExportAll?: true;
  // Optional transformer for diagnostic error messages.
  // Allows converting confusing TypeScript errors into clearer messages.
  diagnosticMessageTransformer?: DiagnosticMessageTransformer;
}

export class TypeScriptCompiler implements Compiler<TypeScriptCompilerOptions> {
  private typeLibs: TypeLibs;
  constructor(typeLibs: TypeLibs) {
    this.typeLibs = Object.keys(typeLibs).reduce((libs, libName) => {
      libs[`${VFS_TYPES_DIR}${libName}.d.ts`] = typeLibs[libName];
      return libs;
    }, {} as TypeLibs);
  }

  resolveProgram(
    resolver: ProgramResolver,
    options: Pick<TypeScriptCompilerOptions, "runtimeModules"> = {},
  ): Promise<Program> {
    return resolveProgram(resolver, {
      unresolvedModules: {
        type: "allow",
        identifiers: options.runtimeModules ?? [],
      },
      resolveUnresolvedModuleTypes: true,
      target: TARGET,
    });
  }

  async resolveAndCompile(
    resolver: ProgramResolver,
    options: TypeScriptCompilerOptions = {},
  ): Promise<JsScript> {
    const program = await this.resolveProgram(resolver, options);
    return await this.compile(program, options);
  }

  // Compiles `source` into `JsArtifact`.
  // Artifact files must be TypeScriptModuleSource
  compile(
    program: Program,
    inputOptions: TypeScriptCompilerOptions = {},
  ): JsScript {
    const filename = inputOptions.filename ?? "out.js";
    const noCheck = inputOptions.noCheck ?? false;
    const injectedScript = inputOptions.injectedScript;
    const runtimeModules = inputOptions.runtimeModules ?? [];

    validateSource(program);
    const sourceNames = program.files.map(({ name }) => name);
    const tsOptions = getCompilerOptions();
    tsOptions.outFile = filename;

    const host = new TypeScriptHost(
      program,
      this.typeLibs,
      runtimeModules,
    );
    const tsProgram = ts.createProgram(
      sourceNames,
      tsOptions,
      host,
    );

    const checker = new Checker(tsProgram, {
      messageTransformer: inputOptions.diagnosticMessageTransformer,
    });
    if (!noCheck) {
      checker.typeCheck();
    }
    checker.declarationCheck();

    const mainSource = tsProgram.getSourceFiles().find((source) =>
      source.fileName === program.main
    );
    if (!mainSource) {
      throw new Error("Missing main source.");
    }

    const { beforeTransformers, sourceCollector, getDiagnostics } =
      createTransformers(
        tsProgram,
        inputOptions,
      );

    const { diagnostics, emittedFiles: _, emitSkipped } = tsProgram.emit(
      mainSource,
      undefined,
      undefined,
      undefined,
      { before: beforeTransformers },
    );
    // check() throws if there are real errors, returns true if all diagnostics
    // were filtered out (known false positives like CELL_BRAND/CELL_INNER_TYPE)
    const allDiagnosticsFiltered = checker.check(diagnostics);

    // Check for transformer diagnostics (from CommonTools pipeline)
    if (getDiagnostics) {
      const transformerDiagnostics = getDiagnostics();
      const errors = transformerDiagnostics.filter((d) =>
        d.severity === "error"
      );
      if (errors.length > 0) {
        // Build a map of file names to source contents for error rendering
        const sources = new Map<string, string>();
        for (const file of program.files) {
          sources.set(file.name, file.contents);
        }
        throw new TransformerError(errors, sources);
      }
    }

    // Only throw if emit was skipped due to real errors, not filtered false positives
    if (emitSkipped && !allDiagnosticsFiltered) {
      throw new Error("Emit skipped. Check diagnostics.");
    }

    if (sourceCollector && inputOptions.getTransformedProgram) {
      const transformed = {
        main: program.main,
        files: sourceCollector.sources(),
      };
      inputOptions.getTransformedProgram(transformed);
    }

    // Get written files, should be a JS and source map.
    const writes = host.getWrites();

    const source = writes[filename];
    const sourceMap = parseSourceMap(writes[`${filename}.map`]);
    const exportModuleExports = inputOptions.bundleExportAll
      ? sourceNames.filter((name) => !name.endsWith(".d.ts"))
      : undefined;
    const bundled = bundleAMDOutput({
      mainModule: program.main,
      source,
      sourceMap,
      filename,
      injectedScript,
      exportModuleExports,
    });
    return {
      js: bundled,
      filename,
      sourceMap,
    };
  }
}

function validateSource(artifact: Program) {
  let entryFound = false;
  for (const { name } of artifact.files) {
    if (name === artifact.main) {
      entryFound = true;
    }
    // Sources must be root paths, unless they are type files,
    // which could be included for runtime dependencies,
    // e.g. `@commontools/builder.d.ts`
    if (name[0] !== "/" && !name.endsWith(".d.ts")) {
      //throw new Error(`File "${name}" must have a "/" root.`);
    }
  }
  if (!entryFound) {
    throw new Error(`No main module "${artifact.main}" in source.`);
  }
}

function createTransformers(
  program: ts.Program,
  options: TypeScriptCompilerOptions,
): {
  beforeTransformers: ts.TransformerFactory<ts.SourceFile>[];
  sourceCollector?: SourceCollector;
  getDiagnostics?: () => readonly TransformerDiagnosticInfo[];
} {
  let factories: ts.TransformerFactory<ts.SourceFile>[] = [];
  let getDiagnostics: (() => readonly TransformerDiagnosticInfo[]) | undefined;

  if (options.beforeTransformers) {
    const result = options.beforeTransformers(program);
    if (Array.isArray(result)) {
      // Legacy: array of transformer factories
      factories = result;
    } else {
      // New: TransformerPipelineResult with factories and getDiagnostics
      factories = result.factories;
      getDiagnostics = result.getDiagnostics;
    }
  }

  const out: ReturnType<typeof createTransformers> = {
    beforeTransformers: factories,
    getDiagnostics,
  };

  if (factories.length && options.getTransformedProgram) {
    out.sourceCollector = new SourceCollector();
    out.beforeTransformers.push(out.sourceCollector.transformer());
  }

  return out;
}

class SourceCollector {
  #sources: Source[] = [];
  #printer: ts.Printer;
  constructor() {
    this.#printer = ts.createPrinter({
      newLine: ts.NewLineKind.LineFeed,
      removeComments: false,
    });
  }

  sources(): Source[] {
    return this.#sources;
  }

  transformer(): ts.TransformerFactory<ts.SourceFile> {
    return () => (sourceFile) => {
      this.#sources.push({
        contents: this.#printer.printFile(sourceFile),
        name: path.normalize(sourceFile.fileName),
      });
      return sourceFile;
    };
  }
}
