import {
  CompilerError,
  ExecutableJs,
  isJsModule,
  isSourceMap,
  JsArtifact,
  JsModule,
  TsArtifact,
} from "../interface.ts";
import type {
  CompilerHost,
  CompilerOptions,
  Diagnostic,
  FileReference,
  ModuleResolutionHost,
  ResolvedModuleWithFailedLookupLocations,
  ResolvedProjectReference,
  ResolvedTypeReferenceDirectiveWithFailedLookupLocations,
  ScriptTarget,
  SourceFile,
  StringLiteralLike,
} from "typescript";
import * as ts from "typescript";
import * as path from "@std/path";
import { bundleAMDOutput } from "./bundle.ts";
import { parseSourceMap } from "../utils.ts";

const TARGET_TYPE_LIB = "es2023";
const IS_MAP = /\.js\.map$/;
const IS_TYPE = /\.d\.ts$/;
const IS_JS = /\.js$/;

const DEBUG_VIRTUAL_FS = false;
const VFS_TYPES_DIR = "$types/";
const VFS_DEPS_DIR = "$ext/";

// Mapping from virtual type path (e.g. `$types/es2023.d.ts`)
type TypeLibs = Record<string, string>;

class VirtualFs implements ModuleResolutionHost {
  private readonly types: Record<string, string>;
  private readonly fsRead: Record<string, string>;
  private readonly fsWrite: Record<string, string> = Object.create(null);
  private readonly debug: boolean;
  constructor(
    input: TsArtifact,
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

  writeFile(fileName: any, content: any) {
    return this.log(`writeFile - ${fileName}`, () => {
      if (typeof fileName !== "string") {
        throw new Error("file name not string:" + typeof fileName);
      }
      if (typeof content !== "string") {
        throw new Error("content not string:" + typeof content);
      }
      this.fsWrite[fileName] = content;
    });
  }

  getCurrentDirectory(): string {
    return this.log(`getCurrentDirectory`, () => "/");
  }

  getDirectories(_path: string): string[] {
    throw new Error("getDirectories() not implemented.");
  }

  fileExists(fileName: string): boolean {
    return this.log(
      `fileExists - ${fileName}`,
      () => !!this.innerRead(fileName),
    );
  }

  readFile(fileName: string): string | undefined {
    return this.log(`readFile - ${fileName}`, () => this.innerRead(fileName));
  }

  useCaseSensitiveFileNames() {
    return true;
  }

  getWrites(): Record<string, string> {
    return this.fsWrite;
  }

  // This method was used to collect all written files
  // and map each transpiled JS/source map with its original
  // source. As we bundle everything up now, this is not currently needed,
  // but keeping this here as reference until things settle here a bit.
  getCompiledModules(): Record<string, JsModule> {
    const modules = Object.create(null) as Record<
      string,
      Partial<JsModule>
    >;
    for (const key of Object.keys(this.fsWrite)) {
      if (IS_MAP.test(key)) {
        const root = key.slice(0, -4);
        modules[root] = modules[root] ?? {};
        try {
          modules[root].sourceMap = parseSourceMap(this.fsWrite[key]);
        } catch (e) {
          console.warn(`There was an error parsing "${key}" source map: ${e}`);
        }
      } else if (IS_TYPE.test(key)) {
        const root = `${key.slice(0, -5)}.js`;
        modules[root] = modules[root] ?? {};
        modules[root].typesSrc = this.fsWrite[key];
      } else if (IS_JS.test(key)) {
        const root = key;
        modules[root] = modules[root] ?? {};
        modules[root].contents = this.fsWrite[key];
        // Attempt to map to source filename here -- this could be tsx,
        // ts, or js.
        let ext;
        const keyNoExt = key.slice(0, -3);
        if (this.fsRead[`${keyNoExt}.tsx`]) {
          ext = ".tsx";
        } else if (this.fsRead[`${keyNoExt}.ts`]) {
          ext = ".ts";
        } else if (this.fsRead[`${keyNoExt}.js`]) {
          ext = ".js";
        } else {
          throw new Error("Could not find original source extension.");
        }
        modules[root].originalFilename = `${keyNoExt}${ext}`;
      } else {
        throw new Error(`Unknown generated file: ${key}`);
      }
    }

    for (const key of Object.keys(modules)) {
      if (typeof key !== "string") {
        throw new Error("Invalid module key.");
      }
      const module = modules[key];
      if (!isJsModule(module)) {
        throw new Error(
          `Incomplete compiled module "${key}": ${JSON.stringify(module)}`,
        );
      }
    }
    return modules as Record<string, JsModule>;
  }

  private innerRead(fileName: string): string | undefined {
    return this.log(`innerRead - ${fileName}`, () => {
      let innerRecord;
      if (fileName.startsWith(VFS_TYPES_DIR)) {
        innerRecord = this.types;
      } else {
        innerRecord = this.fsRead;
      }
      return innerRecord[fileName];
    });
  }

  private log<T>(name: string, callback: () => T): T {
    const result = callback();
    if (this.debug) {
      const renderable = (typeof result === "string" && result.length > 100)
        ? `${result.substring(0, 100)}...`
        : result;
      console.log(`${name}: ${renderable}`);
    }
    return result;
  }
}

class TypeScriptHost extends VirtualFs implements CompilerHost {
  constructor(
    source: TsArtifact,
    typeLibs: TypeLibs,
  ) {
    super(source, typeLibs, DEBUG_VIRTUAL_FS);
  }

