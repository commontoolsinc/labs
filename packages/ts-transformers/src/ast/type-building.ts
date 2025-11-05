import ts from "typescript";
import type { TransformationContext } from "../core/mod.ts";
import type { CaptureTreeNode } from "../utils/capture-tree.ts";
import { createPropertyName } from "../utils/identifiers.ts";

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
 * Automatically registers in the type registry if available.
 */
export function expressionToTypeNode(
  expr: ts.Expression,
  context: TransformationContext,
): ts.TypeNode {
  const type = context.checker.getTypeAtLocation(expr);
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
 * @returns Array of TypeScript property signatures
 */
export function buildTypeElementsFromCaptureTree(
  entries: Iterable<[string, CaptureTreeNode]>,
  context: TransformationContext,
): ts.TypeElement[] {
  const { factory } = context;
  const properties: ts.TypeElement[] = [];

  for (const [propName, childNode] of entries) {
    let typeNode: ts.TypeNode;

    // If the node has nested properties but no expression, build a nested type literal
    if (childNode.properties.size > 0 && !childNode.expression) {
      const nested = buildTypeElementsFromCaptureTree(
        childNode.properties,
        context,
      );
      typeNode = factory.createTypeLiteralNode(nested);
    } else if (childNode.expression) {
      // If there's an expression, use its type
      typeNode = expressionToTypeNode(childNode.expression, context);
    } else {
      // Fallback to unknown
      typeNode = factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);
    }

    properties.push(
      factory.createPropertySignature(
        undefined,
        createPropertyName(propName, factory),
        undefined,
        typeNode,
      ),
    );
  }

  return properties;
}
