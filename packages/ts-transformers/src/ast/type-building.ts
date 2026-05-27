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
 * Rewrite commonfabric type references in a TypeNode tree to the canonical
 * `__cfHelpers.X` qualified form, so synthesized annotations are always
 * resolvable regardless of which symbols the user has imported.
 *
 * Detection is semantic, not name-based: each TypeReferenceNode is matched
 * against its corresponding `ts.Type` (walked in lockstep with the TypeNode
 * tree, starting from the root `rootType`). When the Type's symbol or
 * aliasSymbol has a parent that is the `"commonfabric"` module symbol, the
 * node is rewritten — the symbol's `name` becomes the leaf of the new
 * qualified name. The runner exposes `__cfHelpers` as a self-reference to
 * the commonfabric namespace (see runner/src/builder/factory.ts:228), so
 * every commonfabric export is reachable as `__cfHelpers.X`.
 *
 * Lockstep walking is necessary because synthetic TypeNodes have no source
 * position and `checker.getSymbolAtLocation` returns nothing for them;
 * `getTypeFromTypeNodeWithFallback` also widens nested synthetic refs to
 * `any` because the inner identifiers have no scope to resolve against.
 * The root Type passed in carries full symbol info; walking the Type tree
 * and TypeNode tree in parallel propagates that info to every nested ref.
 *
 * Also handles the `import("commonfabric").X<...>` `ImportTypeNode` form
 * (TS emits this when no in-scope alias exists). This case is syntactically
 * unambiguous and is rewritten without needing the paired Type.
 *
 * The original TypeNode is preserved when no rewrite is needed; only
 * subtrees that change are rebuilt via `factory.create*`.
 */
