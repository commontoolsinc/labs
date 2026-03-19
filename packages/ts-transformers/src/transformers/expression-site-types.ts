import type {
  ReactiveContextInfo,
} from "../ast/reactive-context.ts";

export type ExpressionContainerKind =
  | "jsx-expression"
  | "return-expression"
  | "variable-initializer"
  | "call-argument"
  | "object-property"
  | "array-element";

export type ExpressionSiteHelperBoundaryKind =
  | "ifElse"
  | "when"
  | "unless"
  | "builder"
  | "derive"
  | "pattern-tool";

export interface ExpressionSitePolicyInfo {
  readonly containerKind: ExpressionContainerKind;
  readonly reactiveContext: ReactiveContextInfo;
  readonly hasAuthoredSourceSite: boolean;
  readonly withinEventHandlerJsxAttribute: boolean;
  readonly arrayMethodOwned: boolean;
  readonly helperBoundaryKind?: ExpressionSiteHelperBoundaryKind;
  readonly syntheticComputeOwned: boolean;
  readonly deferredJsxArrayMethod: boolean;
  readonly controlFlowRewriteRoot: boolean;
}
