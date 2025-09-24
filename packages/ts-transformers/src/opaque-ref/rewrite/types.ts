import ts from "typescript";

import type { DataFlowAnalysis } from "../dataflow.ts";
import type { NormalizedDataFlowSet } from "../normalize.ts";
import type { OpaqueRefHelperName } from "../transforms.ts";

export interface RewriteContext {
  readonly factory: ts.NodeFactory;
  readonly checker: ts.TypeChecker;
  readonly sourceFile: ts.SourceFile;
  readonly transformation: ts.TransformationContext;
  readonly analyze: (expression: ts.Expression) => DataFlowAnalysis;
}

export interface EmitterContext extends RewriteContext {
  rewriteChildren(node: ts.Expression): ts.Expression;
}

export interface RewriteParams {
  readonly expression: ts.Expression;
  readonly analysis: DataFlowAnalysis;
  readonly context: RewriteContext;
}

export interface EmitterParams {
  readonly expression: ts.Expression;
  readonly dataFlows: NormalizedDataFlowSet;
  readonly analysis: DataFlowAnalysis;
  readonly context: EmitterContext;
}

export interface EmitterResult {
  readonly expression: ts.Expression;
  readonly helpers: ReadonlySet<OpaqueRefHelperName>;
}

export type Emitter = (params: EmitterParams) => EmitterResult | undefined;
