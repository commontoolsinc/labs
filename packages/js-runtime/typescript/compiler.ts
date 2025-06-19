import {
  Compiler,
  isProgram,
  JsScript,
  Program,
  ProgramResolver,
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
import { getCompilerOptions, TARGET } from "./options.ts";
import { bundleAMDOutput } from "./bundler/mod.ts";
import { parseSourceMap } from "../source-map.ts";
import { resolveProgram } from "./resolver.ts";
import { Checker } from "./diagnostics/mod.ts";

const DEBUG_VIRTUAL_FS = false;
const VFS_TYPES_DIR = "$types/";

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

function createOpaqueRefTransformer(
  program: ts.Program,
): ts.TransformerFactory<ts.SourceFile> {
  const checker = program.getTypeChecker();

  return (context) => {
    return (sourceFile) => {
      let needsIfElseImport = false;
      let hasTransformed = false;

      const visit: ts.Visitor = (node) => {
        // Check if it's a conditional expression
        if (ts.isConditionalExpression(node)) {
          const conditionType = checker.getTypeAtLocation(node.condition);

          // Check if the type is OpaqueRef<T>
          if (isOpaqueRefType(conditionType, checker)) {
            // Transform ternary to ifElse() call
            hasTransformed = true;
            if (!hasIfElseImport(sourceFile)) {
              needsIfElseImport = true;
            }
            return createIfElseCall(node, context.factory, sourceFile);
          }
        }

        return ts.visitEachChild(node, visit, context);
      };

      const visited = ts.visitNode(sourceFile, visit) as ts.SourceFile;

      // If we transformed something and need to add ifElse import
      if (hasTransformed && needsIfElseImport) {
        return addIfElseImport(visited, context.factory);
      }

      return visited;
    };
  };
}

function hasIfElseImport(sourceFile: ts.SourceFile): boolean {
  // Check if ifElse is imported from @commontools/builder or commontools
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement)) {
      const moduleSpecifier = statement.moduleSpecifier;
      if (
        ts.isStringLiteral(moduleSpecifier) &&
        (moduleSpecifier.text === "commontools")
      ) {
        // Check if ifElse is in the import clause
        if (statement.importClause && statement.importClause.namedBindings) {
          if (ts.isNamedImports(statement.importClause.namedBindings)) {
            for (
              const element of statement.importClause.namedBindings.elements
            ) {
              if (element.name.text === "ifElse") {
                return true;
              }
            }
          }
        }
      }
    }
  }
  return false;
}

function addIfElseImport(
  sourceFile: ts.SourceFile,
  factory: ts.NodeFactory,
): ts.SourceFile {
  let existingBuilderImport: ts.ImportDeclaration | undefined;
  let existingImportIndex: number = -1;
  let importSource: string = "commontools"; // default

  // Find existing @commontools/builder or commontools import
  sourceFile.statements.forEach((statement, index) => {
    if (ts.isImportDeclaration(statement)) {
      const moduleSpecifier = statement.moduleSpecifier;
      if (
        ts.isStringLiteral(moduleSpecifier) &&
        moduleSpecifier.text === "commontools"
      ) {
        existingBuilderImport = statement;
        existingImportIndex = index;
        importSource = moduleSpecifier.text; // use the same import source
      }
    }
  });

  let newImport: ts.ImportDeclaration;

  if (
    existingBuilderImport && existingBuilderImport.importClause &&
    existingBuilderImport.importClause.namedBindings &&
    ts.isNamedImports(existingBuilderImport.importClause.namedBindings)
  ) {
    // Add ifElse to existing import if not already present
    const existingElements =
      existingBuilderImport.importClause.namedBindings.elements;
    const hasIfElse = existingElements.some((element) =>
      element.name.text === "ifElse"
    );

    if (hasIfElse) {
      // ifElse is already imported, no need to modify
      return sourceFile;
    }

    const newElements = [
      ...existingElements,
      factory.createImportSpecifier(
        false,
        undefined,
        factory.createIdentifier("ifElse"),
      ),
    ];

    newImport = factory.updateImportDeclaration(
      existingBuilderImport,
      undefined,
      factory.createImportClause(
        false,
        existingBuilderImport.importClause.name,
        factory.createNamedImports(newElements),
      ),
      existingBuilderImport.moduleSpecifier,
      undefined,
    );
  } else {
    // Create new import
    newImport = factory.createImportDeclaration(
      undefined,
      factory.createImportClause(
        false,
        undefined,
        factory.createNamedImports([
          factory.createImportSpecifier(
            false,
            undefined,
            factory.createIdentifier("ifElse"),
          ),
        ]),
      ),
      factory.createStringLiteral(importSource),
      undefined,
    );
  }

  // Reconstruct statements with the new import
  const newStatements = [...sourceFile.statements];
  if (existingBuilderImport && existingImportIndex >= 0) {
    // Replace the existing import with the updated one
    newStatements[existingImportIndex] = newImport;
  } else {
    // Add new import at the beginning
    newStatements.unshift(newImport);
  }

  return factory.updateSourceFile(
    sourceFile,
    newStatements,
    sourceFile.isDeclarationFile,
    sourceFile.referencedFiles,
    sourceFile.typeReferenceDirectives,
    sourceFile.hasNoDefaultLib,
    sourceFile.libReferenceDirectives,
  );
}

