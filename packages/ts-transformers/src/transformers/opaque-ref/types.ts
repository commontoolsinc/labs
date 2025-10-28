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
}

export interface EmitterContext extends RewriteParams {
  readonly dataFlows: NormalizedDataFlowSet;
  rewriteChildren(node: ts.Expression): ts.Expression;
}

export type Emitter = (params: EmitterContext) => ts.Expression | undefined;
