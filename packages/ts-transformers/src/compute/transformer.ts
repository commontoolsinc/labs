import ts from "typescript";

import { detectCallKind } from "../ast/call-kind.ts";
import { Transformer } from "../core/transformers.ts";
import type { TransformationContext } from "../core/mod.ts";

/**
 * ComputeTransformer: Transforms compute() calls into derive() calls
 *
 * This transformer performs a simple syntactic rewrite:
 *   compute(() => expr) → derive({}, (_input) => expr)
 *
 * The empty object {} serves as a placeholder input, and the _input parameter
 * allows the ClosureTransformer to properly detect and transform captures.
 *
 * Pipeline:
 *   [1] ComputeTransformer: compute(() => expr) → derive({}, (_input) => expr)
 *   [2] ClosureTransformer: derive({}, (_input) => expr) → derive(schema, schema, {input: {}, ...captures}, ({input: _input, ...captures}) => expr)
 */
export class ComputeTransformer extends Transformer {
  /**
   * Filter: Only run if the file contains 'compute' somewhere.
   * This is a quick optimization to skip files without compute calls.
   */
  override filter(context: TransformationContext): boolean {
    return context.sourceFile.text.includes("compute");
  }

  override transform(context: TransformationContext): ts.SourceFile {
    const visitor = createComputeToDeriveVisitor(context);
    return ts.visitNode(context.sourceFile, visitor) as ts.SourceFile;
  }
}

/**
 * Create a visitor that transforms compute() calls to derive() calls
 */
function createComputeToDeriveVisitor(
  context: TransformationContext,
): ts.Visitor {
  const { factory, checker, tsContext } = context;

  const visitor: ts.Visitor = (node: ts.Node): ts.Node => {
    // Only process call expressions
    if (!ts.isCallExpression(node)) {
      return ts.visitEachChild(node, visitor, tsContext);
    }

    // Check if this is a compute() call from commontools
    const callKind = detectCallKind(node, checker);
    if (callKind?.kind !== "builder" || callKind.builderName !== "compute") {
      // Not a compute call, continue traversing
      return ts.visitEachChild(node, visitor, tsContext);
    }

    // Validate: compute must have exactly 1 argument (the callback)
    if (node.arguments.length !== 1) {
      // Invalid compute call - skip transformation
      return ts.visitEachChild(node, visitor, tsContext);
    }

    const callback = node.arguments[0];
    if (!callback) {
      // Safety check: callback is undefined (shouldn't happen with length check)
      return ts.visitEachChild(node, visitor, tsContext);
    }

    // Transform: compute(() => expr) → derive({}, () => expr)
    // Keep the zero-parameter callback as-is
    return factory.updateCallExpression(
      node,
      factory.createIdentifier("derive"), // Replace 'compute' with 'derive'
      node.typeArguments, // Preserve type arguments (if any)
      [
        factory.createObjectLiteralExpression([], false), // First arg: empty object {}
        callback, // Second arg: original callback (unchanged)
      ],
    );
  };

  return visitor;
}