  getDefaultLibFileName(options: CompilerOptions): string {
    return "lib.d.ts";
  }

  getDefaultLibLocation(): string {
    return VFS_TYPES_DIR;
  }

  getEnvironmentVariable(name: string): string | undefined {
    return undefined;
  }

  resolveTypeReferenceDirectiveReferences?<T extends FileReference | string>(
    typeDirectiveReferences: readonly T[],
    containingFile: string,
    redirectedReference: ResolvedProjectReference | undefined,
    options: CompilerOptions,
    containingSourceFile: SourceFile | undefined,
    reusedNames: readonly T[] | undefined,
  ): readonly ResolvedTypeReferenceDirectiveWithFailedLookupLocations[] {
    throw new Error("ResolveTypeReferenceDirectiveReferences");
  }

  getCanonicalFileName(fileName: any) {
    return fileName;
  }

  getNewLine() {
    return "\n";
  }

  getSourceFile(
    fileName: string,
    languageVersion: ScriptTarget,
    onError?: (message: string) => void,
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
      return {
        resolvedModule: {
          resolvedFileName: `${literal.text}.d.ts`,
          extension: ts.Extension.Dts,
          isExternalLibraryImport: true,
          packageId: undefined,
        },
      };
    });
  }
}

export interface TypeScriptCompilerOptions {
  // Filename for the output JS, used internally
  // with source maps.
  filename?: string;
  // Skip type checking.
  noCheck?: boolean;
  // Extra scripts to inject into the output bundle.
  injectedScript?: string;
}

export class TypeScriptCompiler {
  private typeLibs: TypeLibs;
  constructor(typeLibs: TypeLibs) {
    this.typeLibs = Object.keys(typeLibs).reduce((libs, libName) => {
      libs[`${VFS_TYPES_DIR}${libName}.d.ts`] = typeLibs[libName];
      return libs;
    }, {} as TypeLibs);
  }

