import ts from "typescript";
import {
  DiagnosticInput,
  TransformationDiagnostic,
  TransformationOptions,
} from "./transformers.ts";
import { CTHelpers } from "./ct-helpers.ts";

const DEFAULT_OPTIONS: TransformationOptions = {
  mode: "transform",
  debug: false,
  useLegacyOpaqueRefSemantics: false,
};

export interface TransformationContextConfig {
  program: ts.Program;
  sourceFile: ts.SourceFile;
  tsContext: ts.TransformationContext;
  options?: TransformationOptions;
}

export class TransformationContext {
  readonly program: ts.Program;
  readonly checker: ts.TypeChecker;
  readonly factory: ts.NodeFactory;
  readonly sourceFile: ts.SourceFile;
  readonly options: TransformationOptions;
  readonly ctHelpers: CTHelpers;
  readonly diagnostics: TransformationDiagnostic[] = [];
  readonly tsContext: ts.TransformationContext;

  constructor(config: TransformationContextConfig) {
    this.program = config.program;
    this.checker = config.program.getTypeChecker();
    this.tsContext = config.tsContext;
    this.factory = config.tsContext.factory;
    this.sourceFile = config.sourceFile;
    this.ctHelpers = new CTHelpers({
      factory: this.factory,
      sourceFile: this.sourceFile,
    });
    this.options = {
      ...DEFAULT_OPTIONS,
      ...config.options,
    };
  }

  reportDiagnostic(input: DiagnosticInput): void {
    const { start, length } = this.resolveDiagnosticRange(input.node);
    const location = this.sourceFile.getLineAndCharacterOfPosition(start);
    const diagnostic: TransformationDiagnostic = {
      severity: input.severity ?? "error",
      type: input.type,
      message: input.message,
      fileName: this.sourceFile.fileName,
      line: location.line + 1,
      column: location.character + 1,
      start,
      length,
    };
    this.diagnostics.push(diagnostic);

    // Also push to shared collector if provided
    if (this.options.diagnosticsCollector) {
      this.options.diagnosticsCollector.push(diagnostic);
    }
  }

  private resolveDiagnosticRange(node: ts.Node): { start: number; length: number } {
    let current: ts.Node | undefined = node;
    while (current) {
      const pos = current.pos;
      const end = current.end;
      if (pos >= 0 && end >= pos) {
        try {
          const start = current.getStart(this.sourceFile);
          return {
            start,
            length: Math.max(0, end - start),
          };
        } catch {
          // Some synthetic nodes still throw here; continue walking to a real parent.
        }
      }
      current = current.parent;
    }

    // Final fallback for fully synthetic trees with no real source positions.
    return { start: 0, length: 0 };
  }

  /**
   * Mark an arrow function as a map callback created by ClosureTransformer.
   * This allows later transformers to identify synthetic map callback scopes.
   */
  markAsMapCallback(node: ts.Node): void {
    if (this.options.mapCallbackRegistry) {
      this.options.mapCallbackRegistry.add(node);
    }
  }

  /**
   * Check if a node is a map callback created by ClosureTransformer.
   */
  isMapCallback(node: ts.Node): boolean {
    return this.options.mapCallbackRegistry?.has(node) ?? false;
  }
}
