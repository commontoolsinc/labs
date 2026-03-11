import ts from "typescript";
import {
  DiagnosticInput,
  ReactiveContextOverride,
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

  private resolveDiagnosticRange(
    node: ts.Node,
  ): { start: number; length: number } {
    let current: ts.Node | undefined = node;
    while (current) {
      // Try the original node first — synthetic nodes created by transformers
      // often have originals with real source positions.
      const original: ts.Node = ts.getOriginalNode(current);
      if (original && original !== current) {
        const origPos = original.pos;
        const origEnd = original.end;
        if (origPos >= 0 && origEnd >= origPos) {
          try {
            const start = original.getStart(this.sourceFile);
            return { start, length: Math.max(0, origEnd - start) };
          } catch (_e: unknown) {
            // Original may still lack parent links; fall through.
          }
        }
      }

      const pos = current.pos;
      const end = current.end;
      if (pos >= 0 && end >= pos) {
        try {
          const start = current.getStart(this.sourceFile);
          return {
            start,
            length: Math.max(0, end - start),
          };
        } catch (_e: unknown) {
          // Some synthetic nodes still throw here; continue walking to a real parent.
        }
      }
      current = current.parent;
    }

    // Final fallback for fully synthetic trees with no real source positions.
    return { start: 0, length: 0 };
  }

  /**
   * Mark an arrow function as an array method callback created by
   * ClosureTransformer. This allows later transformers to identify synthetic
   * array method callback scopes.
   */
  markAsArrayMethodCallback(node: ts.Node): void {
    if (this.options.mapCallbackRegistry) {
      this.options.mapCallbackRegistry.add(node);
    }
  }

  /**
   * Check if a node is an array method callback created by ClosureTransformer.
   */
  isArrayMethodCallback(node: ts.Node): boolean {
    return this.options.mapCallbackRegistry?.has(node) ?? false;
  }

  markSubtreeReactiveContext(
    node: ts.Node,
    override: ReactiveContextOverride,
  ): void {
    const registry = this.options.reactiveContextOverrideRegistry;
    if (!registry) return;

    const visit = (current: ts.Node): void => {
      registry.set(current, override);
      ts.forEachChild(current, visit);
    };

    visit(node);
  }

  getReactiveContextOverride(
    node: ts.Node,
  ): ReactiveContextOverride | undefined {
    return this.options.reactiveContextOverrideRegistry?.get(node);
  }
}