export function qualifyCommonFabricTypeRefs(
  typeNode: ts.TypeNode,
  rootType: ts.Type | undefined,
  context: {
    readonly checker: ts.TypeChecker;
    readonly factory: ts.NodeFactory;
    readonly typeRegistry?: WeakMap<ts.Node, ts.Type>;
    readonly tsContext?: ts.TransformationContext;
  },
): ts.TypeNode {
  const { factory } = context;

  // Module symbol names are stored with surrounding double quotes for
  // external modules (e.g. `"commonfabric"`). Match either form.
  const isCommonFabricModuleName = (name: string | undefined): boolean =>
    name === "commonfabric" || name === '"commonfabric"';

  const buildHelperQualifiedName = (leafName: string): ts.QualifiedName =>
    factory.createQualifiedName(
      factory.createIdentifier("__cfHelpers"),
      factory.createIdentifier(leafName),
    );

  // From a Type, find the export name in commonfabric (if any).
  //
  // Prefer `aliasSymbol` over `symbol`: when the user writes `Writable<X>`
  // and `Writable` is an alias for `Cell`, the Type's `symbol` may be the
  // underlying `Cell` constructor while `aliasSymbol` correctly points at
  // `Writable`. Preserving the user's chosen name keeps the emitted
  // annotation closer to authored intent.
  const commonFabricExportName = (
    type: ts.Type | undefined,
  ): string | undefined => {
    if (!type) return undefined;
    const candidates: (ts.Symbol | undefined)[] = [
      type.aliasSymbol,
      type.symbol,
    ];
    for (const sym of candidates) {
      if (!sym) continue;
      const parent = (sym as unknown as { parent?: ts.Symbol }).parent;
      if (isCommonFabricModuleName(parent?.name) && sym.name) {
        return sym.name;
      }
    }
    return undefined;
  };

  // For a TypeReference Type, get its Nth type argument. Different
  // TypeScript versions expose this via slightly different shapes; try the
  // public ones first.
  const getTypeArgumentAt = (
    type: ts.Type | undefined,
    index: number,
  ): ts.Type | undefined => {
    if (!type) return undefined;
    const asReference = type as ts.TypeReference;
    if (asReference.typeArguments) {
      return asReference.typeArguments[index];
    }
    // Alias-resolved generics expose aliasTypeArguments.
    const aliased = (type as unknown as {
      aliasTypeArguments?: readonly ts.Type[];
    }).aliasTypeArguments;
    if (aliased) {
      return aliased[index];
    }
    return undefined;
  };

  // For a TypeLiteral / Object Type, get the Type of a named property.
  const getPropertyType = (
    type: ts.Type | undefined,
    propertyName: string,
  ): ts.Type | undefined => {
    if (!type) return undefined;
    const property = type.getProperty(propertyName);
    if (!property) return undefined;
    const decl = property.valueDeclaration ?? property.declarations?.[0];
    if (!decl) {
      // Property has no declaration we can locate (anonymous object). Use the
      // generic getTypeOfSymbol via a SourceFile fallback if available.
      const ofSym = (context.checker as unknown as {
        getTypeOfSymbol?: (sym: ts.Symbol) => ts.Type;
      }).getTypeOfSymbol;
      return ofSym ? ofSym.call(context.checker, property) : undefined;
    }
    return context.checker.getTypeOfSymbolAtLocation(property, decl);
  };

  // For an array Type (T[] or Array<T>), get its element Type.
  const getArrayElementType = (
    type: ts.Type | undefined,
  ): ts.Type | undefined => {
    if (!type) return undefined;
    return context.checker.getIndexTypeOfType(type, ts.IndexKind.Number);
  };

  // The walker takes a TypeNode and the Type it represents, and returns a
  // (possibly-rewritten) TypeNode. The Type may be undefined when the
  // paired info isn't available — in that case nested ImportType
  // recognition still works (it's purely syntactic), but bare-identifier
  // commonfabric-ref detection is skipped (no false-positive risk).
  const walk = (
    node: ts.TypeNode,
    pairedType: ts.Type | undefined,
  ): ts.TypeNode => {
    // `import("commonfabric").X<...>` → `__cfHelpers.X<...>` (syntactic).
    if (ts.isImportTypeNode(node) && !node.isTypeOf) {
      const arg = node.argument;
      if (
        ts.isLiteralTypeNode(arg) &&
        ts.isStringLiteral(arg.literal) &&
        arg.literal.text === "commonfabric" &&
        node.qualifier
      ) {
        const leafName = ts.isIdentifier(node.qualifier)
          ? node.qualifier.text
          : node.qualifier.right.text;
        const visitedTypeArgs = node.typeArguments
          ? factory.createNodeArray(
            node.typeArguments.map((arg, i) =>
              walk(arg, getTypeArgumentAt(pairedType, i))
            ),
          )
          : undefined;
        return factory.createTypeReferenceNode(
          buildHelperQualifiedName(leafName),
          visitedTypeArgs,
        );
      }
    }

    // `X<...>` where X resolves to a commonfabric export → `__cfHelpers.X<...>`.
    if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)) {
      if (node.typeName.text !== "__cfHelpers") {
        const exportName = commonFabricExportName(pairedType);
        if (exportName) {
          const visitedTypeArgs = node.typeArguments
            ? factory.createNodeArray(
              node.typeArguments.map((arg, i) =>
                walk(arg, getTypeArgumentAt(pairedType, i))
              ),
            )
            : undefined;
          return factory.createTypeReferenceNode(
            buildHelperQualifiedName(exportName),
            visitedTypeArgs,
          );
        }
        // Not a commonfabric ref — recurse into type args with their
        // corresponding paired sub-types.
        if (node.typeArguments) {
          const rewritten = node.typeArguments.map((arg, i) =>
            walk(arg, getTypeArgumentAt(pairedType, i))
          );
          const changed = rewritten.some((arg, i) =>
            arg !== node.typeArguments![i]
          );
          if (changed) {
            return factory.updateTypeReferenceNode(
              node,
              node.typeName,
              factory.createNodeArray(rewritten),
            );
          }
        }
        return node;
      }
    }

    // TypeLiteral: walk each member, pairing with the Type's property type.
    if (ts.isTypeLiteralNode(node)) {
      const rewrittenMembers = node.members.map((member) => {
        if (
          ts.isPropertySignature(member) && member.name && member.type &&
          (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name))
        ) {
          const propertyName = member.name.text;
          const propertyType = getPropertyType(pairedType, propertyName);
          const rewrittenType = walk(member.type, propertyType);
          if (rewrittenType === member.type) return member;
          return factory.updatePropertySignature(
            member,
            member.modifiers,
            member.name,
            member.questionToken,
            rewrittenType,
          );
        }
        return member;
      });
      const changed = rewrittenMembers.some((m, i) => m !== node.members[i]);
      return changed
        ? factory.updateTypeLiteralNode(
          node,
          factory.createNodeArray(rewrittenMembers),
        )
        : node;
    }

    // ArrayTypeNode: element Type paired with the array's numeric-index Type.
    if (ts.isArrayTypeNode(node)) {
      const elementType = getArrayElementType(pairedType);
      const rewritten = walk(node.elementType, elementType);
      return rewritten === node.elementType
        ? node
        : factory.updateArrayTypeNode(node, rewritten);
    }

    // Union / Intersection: walk each member without paired Type info (the
    // paired Type IS the union/intersection, but mapping individual members
    // to constituent Types is brittle; recurse and rely on Import-form
    // detection for nested refs).
    if (ts.isUnionTypeNode(node)) {
      const rewritten = node.types.map((t) => walk(t, undefined));
      const changed = rewritten.some((t, i) => t !== node.types[i]);
      return changed
        ? factory.updateUnionTypeNode(node, factory.createNodeArray(rewritten))
        : node;
    }
    if (ts.isIntersectionTypeNode(node)) {
      const rewritten = node.types.map((t) => walk(t, undefined));
      const changed = rewritten.some((t, i) => t !== node.types[i]);
      return changed
        ? factory.updateIntersectionTypeNode(
          node,
          factory.createNodeArray(rewritten),
        )
        : node;
    }

    // ParenthesizedType, TypeOperator: unwrap and walk inner.
    if (ts.isParenthesizedTypeNode(node)) {
      const rewritten = walk(node.type, pairedType);
      return rewritten === node.type
        ? node
        : factory.updateParenthesizedType(node, rewritten);
    }
    if (ts.isTypeOperatorNode(node)) {
      const rewritten = walk(node.type, pairedType);
      return rewritten === node.type
        ? node
        : factory.updateTypeOperatorNode(node, rewritten);
    }

    return node;
  };

  return walk(typeNode, rootType);
}