function isOpaqueRefType(type: ts.Type, checker: ts.TypeChecker): boolean {
  // Handle intersection types (OpaqueRef<T> is defined as an intersection)
  if (type.flags & ts.TypeFlags.Intersection) {
    const intersectionType = type as ts.IntersectionType;
    // Check if any of the constituent types is OpaqueRef
    return intersectionType.types.some((t) => isOpaqueRefType(t, checker));
  }

  // Check if it's a type reference
  if (type.flags & ts.TypeFlags.Object) {
    const objectType = type as ts.ObjectType;

    // Check if it's a reference to a generic type
    if (objectType.objectFlags & ts.ObjectFlags.Reference) {
      const typeRef = objectType as ts.TypeReference;
      const target = typeRef.target;

      if (target && target.symbol) {
        const symbolName = target.symbol.getName();
        if (symbolName === "OpaqueRef") return true;

        // Also check the fully qualified name
        const fullyQualifiedName = checker.getFullyQualifiedName(target.symbol);
        if (fullyQualifiedName.includes("OpaqueRef")) return true;
      }
    }

    // Also check the type's symbol directly
    const symbol = type.getSymbol();
    if (symbol) {
      if (symbol.name === "OpaqueRef" || symbol.name === "OpaqueRefMethods") {
        return true;
      }

      const fullyQualifiedName = checker.getFullyQualifiedName(symbol);
      if (fullyQualifiedName.includes("OpaqueRef")) return true;
    }
  }

  // Check type alias
  if (type.aliasSymbol) {
    const aliasName = type.aliasSymbol.getName();
    if (aliasName === "OpaqueRef" || aliasName === "Opaque") return true;

    const fullyQualifiedName = checker.getFullyQualifiedName(type.aliasSymbol);
    if (fullyQualifiedName.includes("OpaqueRef")) return true;
  }

  return false;
}

function createIfElseCall(
  ternary: ts.ConditionalExpression,
  factory: ts.NodeFactory,
  sourceFile: ts.SourceFile,
): ts.CallExpression {
  // For AMD output, TypeScript transforms imports into module parameters
  // e.g., import { ifElse } from "commontools" becomes a parameter commontools_1
  // We need to use the transformed module name pattern
  const moduleAlias = getCommonToolsModuleAlias(sourceFile);

  const ifElseIdentifier = moduleAlias
    ? factory.createPropertyAccessExpression(
      factory.createIdentifier(moduleAlias),
      factory.createIdentifier("ifElse"),
    )
    : factory.createIdentifier("ifElse");

  return factory.createCallExpression(
    ifElseIdentifier,
    undefined,
    [ternary.condition, ternary.whenTrue, ternary.whenFalse],
  );
}

function getCommonToolsModuleAlias(sourceFile: ts.SourceFile): string | null {
  // In AMD output, TypeScript transforms module imports to parameters
  // For imports from "commontools", it typically becomes "commontools_1"
  // We need to check if there's an import from commontools
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement)) {
      const moduleSpecifier = statement.moduleSpecifier;
      if (
        ts.isStringLiteral(moduleSpecifier) &&
        moduleSpecifier.text === "commontools"
      ) {
        // For named imports in AMD, TypeScript generates a module parameter
        // like "commontools_1". Since we're working at the AST level before
        // AMD transformation, we need to anticipate this pattern.
        // Return the expected AMD module alias
        return "commontools_1";
      }
    }
  }
  return null;
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

  getEnvironmentVariable(name: string): string | undefined {
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

  getCanonicalFileName(fileName: any) {
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

    const checker = new Checker(tsProgram);
    if (!noCheck) {
      checker.typeCheck();
    }
    checker.declarationCheck();

    const sourceEntry = tsProgram.getSourceFiles().find((source) =>
      source.fileName === program.entry
    );
    if (!sourceEntry) {
      throw new Error("Missing source entry.");
    }

    const { diagnostics, emittedFiles, emitSkipped } = tsProgram.emit(
      sourceEntry,
      undefined,
      undefined,
      undefined,
      {
        before: [createOpaqueRefTransformer(tsProgram)],
      },
    );
    checker.check(diagnostics);

    if (emitSkipped) {
      throw new Error("Emit skipped. Check diagnostics.");
    }

    // Get written files, should be a JS and source map.
    const writes = host.getWrites();

    // TypeScript compiles AMD modules from "/main.ts" to "main".
    // Derive the entry module name here.
    const match = program.entry.match(/\/([^\.]*)/);
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
}

function validateSource(artifact: Program) {
  let entryFound = false;
  for (const { name } of artifact.files) {
    if (name === artifact.entry) {
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
    throw new Error(`No entry module "${artifact.entry}" in source.`);
  }
}

function assert(expr: boolean, message: string) {
  if (!expr) {
    throw new Error(`${message}`);
  }
}
