import ts from "typescript";
import { createImportManager } from "./imports.ts";
import type { ImportManager } from "./imports.ts";

export type TransformMode = "transform" | "error";

export interface TransformationOptions {
  readonly mode?: TransformMode;
  readonly debug?: boolean;
}

export interface TransformationFlags {
  jsxExpressionDepth: number;
  inJsxAttribute: boolean;
}

export interface TransformationDiagnostic {
  readonly type: string;
  readonly message: string;
  readonly fileName: string;
  readonly line: number;
  readonly column: number;
}

export interface DiagnosticInput {
  readonly type: string;
  readonly message: string;
  readonly node: ts.Node;
}

type FlagValue = TransformationFlags[keyof TransformationFlags];

export interface TransformationContext {
  readonly program: ts.Program;
  readonly checker: ts.TypeChecker;
  readonly factory: ts.NodeFactory;
  readonly sourceFile: ts.SourceFile;
  readonly options: Required<TransformationOptions>;
  readonly imports: ImportManager;
  readonly diagnostics: TransformationDiagnostic[];
  readonly flags: TransformationFlags;
  getType(node: ts.Node): ts.Type;
  reportDiagnostic(input: DiagnosticInput): void;
  withFlag<T>(
    flag: keyof TransformationFlags,
    value: FlagValue,
    fn: () => T,
  ): T;
}

const DEFAULT_OPTIONS: Required<TransformationOptions> = {
  mode: "transform",
  debug: false,
};

function createInitialFlags(): TransformationFlags {
  return {
    jsxExpressionDepth: 0,
    inJsxAttribute: false,
  };
}

export function createTransformationContext(
  program: ts.Program,
  sourceFile: ts.SourceFile,
  transformation: ts.TransformationContext,
  options: TransformationOptions = {},
  imports: ImportManager = createImportManager(),
): TransformationContext {
  const checker = program.getTypeChecker();
  const factory = transformation.factory;
  const mergedOptions: Required<TransformationOptions> = {
    ...DEFAULT_OPTIONS,
    ...options,
  };

  const typeCache = new Map<ts.Node, ts.Type>();
  const diagnostics: TransformationDiagnostic[] = [];
  const flags = createInitialFlags();

  const context: TransformationContext = {
    program,
    checker,
    factory,
    sourceFile,
    options: mergedOptions,
    imports,
    diagnostics,
    flags,
    getType(node: ts.Node): ts.Type {
      const cached = typeCache.get(node);
      if (cached) {
        return cached;
      }
      const type = checker.getTypeAtLocation(node);
      typeCache.set(node, type);
      return type;
    },
    reportDiagnostic(input: DiagnosticInput): void {
      const location = sourceFile.getLineAndCharacterOfPosition(
        input.node.getStart(),
      );
      diagnostics.push({
        type: input.type,
        message: input.message,
        fileName: sourceFile.fileName,
        line: location.line + 1,
        column: location.character + 1,
      });
    },
    withFlag<T>(
      flag: keyof TransformationFlags,
      value: FlagValue,
      fn: () => T,
    ): T {
      const key = flag as keyof TransformationFlags;
      const previous = flags[key] as FlagValue;
      // deno-lint-ignore no-explicit-any
      (flags as any)[key] = value;
      try {
        return fn();
      } finally {
        // deno-lint-ignore no-explicit-any
        (flags as any)[key] = previous;
      }
    },
  };

  return context;
}

export function withFlag<T>(
  context: TransformationContext,
  flag: keyof TransformationFlags,
  value: FlagValue,
  fn: () => T,
): T {
  return context.withFlag(flag, value, fn);
}
