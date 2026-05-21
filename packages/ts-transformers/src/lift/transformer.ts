import ts from "typescript";

import { detectCallKind } from "../ast/call-kind.ts";
import { setParentPointers } from "../ast/utils.ts";
import { registerDeriveCallType } from "../ast/type-inference.ts";
import { HelpersOnlyTransformer } from "../core/transformers.ts";
import type { TransformationContext } from "../core/mod.ts";

/**
 * LiftLoweringTransformer: Lowers compute-style builder calls into the
 * canonical "lift-applied" form.
 *
 * Currently handles:
 *   computed(() => expr) → __cfHelpers.lift(() => expr)({})
 *
 * Future commits will extend this transformer to also lower user-authored
 * derive(input, fn) and derive(argSchema, resultSchema, input, fn).
 *
 * The empty-object input `({})` mirrors the runtime semantics of today's
 * `computed(fn)` (verified: argumentSchema:false's only observable effect is
 * isValidArgument === true, which is also satisfied when argument is a
 * non-undefined object).
 *
 * The lift-applied shape is recognized by detectCallKind as
 * { kind: "derive" } so that existing downstream dispatchers continue to
 * work without code change. The ClosureTransformer normalizes the call back
 * to the existing __cfHelpers.derive(input, callback) shape after capture
 * extraction; the lift-applied form is a transient shape between this stage
 * and ClosureTransformer.
 */
export class LiftLoweringTransformer extends HelpersOnlyTransformer {
  override filter(context: TransformationContext): boolean {
    if (!super.filter(context)) {
      return false;
    }
    if (context.sourceFile.text.includes("computed")) {
      return true;
    }
    return sourceContainsComputedCall(context);
  }

  override transform(context: TransformationContext): ts.SourceFile {
    const visitor = createLiftLoweringVisitor(context);
    return ts.visitNode(context.sourceFile, visitor) as ts.SourceFile;
  }
}

function createLiftLoweringVisitor(
  context: TransformationContext,
): ts.Visitor {
  const { factory, checker, tsContext } = context;

  const visitor: ts.Visitor = (node: ts.Node): ts.Node => {
    if (!ts.isCallExpression(node)) {
      return ts.visitEachChild(node, visitor, tsContext);
    }

    const callKind = detectCallKind(node, checker);
    if (callKind?.kind !== "builder" || callKind.builderName !== "computed") {
      return ts.visitEachChild(node, visitor, tsContext);
    }

    if (node.arguments.length !== 1) {
      return ts.visitEachChild(node, visitor, tsContext);
    }

    const callback = node.arguments[0];
    if (!callback) {
      return ts.visitEachChild(node, visitor, tsContext);
    }

    // Lower: computed(() => expr) → __cfHelpers.lift(() => expr)({})
    //
    // The inner lift call carries the original computed call's type arguments
    // (lift<In, Out>(fn) is the generic). The outer applied call has no type
    // arguments.
    const innerLiftCall = context.cfHelpers.createHelperCall(
      "lift",
      node,
      node.typeArguments,
      [callback],
    );

    const emptyInput = factory.createObjectLiteralExpression([], false);
    const liftAppliedCall = factory.createCallExpression(
      innerLiftCall,
      undefined,
      [emptyInput],
    );

    const visitedCall = ts.visitEachChild(
      liftAppliedCall,
      visitor,
      tsContext,
    );
    const preservedVisitedCall = ts.setOriginalNode(
      ts.setSourceMapRange(
        ts.setTextRange(visitedCall, node),
        ts.getSourceMapRange(node) ?? node,
      ),
      node,
    );

    if (context.options.typeRegistry) {
      const computedType = context.options.typeRegistry.get(node);
      if (computedType) {
        registerDeriveCallType(
          preservedVisitedCall,
          undefined,
          computedType,
          checker,
          context.options.typeRegistry,
        );
      }
    }

    setParentPointers(preservedVisitedCall, node.parent);

    return preservedVisitedCall;
  };

  return visitor;
}

function sourceContainsComputedCall(
  context: TransformationContext,
): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isCallExpression(node)) {
      const callKind = detectCallKind(node, context.checker);
      if (
        callKind?.kind === "builder" &&
        callKind.builderName === "computed"
      ) {
        found = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(context.sourceFile);
  return found;
}
