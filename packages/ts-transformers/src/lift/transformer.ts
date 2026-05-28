import ts from "typescript";

import { detectCallKind, getLiftAppliedInnerCall } from "../ast/call-kind.ts";
import { setParentPointers } from "../ast/utils.ts";
import { registerLiftAppliedCallType } from "../ast/type-inference.ts";
import { HelpersOnlyTransformer } from "../core/transformers.ts";
import type { TransformationContext } from "../core/mod.ts";

/**
 * LiftLoweringTransformer: Lowers compute-style builder calls into the
 * canonical "lift-applied" form.
 *
 * Handles:
 *   computed(() => expr)
 *     → __cfHelpers.lift(() => expr)({})
 *   derive(input, cb)
 *     → __cfHelpers.lift(cb)(input)
 *   derive(argSchema, resultSchema, input, cb)
 *     → __cfHelpers.lift(argSchema, resultSchema, cb)(input)
 *
 * Type arguments from the source call (e.g. derive<In, Out>(...)) carry to
 * the inner lift call where they belong (lift<In, Out>(...)).
 *
 * The empty-object input for computed mirrors the runtime semantics of
 * today's computed(fn) — verified that argumentSchema:false's only
 * observable effect (isValidArgument === true) is also satisfied when the
 * argument is a non-undefined object.
 *
 * The lift-applied shape is recognized by detectCallKind as
 * { kind: "lift-applied" } so downstream dispatchers operate on the
 * canonical post-CT-1615 discriminator.
 *
 * Note on shape stability: the lift-applied shape produced here
 * (`__cfHelpers.lift(cb)(input)`) propagates all the way through schema
 * injection unchanged. Schema injection prepends schemas to the inner lift
 * call when given a lift-applied node.
 */
export class LiftLoweringTransformer extends HelpersOnlyTransformer {
  override filter(context: TransformationContext): boolean {
    if (!super.filter(context)) {
      return false;
    }
    const text = context.sourceFile.text;
    if (text.includes("computed")) {
      return true;
    }
    return sourceContainsLowerableCall(context);
  }

  override transform(context: TransformationContext): ts.SourceFile {
    const visitor = createLiftLoweringVisitor(context);
    return ts.visitNode(context.sourceFile, visitor) as ts.SourceFile;
  }
}

function createLiftLoweringVisitor(
  context: TransformationContext,
): ts.Visitor {
  const { checker, tsContext } = context;

  const visitor: ts.Visitor = (node: ts.Node): ts.Node => {
    if (!ts.isCallExpression(node)) {
      return ts.visitEachChild(node, visitor, tsContext);
    }

    const callKind = detectCallKind(node, checker);

    if (callKind?.kind === "builder" && callKind.builderName === "computed") {
      return lowerComputedCall(node, context, visitor);
    }

    return ts.visitEachChild(node, visitor, tsContext);
  };

  return visitor;
}

function lowerComputedCall(
  node: ts.CallExpression,
  context: TransformationContext,
  visitor: ts.Visitor,
): ts.Node {
  const { factory, tsContext } = context;

  if (node.arguments.length !== 1) {
    return ts.visitEachChild(node, visitor, tsContext);
  }

  const callback = node.arguments[0];
  if (!callback) {
    return ts.visitEachChild(node, visitor, tsContext);
  }

  // computed(() => expr) → __cfHelpers.lift(() => expr)({}).
  // Do not forward node.typeArguments: computed<R> has one type param (the
  // result), while lift<T, R> has two with T as input. Forwarding [R] would
  // place R in lift's input slot. Type args are recomputed downstream by
  // LiftAppliedStrategy / SchemaInjection from the callback's parameter and
  // return types.
  const innerLiftCall = context.cfHelpers.createHelperCall(
    "lift",
    node,
    undefined,
    [callback],
  );
  const emptyInput = factory.createObjectLiteralExpression([], false);
  const liftAppliedCall = factory.createCallExpression(
    innerLiftCall,
    undefined,
    [emptyInput],
  );

  return finalizeLoweredCall(
    node,
    liftAppliedCall,
    context,
    visitor,
  );
}

function finalizeLoweredCall(
  originalNode: ts.CallExpression,
  liftAppliedCall: ts.CallExpression,
  context: TransformationContext,
  visitor: ts.Visitor,
): ts.Node {
  const { checker, tsContext } = context;

  const visitedCall = ts.visitEachChild(
    liftAppliedCall,
    visitor,
    tsContext,
  );
  const preservedVisitedCall = ts.setOriginalNode(
    ts.setSourceMapRange(
      ts.setTextRange(visitedCall, originalNode),
      ts.getSourceMapRange(originalNode) ?? originalNode,
    ),
    originalNode,
  );

  if (context.options.state?.typeRegistry) {
    const originalType = context.options.state?.typeRegistry.get(originalNode);
    if (originalType) {
      registerLiftAppliedCallType(
        preservedVisitedCall,
        undefined,
        originalType,
        checker,
        context.options.state?.typeRegistry,
      );
    }
  }

  setParentPointers(preservedVisitedCall, originalNode.parent);

  return preservedVisitedCall;
}

function sourceContainsLowerableCall(
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
      if (
        callKind?.kind === "lift-applied" &&
        !getLiftAppliedInnerCall(node)
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
