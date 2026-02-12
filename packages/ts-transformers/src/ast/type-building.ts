import ts from "typescript";
import type { TransformationContext } from "../core/mod.ts";
import type { CaptureTreeNode } from "../utils/capture-tree.ts";
import { createPropertyName } from "../utils/identifiers.ts";
import { inferWidenedTypeFromExpression } from "./type-inference.ts";
import {
  isOptionalProperty,
  isOptionalPropertyAccess,
  setParentPointers,
} from "./utils.ts";

/**
 * Common flags for type-to-typenode conversion.
 * NoTruncation: Prevents type strings from being truncated
 * UseStructuralFallback: Falls back to structural types when nominal types aren't available
 */
export const DEFAULT_TYPE_NODE_FLAGS = ts.NodeBuilderFlags.NoTruncation |
  ts.NodeBuilderFlags.UseStructuralFallback;

/**
 * Converts a Type to a TypeNode, optionally registering it in the type registry.
 * Provides a central place for type-to-typenode conversion with consistent flags.
 */
export function typeToTypeNodeWithRegistry(
  type: ts.Type,
  context: {
    checker: ts.TypeChecker;
    factory: ts.NodeFactory;
    sourceFile: ts.SourceFile;
  },
  typeRegistry?: WeakMap<ts.Node, ts.Type>,
  flags = DEFAULT_TYPE_NODE_FLAGS,
): ts.TypeNode {
  const node =
    context.checker.typeToTypeNode(type, context.sourceFile, flags) ??
      context.factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);

  if (typeRegistry) {
    typeRegistry.set(node, type);
  }

  return node;
}

/**
 * Converts an expression to a TypeNode by getting its type at that location.
 * Automatically widens literal types (e.g., `5` → `number`) for more flexible schemas.
 * Automatically registers in the type registry if available.
 */
export function expressionToTypeNode(
  expr: ts.Expression,
  context: TransformationContext,
): ts.TypeNode {
  // Use inferWidenedTypeFromExpression to widen literal types
  // This ensures `const x = 5` produces `number`, not `5`
  const type = inferWidenedTypeFromExpression(expr, context.checker);
  return typeToTypeNodeWithRegistry(
    type,
    context,
    context.options.typeRegistry,
  );
}

/**
 * Builds TypeScript type elements from a capture tree structure.
 * Works for both nested properties within a tree node and root-level entries.
 * Recursively builds nested type literals for hierarchical captures.
 *
 * @param entries - Iterable of [name, CaptureTreeNode] pairs
 * @param context - Transformation context for factory and type checking
 * @param parentExpr - Optional parent expression to reconstruct property access chains
 * @param parentType - Optional parent Type for checking property optionality on synthetic nodes
 * @returns Array of TypeScript property signatures
 */
export function buildTypeElementsFromCaptureTree(
  entries: Iterable<[string, CaptureTreeNode]>,
  context: TransformationContext,
  parentExpr?: ts.Expression,
  parentType?: ts.Type,
): ts.TypeElement[] {
  const { factory, checker } = context;
  const properties: ts.TypeElement[] = [];

  for (const [propName, childNode] of entries) {
    let typeNode: ts.TypeNode;
    let questionToken: ts.QuestionToken | undefined = undefined;
    let currentType: ts.Type | undefined = undefined;

    // Reconstruct property access for this property (for parent pointer consistency)
    const currentExpr = parentExpr
      ? factory.createPropertyAccessExpression(parentExpr, propName)
      : factory.createIdentifier(propName);

    // Set parent pointers if we created a synthetic node
    if (!currentExpr.getSourceFile()) {
      setParentPointers(currentExpr);
    }

    // Determine optionality and get Type for this property
    if (childNode.expression) {
      // Leaf node with source expression - use it directly
      typeNode = expressionToTypeNode(childNode.expression, context);
      currentType = checker.getTypeAtLocation(childNode.expression);

      // Check optionality from source expression
      if (ts.isPropertyAccessExpression(childNode.expression)) {
        if (isOptionalPropertyAccess(childNode.expression, checker)) {
          questionToken = factory.createToken(ts.SyntaxKind.QuestionToken);
        }
      } else if (currentType) {
        // For non-property-access expressions (e.g., local variables),
        // check if the type itself is T | undefined at the top level.
        // This handles cases like destructured optional properties where
        // the variable's own type is a union with undefined.
        //
        // Note: We intentionally do NOT unwrap OpaqueCell/Cell to check
        // inner types. Cell<T | undefined> means the cell exists but holds
        // a nullable value — the cell itself is always present and should
        // be required in the schema.
        if (isOptionalProperty(undefined, currentType)) {
          questionToken = factory.createToken(ts.SyntaxKind.QuestionToken);
        }
      }
    } else if (childNode.properties.size > 0) {
      // Intermediate node - need to get type to check optionality
      if (parentType) {
        // We have a parent type - look up this property
        const propSymbol = parentType.getProperty(propName);
        if (propSymbol) {
          // Get Type for this property to pass to children
          currentType = checker.getTypeOfSymbol(propSymbol);

          // Check optionality using centralized logic
          // This checks both `?` flag AND `T | undefined` union
          if (isOptionalProperty(propSymbol, currentType)) {
            questionToken = factory.createToken(ts.SyntaxKind.QuestionToken);
          }
        }
      } else {
        // Root level - try to get type from the identifier
        // Look for a descendant expression to get the type context
        const findDescendantExpression = (
          node: CaptureTreeNode,
        ): ts.Expression | undefined => {
          if (node.expression) return node.expression;
          for (const child of node.properties.values()) {
            const found = findDescendantExpression(child);
            if (found) return found;
          }
          return undefined;
        };

        const descendantExpr = findDescendantExpression(childNode);
        if (descendantExpr) {
          // Walk up to find the root identifier's type
          let rootExpr: ts.Expression = descendantExpr;
          while (ts.isPropertyAccessExpression(rootExpr)) {
            rootExpr = rootExpr.expression;
          }
          if (ts.isIdentifier(rootExpr)) {
            currentType = checker.getTypeAtLocation(rootExpr);
          }
        }
      }

      // Build nested type literal for objects (including array property access like .length)
      const nested = buildTypeElementsFromCaptureTree(
        childNode.properties,
        context,
        currentExpr,
        currentType,
      );
      typeNode = factory.createTypeLiteralNode(nested);
    } else {
      // Fallback to unknown
      typeNode = factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);
    }

    properties.push(
      factory.createPropertySignature(
        undefined,
        createPropertyName(propName, factory),
        questionToken,
        typeNode,
      ),
    );
  }

  return properties;
}
