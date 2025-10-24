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
  #typeCache = new Map<ts.Node, ts.Type>();

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

  // Currently unused function
  getType(node: ts.Node): ts.Type {
    const cached = this.#typeCache.get(node);
    if (cached) {
      return cached;
    }
    const type = this.checker.getTypeAtLocation(node);
    this.#typeCache.set(node, type);
    return type;
  }

  reportDiagnostic(input: DiagnosticInput): void {
    const location = this.sourceFile.getLineAndCharacterOfPosition(
      input.node.getStart(),
    );
    this.diagnostics.push({
      type: input.type,
      message: input.message,
      fileName: this.sourceFile.fileName,
      line: location.line + 1,
      column: location.character + 1,
    });
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