  // Compiles `source` into `JsArtifact`.
  // Artifact files must be TypeScriptModuleSource
  compile(
    input: TsArtifact,
    inputOptions: TypeScriptCompilerOptions = {},
  ): ExecutableJs {
    const filename = inputOptions.filename ?? "out.js";
    const noCheck = inputOptions.noCheck ?? false;
    const injectedScript = inputOptions.injectedScript;

    validateSource(input);
    const sourceNames = input.files.map(({ name }) => name);
    const tsOptions = this.getCompilerOptions({ filename });
    const host = new TypeScriptHost(
      input,
      this.typeLibs,
    );
    const program = ts.createProgram(
      sourceNames,
      tsOptions,
      host,
    );

    // Filter out the default type lib of generated sources
    const sourceFiles = program.getSourceFiles().filter((source) =>
      !source.fileName.startsWith(VFS_TYPES_DIR)
    );

    //assert(
    //  sourceFiles.length === sourceNames.length,
    //  `Some inputs were not converted to source files.`,
    //);

    let sourceEntry;
    for (const sourceFile of sourceFiles) {
      if (sourceFile.fileName === input.entry) {
        assert(!sourceEntry, "Source entry not yet set.");
        sourceEntry = sourceFile;
      }

      if (!noCheck) {
        // check types
        const diagnostics = program.getSemanticDiagnostics(sourceFile);
        checkDiagnostics(diagnostics);
      }
      // check compilation
      const diagnostics = program.getDeclarationDiagnostics(sourceFile);
      checkDiagnostics(diagnostics);
    }

    if (!sourceEntry) {
      throw new Error("Missing source entry.");
    }

    const { diagnostics, emittedFiles, emitSkipped } = program.emit(
      sourceEntry,
    );
    checkDiagnostics(diagnostics);

    if (emitSkipped) {
      throw new Error("Emit skipped. Check diagnostics.");
    }

    // Get written files, should be a JS and source map.
    const writes = host.getWrites();

    // TypeScript compiles AMD modules from "/main.ts" to "main".
    // Derive the entry module name here.
    const match = input.entry.match(/\/([^\.]*)/);
    if (!match) {
      throw new Error("Could not derive entry module name");
    }
    const entryModule = match[1];
    const source = writes[filename];
    const sourceMap = parseSourceMap(writes[`${filename}.map`]);
    const bundled = bundleAMDOutput({
      entryModule,
      source,
      sourceMap,
      filename,
      injectedScript,
    });
    return {
      js: bundled,
      filename,
      sourceMap,
    };
  }

  private getCompilerOptions(
    options: TypeScriptCompilerOptions,
  ): CompilerOptions {
    return {
      declarations: true,
      module: ts.ModuleKind.AMD,
      target: ts.ScriptTarget.ES2023,
      // `lib` should autoapply, but we need to manage default libraries since
      // we are running outside of node. Ensure this lib matches `target`.
      lib: [TARGET_TYPE_LIB],
      strict: true,
      isolatedModules: false,
      jsx: ts.JsxEmit.React,
      jsxFactory: "h",
      jsxFragmentFactory: "h.fragment",
      esModuleInterop: true,
      outFile: options.filename,
      noEmitOnError: true,
      // Dynamic import/requires should not be added.
      noResolve: true,
      // Enable source map generation.
      sourceMap: true,
      // We want the source map to include the original TypeScript files
      inlineSources: true,
      // Generate separate source map instead of inline
      inlineSourceMap: false,
    };
  }
}

function validateSource(artifact: TsArtifact) {
  let entryFound = false;
  for (const { name } of artifact.files) {
    if (name === artifact.entry) {
      entryFound = true;
    }
    // Sources must be root paths, unless they are type files,
    // which could be included for runtime dependencies,
    // e.g. `@commontools/builder.d.ts`
    if (name[0] !== "/" && !name.endsWith(".d.ts")) {
      throw new Error(`File "${name}" must have a "/" root.`);
    }
  }
  if (!entryFound) {
    throw new Error(`No entry module "${artifact.entry}" in source.`);
  }
}

// Generates and throws an error if any diagnostics found in the input.
function checkDiagnostics(
  diagnostics: readonly Diagnostic[] | undefined,
) {
  if (!diagnostics || diagnostics.length === 0) {
    return;
  }
  const message = diagnostics
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
  throw new CompilerError(message);
}

function assert(expr: boolean, message: string) {
  if (!expr) {
    throw new Error(`${message}`);
  }
}
