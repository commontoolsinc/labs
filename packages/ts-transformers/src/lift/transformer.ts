import ts from "typescript";

import { detectCallKind, getLiftAppliedInnerCall } from "../ast/call-kind.ts";
import { setParentPointers } from "../ast/utils.ts";
import {
  registerLiftAppliedCallType,
  widenLiteralType,
} from "../ast/type-inference.ts";
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
    if (text.includes("computed") || text.includes("derive")) {
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

    // Only rewrite the user-source derive shape — not our own lift-applied output.
    // detectCallKind returns kind:"lift-applied" for BOTH:
    //   (a) user-source derive(input, cb) — callee is a property access or
    //       bare identifier ("derive" or "__cfHelpers.derive"). This is the
    //       shape we want to lower.
    //   (b) our own __cfHelpers.lift(cb)(input) — callee is itself a
    //       CallExpression (the inner lift call). We do NOT want to re-lower
    //       our own output.
    // Distinguish structurally: if the callee is already a CallExpression
    // (potentially wrapped in parens / as / non-null assertions), it's
    // already lift-applied and we leave it alone. Use the shared helper so
    // the wrapper-stripping convention matches every other site that
    // detects the lift-applied shape.
    if (
      callKind?.kind === "lift-applied" &&
      !getLiftAppliedInnerCall(node)
    ) {
      return lowerDeriveCall(node, context, visitor);
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

function lowerDeriveCall(
  node: ts.CallExpression,
  context: TransformationContext,
  visitor: ts.Visitor,
): ts.Node {
  const { factory, checker, tsContext } = context;

  // Two user-source derive shapes to lower:
  //   2-arg: derive(input, cb)            → lift(cb)(input)
  //   4-arg: derive(argSchema, resultSchema, input, cb)
  //                                       → lift(argSchema, resultSchema, cb)(input)
  // Anything else is malformed; pass through.
  const args = node.arguments;
  if (args.length !== 2 && args.length !== 4) {
    return ts.visitEachChild(node, visitor, tsContext);
  }

  let inputArg: ts.Expression | undefined;
  let callbackArg: ts.Expression | undefined;
  let innerLiftArgs: ts.Expression[];

  if (args.length === 2) {
    inputArg = args[0];
    callbackArg = args[1];
    if (!inputArg || !callbackArg) {
      return ts.visitEachChild(node, visitor, tsContext);
    }
    innerLiftArgs = [callbackArg];
  } else {
    const argSchema = args[0];
    const resultSchema = args[1];
    inputArg = args[2];
    callbackArg = args[3];
    if (!argSchema || !resultSchema || !inputArg || !callbackArg) {
      return ts.visitEachChild(node, visitor, tsContext);
    }
    innerLiftArgs = [argSchema, resultSchema, callbackArg];
  }

  // Preserve the user-API derive's "input type flows into callback parameter"
  // semantics across the lowering.
  //
  // In the user-source derive(input, fn), TypeScript contextually-types fn's
  // parameter as the input's type via the shared generic In:
  //   derive<In, Out>(In, (In)=>Out).
  // In the lift-applied form lift(fn)(input), TS instantiates In from fn's
  // parameter in isolation (because lift(fn) is resolved before being applied
  // to input). For unannotated parameters this can collapse to unknown or
  // unwrap cell-like types in ways that change downstream schema inference.
  //
  // We restore the original semantics by registering the input expression's
  // widened type against the callback's first parameter in the typeRegistry.
  // inferParameterType consults the registry before falling back to the
  // checker, so downstream schema injection sees the input-flowed type.
  //
  // `widenLiteralType` matches pre-Phase-1 derive's contextual-typing of fn's
  // parameter: `derive(5, x => …)` should see `number`, not the literal `5`.
  // Without the widen, schema injection picks up the literal type and emits
  // an over-narrowed schema (CT-1615 Berni review on PR #3676).
  const typeRegistry = context.options.typeRegistry;
  if (typeRegistry) {
    const callbackFn = unwrapToFunctionLike(callbackArg);
    const callbackParam = callbackFn?.parameters[0];
    if (callbackParam && !callbackParam.type) {
      const inputType = checker.getTypeAtLocation(inputArg);
      if (inputType) {
        typeRegistry.set(callbackParam, widenLiteralType(inputType, checker));
      }
    }
  }

  const innerLiftCall = context.cfHelpers.createHelperCall(
    "lift",
    node,
    node.typeArguments,
    innerLiftArgs,
  );
  const liftAppliedCall = factory.createCallExpression(
    innerLiftCall,
    undefined,
    [inputArg],
  );

  return finalizeLoweredCall(
    node,
    liftAppliedCall,
    context,
    visitor,
  );
}

function unwrapToFunctionLike(
  expr: ts.Expression,
): ts.ArrowFunction | ts.FunctionExpression | undefined {
  if (ts.isArrowFunction(expr) || ts.isFunctionExpression(expr)) {
    return expr;
  }
  return undefined;
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

  if (context.options.typeRegistry) {
    const originalType = context.options.typeRegistry.get(originalNode);
    if (originalType) {
      registerLiftAppliedCallType(
        preservedVisitedCall,
        undefined,
        originalType,
        checker,
        context.options.typeRegistry,
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
