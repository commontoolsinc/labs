import ts from "typescript";

import type { DataFlowAnalysis, NormalizedDataFlowSet } from "../../ast/mod.ts";
import { TransformationContext } from "../../core/mod.ts";

export type OpaqueRefHelperName =
  | "derive"
  | "ifElse"
  | "when"
  | "unless"
  | "toSchema";
export type AnalyzeFn = (expression: ts.Expression) => DataFlowAnalysis;

export interface RewriteParams {
  readonly expression: ts.Expression;
  readonly analysis: DataFlowAnalysis;
  readonly context: TransformationContext;
  readonly analyze: AnalyzeFn;
  /**
   * True when inside a safe callback wrapper (action, handler, computed, etc.)
   * where opaque reading is allowed. In safe contexts, we still need to apply
   * semantic transformations (&&->when, ||->unless) but NOT derive() wrappers.
   */
  readonly inSafeContext?: boolean;
}

export interface EmitterContext extends RewriteParams {
  readonly dataFlows: NormalizedDataFlowSet;
  readonly inSafeContext: boolean;
  rewriteChildren(node: ts.Expression): ts.Expression;
}

export type Emitter = (params: EmitterContext) => ts.Expression | undefined;
