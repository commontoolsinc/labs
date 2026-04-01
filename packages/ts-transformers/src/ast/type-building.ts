import ts from "typescript";
import type { TransformationContext } from "../core/mod.ts";
import type { CaptureTreeNode } from "../utils/capture-tree.ts";
import { createPropertyName } from "../utils/identifiers.ts";
import {
  ensureTypeNodeRegistered,
  inferWidenedTypeFromExpression,
} from "./type-inference.ts";
import {
  isOptionalMemberSymbol,
  isOptionalSymbol,
  setParentPointers,
} from "./utils.ts";

/**
 * Common flags for type-to-typenode conversion.
 * NoTruncation: Prevents type strings from being truncated
 * UseStructuralFallback: Falls back to structural types when nominal types aren't available
 */
export const DEFAULT_TYPE_NODE_FLAGS = ts.NodeBuilderFlags.NoTruncation |
  ts.NodeBuilderFlags.UseStructuralFallback;

export interface TypeLiteralRegistrationContext {
  readonly factory: ts.NodeFactory;
  readonly checker: ts.TypeChecker;
  readonly typeRegistry?: WeakMap<ts.Node, ts.Type>;
}

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

export function createRegisteredTypeLiteral(
  members: readonly ts.TypeElement[],
  context: TypeLiteralRegistrationContext,
): ts.TypeLiteralNode {
  const typeNode = context.factory.createTypeLiteralNode([...members]);
  ensureTypeNodeRegistered(
    typeNode,
    context.checker,
    context.typeRegistry,
  );
  return typeNode;
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
  const type = inferWidenedTypeFromExpression(
    expr,
    context.checker,
    context.options.typeRegistry,
  );
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
        if (
          childNode.expression &&
          isOptionalMemberSymbol(childNode.expression, checker)
        ) {
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
          if (isOptionalSymbol(propSymbol)) {
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
      typeNode = createRegisteredTypeLiteral(
        nested,
        {
          factory,
          checker,
          typeRegistry: context.options.typeRegistry,
        },
      );
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

export function buildCaptureTypeElements(
  captureTree: Iterable<[string, CaptureTreeNode]>,
  context: TransformationContext,
  renameMap?: ReadonlyMap<string, string>,
): ts.TypeElement[] {
  const elements = buildTypeElementsFromCaptureTree(captureTree, context);
  if (!renameMap || renameMap.size === 0) {
    return elements;
  }

  return elements.map((element) => {
    if (
      !ts.isPropertySignature(element) || !ts.isIdentifier(element.name)
    ) {
      return element;
    }

    const renamedName = renameMap.get(element.name.text);
    if (!renamedName || renamedName === element.name.text) {
      return element;
    }

    return context.factory.createPropertySignature(
      element.modifiers,
      context.factory.createIdentifier(renamedName),
      element.questionToken,
      element.type,
    );
  });
}

export function createCaptureTypeLiteral(
  captureTree: Iterable<[string, CaptureTreeNode]>,
  context: TransformationContext,
  renameMap?: ReadonlyMap<string, string>,
): ts.TypeLiteralNode {
  return createRegisteredTypeLiteral(
    buildCaptureTypeElements(captureTree, context, renameMap),
    {
      factory: context.factory,
      checker: context.checker,
      typeRegistry: context.options.typeRegistry,
    },
  );
}

export function mergeCaptureTypesIntoTypeLiteral(
  typeLiteral: ts.TypeLiteralNode,
  captureTree: Iterable<[string, CaptureTreeNode]>,
  context: TransformationContext,
  renameMap?: ReadonlyMap<string, string>,
): ts.TypeLiteralNode {
  const existingMembers = [...typeLiteral.members];
  const existingNames = new Set(
    existingMembers.flatMap((member) =>
      ts.isPropertySignature(member) && member.name &&
        ts.isIdentifier(member.name)
        ? [member.name.text]
        : []
    ),
  );

  for (
    const captureMember of buildCaptureTypeElements(
      captureTree,
      context,
      renameMap,
    )
  ) {
    if (
      ts.isPropertySignature(captureMember) &&
      ts.isIdentifier(captureMember.name) &&
      existingNames.has(captureMember.name.text)
    ) {
      continue;
    }
    existingMembers.push(captureMember);
  }

  return createRegisteredTypeLiteral(
    existingMembers,
    {
      factory: context.factory,
      checker: context.checker,
      typeRegistry: context.options.typeRegistry,
    },
  );
}
