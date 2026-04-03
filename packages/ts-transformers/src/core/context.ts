import ts from "typescript";
import {
  createDataFlowAnalyzer,
  type DataFlowAnalysis,
} from "../ast/dataflow.ts";
import type { NormalizedDataFlow } from "../ast/normalize.ts";
import {
  type CallbackContext,
  classifyReactiveContext,
  findEnclosingCallbackContext,
  type ReactiveContextInfo,
} from "../ast/reactive-context.ts";
import { getRelevantDataFlows } from "../ast/normalize.ts";
import {
  DiagnosticInput,
  TransformationDiagnostic,
  TransformationOptions,
} from "./transformers.ts";
import { CFHelpers } from "./cf-helpers.ts";

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
  #dataFlowAnalyzer?: ReturnType<typeof createDataFlowAnalyzer>;
  #reactiveContextCache = new WeakMap<ts.Node, ReactiveContextInfo>();
  #callbackContextCache = new WeakMap<ts.Node, CallbackContext | null>();
  #relevantDataFlowCache = new WeakMap<
    DataFlowAnalysis,
    readonly NormalizedDataFlow[]
  >();
  readonly program: ts.Program;
  readonly checker: ts.TypeChecker;
  readonly factory: ts.NodeFactory;
  readonly sourceFile: ts.SourceFile;
  readonly options: TransformationOptions;
  readonly cfHelpers: CFHelpers;
  readonly diagnostics: TransformationDiagnostic[] = [];
  readonly tsContext: ts.TransformationContext;

  constructor(config: TransformationContextConfig) {
    this.program = config.program;
    this.checker = config.program.getTypeChecker();
    this.tsContext = config.tsContext;
    this.factory = config.tsContext.factory;
    this.sourceFile = config.sourceFile;
    this.cfHelpers = new CFHelpers({
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
    this.invalidateReactiveAnalysisCaches();
  }

  /**
   * Check if a node is an array method callback created by ClosureTransformer.
   */
  isArrayMethodCallback(node: ts.Node): boolean {
    if (this.options.mapCallbackRegistry?.has(node)) {
      return true;
    }
    const original = ts.getOriginalNode(node);
    return !!(
      original &&
      original !== node &&
      this.options.mapCallbackRegistry?.has(original)
    );
  }

  /**
   * Mark a synthetic callback introduced by a compute wrapper so later phases
   * can classify its contents as compute-owned even when they originate from
   * authored nodes with original parent chains in pattern context.
   */
  markAsSyntheticComputeCallback(node: ts.Node): void {
    if (this.options.syntheticComputeCallbackRegistry) {
      this.options.syntheticComputeCallbackRegistry.add(node);
    }
    this.invalidateReactiveAnalysisCaches();
  }

  /**
   * Check if a node is a synthetic compute wrapper callback.
   */
  isSyntheticComputeCallback(node: ts.Node): boolean {
    if (this.options.syntheticComputeCallbackRegistry?.has(node)) {
      return true;
    }
    const original = ts.getOriginalNode(node);
    return !!(
      original &&
      original !== node &&
      this.options.syntheticComputeCallbackRegistry?.has(original)
    );
  }

  markSyntheticComputeOwnedSubtree(node: ts.Node): void {
    const registry = this.options.syntheticComputeOwnedNodeRegistry;
    if (!registry) return;

    const visit = (current: ts.Node): void => {
      registry.add(current);
      ts.forEachChild(current, visit);
    };

    visit(node);
    this.invalidateReactiveAnalysisCaches();
  }

  isSyntheticComputeOwnedNode(node: ts.Node): boolean {
    if (this.options.syntheticComputeOwnedNodeRegistry?.has(node)) {
      return true;
    }
    const original = ts.getOriginalNode(node);
    return !!(
      original &&
      original !== node &&
      this.options.syntheticComputeOwnedNodeRegistry?.has(original)
    );
  }

  markSyntheticReactiveCollectionDeclaration(node: ts.Node): void {
    const symbol = ts.isVariableDeclaration(node)
      ? (ts.isIdentifier(node.name)
        ? this.checker.getSymbolAtLocation(node.name)
        : undefined)
      : ts.isIdentifier(node)
      ? this.checker.getSymbolAtLocation(node)
      : undefined;
    if (!symbol) {
      return;
    }
    this.options.syntheticReactiveCollectionRegistry?.add(symbol);
    this.invalidateReactiveAnalysisCaches();
  }

  getDataFlowAnalyzer(): ReturnType<typeof createDataFlowAnalyzer> {
    this.#dataFlowAnalyzer ??= createDataFlowAnalyzer(this.checker);
    return this.#dataFlowAnalyzer;
  }

  analyzeExpression(node: ts.Expression): DataFlowAnalysis {
    return this.getDataFlowAnalyzer()(node);
  }

  getRelevantDataFlows(node: ts.Expression): readonly NormalizedDataFlow[] {
    return this.getRelevantDataFlowsFromAnalysis(this.analyzeExpression(node));
  }

  getRelevantDataFlowsFromAnalysis(
    analysis: DataFlowAnalysis,
  ): readonly NormalizedDataFlow[] {
    const cached = this.#relevantDataFlowCache.get(analysis);
    if (cached) {
      return cached;
    }

    const relevant = getRelevantDataFlows(analysis, this.checker, this);
    this.#relevantDataFlowCache.set(analysis, relevant);
    return relevant;
  }

  getReactiveContext(node: ts.Node): ReactiveContextInfo {
    const cached = this.#reactiveContextCache.get(node);
    if (cached) {
      return cached;
    }

    const info = classifyReactiveContext(node, this.checker, this);
    this.#reactiveContextCache.set(node, info);
    return info;
  }

  getEnclosingCallbackContext(node: ts.Node): CallbackContext | undefined {
    if (this.#callbackContextCache.has(node)) {
      return this.#callbackContextCache.get(node) ?? undefined;
    }

    const info = findEnclosingCallbackContext(node);
    this.#callbackContextCache.set(node, info ?? null);
    return info;
  }

  private invalidateReactiveAnalysisCaches(): void {
    this.#reactiveContextCache = new WeakMap<ts.Node, ReactiveContextInfo>();
    this.#relevantDataFlowCache = new WeakMap<
      DataFlowAnalysis,
      readonly NormalizedDataFlow[]
    >();
  }
}
