import {
  Compiler,
  CompilerError,
  isJsModule,
  isSourceMap,
  JsArtifact,
  JsModule,
  TsArtifact,
} from "../interface.ts";
// Only import types from `typescript`
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
import { getTSCompiler, getTypeLibs, TypeScriptAPI } from "./utils.ts";
import * as path from "@std/path";

const TARGET_TYPE_LIB = "es2023";
const IS_MAP = /\.js\.map$/;
const IS_TYPE = /\.d\.ts$/;
const IS_JS = /\.js$/;

const VFS_TYPES_DIR = "$types/";
const VFS_DEPS_DIR = "$ext/";

// Mapping from virtual type path (e.g. `$types/es2023.d.ts`)
type TypeLibs = Record<string, string>;

class VirtualFs implements ModuleResolutionHost {
  private readonly types: Record<string, string>;
  private readonly fsRead: Record<string, string>;
  private readonly fsWrite: Record<string, string> = Object.create(null);
  constructor(
    source: TsArtifact,
    typeLib: TypeLibs,
  ) {
    this.fsRead = source.files;
    this.types = typeLib;
  }

  writeFile(fileName: any, content: any) {
    if (typeof fileName !== "string") {
      throw new Error("file name not string:" + typeof fileName);
    }
    if (typeof content !== "string") {
      throw new Error("content not string:" + typeof content);
    }
    this.fsWrite[fileName] = content;
  }

  getCurrentDirectory(): string {
    return "/";
  }

  getDirectories(_path: string): string[] {
    throw new Error("getDirectories() not implemented.");
  }

  fileExists(fileName: string): boolean {
    return !!this.innerRead(fileName);
  }

  readFile(fileName: string): string | undefined {
    return this.innerRead(fileName);
  }

  useCaseSensitiveFileNames() {
    return true;
  }

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
          const sourceMap = JSON.parse(this.fsWrite[key]);
          if (sourceMap && "version" in sourceMap) {
            // TypeScript correctly generates `version` as an integer,
            // but the `source-map-js` library's `RawSourceMap` we use
            // elsewhere expects `version` to be a string.
            sourceMap.version = `${sourceMap.version}`;
          }
          if (isSourceMap(sourceMap)) {
            modules[root].sourceMap = sourceMap;
          } else {
            throw new Error(
              "DEV: Source map type check failure: " +
                JSON.stringify(sourceMap, null, 2),
            );
          }
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
    let innerRecord;
    if (fileName.startsWith(VFS_TYPES_DIR)) {
      innerRecord = this.types;
    } else {
      innerRecord = this.fsRead;
    }
    return innerRecord[fileName];
  }
}

class TypeScriptHost extends VirtualFs implements CompilerHost {
  private ts: TypeScriptAPI;

  constructor(
    ts: TypeScriptAPI,
    source: TsArtifact,
    typeLibs: TypeLibs,
  ) {
    super(source, typeLibs);
    this.ts = ts;
  }

  getDefaultLibFileName(options: CompilerOptions): string {
    return "lib.d.ts";
  }

  getDefaultLibLocation(): string {
    return VFS_TYPES_DIR;
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
      ? this.ts.createSourceFile(fileName, sourceText, languageVersion)
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
            extension: ".ts",
          },
        };
      } else {
        return {
          resolvedModule: {
            resolvedFileName: `${VFS_DEPS_DIR}${name}.js`,
            extension: ".js",
          },
        };
      }
    });
  }
}

export class TypeScriptCompiler implements Compiler<TsArtifact> {
  private ts: TypeScriptAPI;
  private typeLibs: TypeLibs;
  private constructor(ts: TypeScriptAPI, typeLibs: TypeLibs) {
    this.ts = ts;
    this.typeLibs = typeLibs;
  }

  static async initialize(): Promise<TypeScriptCompiler> {
    const ts = await getTSCompiler();
    const es2023Types = await getTypeLibs();
    const typeLibs = {
      [`${VFS_TYPES_DIR}${TARGET_TYPE_LIB}.d.ts`]: es2023Types,
    };
    return new TypeScriptCompiler(ts, typeLibs);
  }

  compile(source: TsArtifact): JsArtifact {
    validateSource(source);
    const sourceNames = Object.keys(source.files);
    const options = this.getCompilerOptions();
    const host = new TypeScriptHost(
      this.ts,
      source,
      this.typeLibs,
    );
    const program = this.ts.createProgram(
      sourceNames,
      options,
      host,
    );

    // Filter out the default type lib of generated sources
    const sourceFiles = program.getSourceFiles().filter((source) =>
      !source.fileName.startsWith(VFS_TYPES_DIR)
    );

    assert(
      sourceFiles.length === sourceNames.length,
      `Some inputs were not converted to source files.`,
    );

    for (const sourceFile of sourceFiles) {
      // check types
      let diagnostics = program.getSemanticDiagnostics(sourceFile);
      checkDiagnostics(this.ts, diagnostics);
      // check compilation
      diagnostics = program.getDeclarationDiagnostics(sourceFile);
      checkDiagnostics(this.ts, diagnostics);
    }

    const { diagnostics } = program.emit();
    checkDiagnostics(this.ts, diagnostics);

    return {
      entry: source.entry,
      modules: host.getCompiledModules(),
    };
  }

  private getCompilerOptions(): CompilerOptions {
    return {
      declarations: true,
      module: this.ts.ModuleKind.CommonJS,
      target: this.ts.ScriptTarget.ES2023,
      // `lib` should autoapply, but we need to manage default libraries since
      // we are running outside of node. Ensure this lib matches `target`.
      lib: [TARGET_TYPE_LIB],
      strict: true,
      jsx: this.ts.JsxEmit.React,
      jsxFactory: "h",
      jsxFragmentFactory: "h.fragment",
      esModuleInterop: true,
      sourceMap: true, // Enable source map generation
      inlineSources: true, // We want the source map to include the original TypeScript files
      inlineSourceMap: false, // Generate separate source map instead of inline
      allowImportingTsExtensions: true,
    };
  }
}

function validateSource(source: TsArtifact) {
  const sourceNames = Object.keys(source.files);
  if (!sourceNames.includes(source.entry)) {
    throw new Error(`No entry module "${source.entry}" in source.`);
  }
  for (const name of sourceNames) {
    if (name[0] !== "/") {
      throw new Error(`File "${name}" must have a "/" root.`);
    }
  }
}

// Generates and throws an error if any diagnostics found in the input.
function checkDiagnostics(
  ts: TypeScriptAPI,
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
