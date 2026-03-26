import type { ReactiveContextInfo } from "../ast/reactive-context.ts";

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

export type ExpressionSiteCallRootKind =
  | "conditional-helper"
  | "free-function"
  | "receiver-method"
  | "optional-call"
  | "other";

export interface ExpressionSitePolicyInfo {
  readonly reactiveContext: ReactiveContextInfo;
  readonly hasAuthoredSourceSite: boolean;
  readonly withinEventHandlerJsxAttribute: boolean;
  readonly arrayMethodOwned: boolean;
  readonly helperBoundaryKind?: ExpressionSiteHelperBoundaryKind;
  readonly callRootKind?: ExpressionSiteCallRootKind;
  readonly syntheticComputeOwned: boolean;
  readonly deferredJsxArrayMethod: boolean;
  readonly controlFlowRewriteRoot: boolean;
}

export interface ExpressionSiteCallRootPolicyInfo {
  readonly reactiveContext: ReactiveContextInfo;
  readonly arrayMethodOwned: boolean;
  readonly helperBoundaryKind?: ExpressionSiteHelperBoundaryKind;
  readonly callRootKind?: ExpressionSiteCallRootKind;
}
