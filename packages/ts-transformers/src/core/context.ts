import ts from "typescript";
import {
  DiagnosticInput,
  TransformationDiagnostic,
  TransformationOptions,
} from "./transformers.ts";
import { CTHelpers } from "./ct-helpers.ts";
import { HoistingContext } from "../hoisting/mod.ts";

const DEFAULT_OPTIONS: TransformationOptions = {
  mode: "transform",
  debug: false,
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

  /**
   * Hoisting context for SES sandboxing.
   * Tracks declarations hoisted to module scope for SES safety.
   */
  readonly hoistingContext: HoistingContext | undefined;

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

    // Initialize hoisting context for SES-safe module-scope hoisting
    this.hoistingContext = new HoistingContext(config.sourceFile);
  }

  reportDiagnostic(input: DiagnosticInput): void {
    const start = input.node.getStart();
    const length = input.node.getEnd() - start;
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
