import ts from "typescript";

import { detectCallKind } from "../ast/call-kind.ts";
import { setParentPointers } from "../ast/utils.ts";
import { Transformer } from "../core/transformers.ts";
import type { TransformationContext } from "../core/mod.ts";

/**
 * ComputeTransformer: Transforms computed() calls into derive() calls
 *
 * This transformer performs a simple syntactic rewrite:
 *   computed(() => expr) → derive({}, (_input) => expr)
 *
 * The empty object {} serves as a placeholder input, and the _input parameter
 * allows the ClosureTransformer to properly detect and transform captures.
 *
 * Pipeline:
 *   [1] ComputedTransformer: computed(() => expr) → derive({}, (_input) => expr)
 *   [2] ClosureTransformer: derive({}, (_input) => expr) → derive(schema, schema, {input: {}, ...captures}, ({input: _input, ...captures}) => expr)
 */
export class ComputedTransformer extends Transformer {
  /**
   * Filter: Only run if the file contains 'computed' somewhere.
   * This is a quick optimization to skip files without computed calls.
   */
  override filter(context: TransformationContext): boolean {
    return context.sourceFile.text.includes("computed");
  }

  override transform(context: TransformationContext): ts.SourceFile {
    const visitor = createComputedToDeriveVisitor(context);
    return ts.visitNode(context.sourceFile, visitor) as ts.SourceFile;
  }
}

/**
 * Create a visitor that transforms computed() calls to derive() calls
 */
function createComputedToDeriveVisitor(
  context: TransformationContext,
): ts.Visitor {
  const { factory, checker, tsContext } = context;

  const visitor: ts.Visitor = (node: ts.Node): ts.Node => {
    // Only process call expressions
    if (!ts.isCallExpression(node)) {
      return ts.visitEachChild(node, visitor, tsContext);
    }

    // Check if this is a computed() call from commontools
    const callKind = detectCallKind(node, checker);
    if (callKind?.kind !== "builder" || callKind.builderName !== "computed") {
      // Not a computed call, continue traversing
      return ts.visitEachChild(node, visitor, tsContext);
    }

    // Validate: computed must have exactly 1 argument (the callback)
    if (node.arguments.length !== 1) {
      // Invalid computed call - skip transformation
      return ts.visitEachChild(node, visitor, tsContext);
    }

    const callback = node.arguments[0];
    if (!callback) {
      // Safety check: callback is undefined (shouldn't happen with length check)
      return ts.visitEachChild(node, visitor, tsContext);
    }

    // Transform: computed(() => expr) → derive({}, () => expr)
    // Keep the zero-parameter callback as-is
    const deriveCall = factory.updateCallExpression(
      node,
      factory.createIdentifier("derive"), // Replace 'computed' with 'derive'
      node.typeArguments, // Preserve type arguments (if any)
      [
        factory.createObjectLiteralExpression([], false), // First arg: empty object {}
        callback, // Second arg: original callback (unchanged)
      ],
    );

    // Set parent pointers so parent-walking logic works (e.g., in shouldTransformMap)
    // Don't manually set callback.parent - let it keep its original parent from source
    // so that getSourceFile() works correctly for capture detection
    setParentPointers(deriveCall);

    return deriveCall;
  };

  return visitor;
}