/**
 * Common flags for type-to-typenode conversion.
 * NoTruncation: Prevents type strings from being truncated
 * UseStructuralFallback: Falls back to structural types when nominal types aren't available
 * UseAliasDefinedOutsideCurrentScope: Prefer existing aliases (e.g. `Cell<T>`
 *   imported at module scope) over their canonical qualified forms (e.g.
 *   `import("commonfabric").Cell<T>`). Without this flag, type-arg
 *   annotations on synthesized helper calls print the import-qualified form
 *   even when an alias is in scope (CT-1615 Berni review on PR #3676).
 */
export const DEFAULT_TYPE_NODE_FLAGS = ts.NodeBuilderFlags.NoTruncation |
  ts.NodeBuilderFlags.UseStructuralFallback |
  ts.NodeBuilderFlags.UseAliasDefinedOutsideCurrentScope;

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
  const rawNode =
    context.checker.typeToTypeNode(type, context.sourceFile, flags) ??
      context.factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);

  // Rewrite commonfabric type references to the always-resolvable
  // `__cfHelpers.X` qualified form. The printer's natural output references
  // commonfabric symbols that may not be imported in the user's source
  // (especially when `UseAliasDefinedOutsideCurrentScope` is on), so the
  // emitted annotation wouldn't typecheck. `__cfHelpers` is always injected
  // by the transformer and re-exports the entire commonfabric namespace
  // (see runner/src/builder/factory.ts:228), so the qualified form is
  // unconditionally valid.
  //
  // We pass the root `type` in so the rewriter can walk Type and TypeNode
  // trees in lockstep — synthetic inner TypeNodes carry no source position
  // and their symbols can't be recovered via `getSymbolAtLocation`, so
  // pairing each ref with its corresponding Type from the input is the
  // only reliable way to detect nested commonfabric refs.
  const node = qualifyCommonFabricTypeRefs(rawNode, type, {
    checker: context.checker,
    factory: context.factory,
    typeRegistry,
  });

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
  const declaredTypeNode = getDestructuredBindingDeclaredTypeNode(
    expr,
    context,
  );
  if (declaredTypeNode) {
    const type = context.checker.getTypeFromTypeNode(declaredTypeNode);
    const clonedTypeNode = cloneTypeNode(declaredTypeNode);
    context.options.typeRegistry?.set(clonedTypeNode, type);
    return clonedTypeNode;
  }

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

