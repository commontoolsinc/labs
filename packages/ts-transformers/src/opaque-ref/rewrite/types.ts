import ts from "typescript";

import type { OpaqueExpressionAnalysis } from "../dependency.ts";
import type { NormalisedDependencySet } from "../normalise.ts";
import type { OpaqueRefHelperName } from "../transforms.ts";

export interface RewriteContext {
  readonly factory: ts.NodeFactory;
  readonly checker: ts.TypeChecker;
  readonly sourceFile: ts.SourceFile;
  readonly transformation: ts.TransformationContext;
  readonly analyze: (expression: ts.Expression) => OpaqueExpressionAnalysis;
}

export interface EmitterContext extends RewriteContext {
  rewriteChildren(node: ts.Expression): ts.Expression;
}

export interface RewriteParams {
  readonly expression: ts.Expression;
  readonly analysis: OpaqueExpressionAnalysis;
  readonly context: RewriteContext;
}

export interface EmitterParams {
  readonly expression: ts.Expression;
  readonly dependencies: NormalisedDependencySet;
  readonly analysis: OpaqueExpressionAnalysis;
  readonly context: EmitterContext;
}

export interface EmitterResult {
  readonly expression: ts.Expression;
  readonly helpers: ReadonlySet<OpaqueRefHelperName>;
}

export type Emitter = (params: EmitterParams) => EmitterResult | undefined;