function getDestructuredBindingDeclaredTypeNode(
  expr: ts.Expression,
  context: TransformationContext,
): ts.TypeNode | undefined {
  if (!ts.isIdentifier(expr)) {
    return undefined;
  }

  const symbol = context.checker.getSymbolAtLocation(expr);
  const declaration = symbol?.valueDeclaration ??
    (symbol?.declarations?.[0] as ts.Declaration | undefined);
  if (!declaration || !ts.isBindingElement(declaration)) {
    return undefined;
  }

  const typeNode = getDeclaredTypeNodeForBindingElement(
    declaration,
    context.checker,
  );
  return typeNode && shouldPreserveBindingDeclaredTypeNode(typeNode)
    ? typeNode
    : undefined;
}

export function getDeclaredTypeNodeForBindingElement(
  declaration: ts.BindingElement,
  checker: ts.TypeChecker,
): ts.TypeNode | undefined {
  const parentPattern = declaration.parent;
  if (!ts.isObjectBindingPattern(parentPattern)) {
    return undefined;
  }

  const key = getBindingElementPropertyKey(declaration);
  if (key === undefined) {
    return undefined;
  }

  const parentType = checker.getTypeAtLocation(parentPattern);
  const prop = parentType.getProperty(key);
  const propDeclaration = prop?.valueDeclaration ??
    (prop?.declarations?.[0] as ts.Declaration | undefined);

  if (
    propDeclaration &&
    (ts.isPropertySignature(propDeclaration) ||
      ts.isPropertyDeclaration(propDeclaration)) &&
    propDeclaration.type
  ) {
    return propDeclaration.type;
  }

  return undefined;
}

function getBindingElementPropertyKey(
  declaration: ts.BindingElement,
): string | undefined {
  const propertyName = declaration.propertyName;
  if (!propertyName) {
    return ts.isIdentifier(declaration.name)
      ? declaration.name.text
      : undefined;
  }
  if (ts.isIdentifier(propertyName) || ts.isStringLiteral(propertyName)) {
    return propertyName.text;
  }
  if (ts.isNumericLiteral(propertyName)) {
    return propertyName.text;
  }
  if (ts.isComputedPropertyName(propertyName)) {
    const expression = propertyName.expression;
    if (
      ts.isStringLiteral(expression) ||
      ts.isNoSubstitutionTemplateLiteral(expression) ||
      ts.isNumericLiteral(expression)
    ) {
      return expression.text;
    }
  }
  return undefined;
}

export function shouldPreserveBindingDeclaredTypeNode(
  typeNode: ts.TypeNode,
): boolean {
  const unwrapped = unwrapParenthesizedTypeNode(typeNode);

  if (ts.isTypeReferenceNode(unwrapped)) {
    const name = ts.isIdentifier(unwrapped.typeName)
      ? unwrapped.typeName.text
      : unwrapped.typeName.right.text;
    if (name === "Writable") {
      return unwrapped.typeArguments?.some(
        shouldPreserveBindingDeclaredTypeNode,
      ) ??
        false;
    }
    return (
      name === "PerSpace" ||
      name === "PerUser" ||
      name === "PerSession" ||
      name === "PerAny" ||
      name === "Default"
    );
  }

  if (ts.isUnionTypeNode(unwrapped) || ts.isIntersectionTypeNode(unwrapped)) {
    return unwrapped.types.some(shouldPreserveBindingDeclaredTypeNode);
  }

  return false;
}

function unwrapParenthesizedTypeNode(typeNode: ts.TypeNode): ts.TypeNode {
  let current = typeNode;
  while (ts.isParenthesizedTypeNode(current)) {
    current = current.type;
  }
  return current;
}

export function cloneTypeNode<T extends ts.TypeNode>(typeNode: T): T {
  return (ts.factory as typeof ts.factory & {
    cloneNode<TNode extends ts.Node>(node: TNode): TNode;
  }).cloneNode(typeNode);
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
