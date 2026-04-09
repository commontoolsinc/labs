import ts from "typescript";
import { getPropertyNameText } from "@commonfabric/schema-generator/property-name";
import { createRegisteredTypeLiteral } from "../ast/type-building.ts";
import { createPropertyName } from "../utils/identifiers.ts";
import { uniquePaths } from "../utils/path-serialization.ts";
import {
  type CapabilityParamDefault,
  type CapabilityParamSummary,
  type ReactiveCapability,
  TransformationContext,
} from "../core/mod.ts";
import {
  ensureTypeNodeRegistered,
  getTypeFromTypeNodeWithFallback,
  isAnyOrUnknownType,
  isCellLikeType,
  typeToSchemaTypeNode,
  unwrapCellLikeType,
} from "../ast/mod.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CapabilitySummaryApplicationMode = "full" | "defaults_only";

interface CapabilityShrinkPlan {
  readonly retainedPaths: readonly (readonly string[])[];
  readonly fullShapePaths: readonly (readonly string[])[];
  readonly identityPaths: readonly (readonly string[])[];
  readonly identityCellPaths: readonly (readonly string[])[];
  readonly identityOnlyRoot: boolean;
  readonly effectiveIdentityPaths: readonly (readonly string[])[];
}

/**
 * Properties on array-like types that don't require item-level data.
 * When all accessed paths are in this set, array items can be shrunk
 * to `unknown` to avoid fetching full item schemas.
 *
 * Includes Cell/reactive method names that leak through capability
 * analysis when parent pointers are absent on synthetic AST nodes.
 */
const NON_ITEM_PROPS = new Set([
  "length",
  "get",
  "set",
  "key",
  "update",
]);

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

function groupPathsByHead(
  paths: readonly (readonly string[])[],
): Map<string, readonly (readonly string[])[]> {
  const grouped = new Map<string, (readonly string[])[]>();
  for (const path of paths) {
    if (path.length === 0) continue;
    const [head, ...tail] = path;
    if (!head) continue;
    const existing = grouped.get(head);
    if (existing) {
      existing.push(tail);
    } else {
      grouped.set(head, [tail]);
    }
  }
  return grouped;
}

function getTopLevelRequestedHeads(
  paths: readonly (readonly string[])[],
): Set<string> {
  const heads = new Set<string>();
  for (const path of paths) {
    const head = path[0];
    if (head) heads.add(head);
  }
  return heads;
}

function getTopLevelRepresentedHeads(
  node: ts.TypeNode,
  checker?: ts.TypeChecker,
): Set<string> {
  const current = ts.isParenthesizedTypeNode(node) ? node.type : node;
  if (!ts.isTypeLiteralNode(current)) {
    return new Set<string>();
  }

  const heads = new Set<string>();
  for (const member of current.members) {
    if (!ts.isPropertySignature(member) || !member.name) continue;
    const name = getRequestedPropertyNameText(member.name, checker);
    if (name) heads.add(name);
  }
  return heads;
}

function countRepresentedRequestedHeads(
  node: ts.TypeNode,
  requestedHeads: ReadonlySet<string>,
  checker?: ts.TypeChecker,
): number {
  const represented = getTopLevelRepresentedHeads(node, checker);
  let count = 0;
  for (const head of requestedHeads) {
    if (represented.has(head)) count++;
  }
  return count;
}

function deriveCapabilityShrinkPlan(
  paramSummary: CapabilityParamSummary,
): CapabilityShrinkPlan {
  const paths = uniquePaths([
    ...paramSummary.readPaths,
    ...paramSummary.writePaths,
  ]);
  const fullShapePaths = uniquePaths(paramSummary.fullShapePaths ?? []);
  const identityPaths = uniquePaths(paramSummary.identityPaths ?? []);
  const identityCellPaths = uniquePaths(paramSummary.identityCellPaths ?? []);
  const retainedPaths = uniquePaths([...paths, ...identityPaths]);
  const identityOnlyRoot = !!paramSummary.identityOnly &&
    !paramSummary.wildcard &&
    paths.length === 0;
  const effectiveIdentityPaths = identityOnlyRoot &&
      !identityPaths.some((path) => path.length === 0)
    ? uniquePaths([[], ...identityPaths])
    : identityPaths;

  return {
    retainedPaths,
    fullShapePaths,
    identityPaths,
    identityCellPaths,
    identityOnlyRoot,
    effectiveIdentityPaths,
  };
}

function shouldPreferNodeDrivenShrink(
  nodeDriven: ts.TypeNode,
  typeDriven: ts.TypeNode,
  baseTypeNode: ts.TypeNode,
  retainedPaths: readonly (readonly string[])[],
  checker: ts.TypeChecker,
): boolean {
  const requestedHeads = getTopLevelRequestedHeads(retainedPaths);
  const typeDrivenCoverage = countRepresentedRequestedHeads(
    typeDriven,
    requestedHeads,
    checker,
  );
  const nodeDrivenCoverage = countRepresentedRequestedHeads(
    nodeDriven,
    requestedHeads,
    checker,
  );

  return nodeDrivenCoverage > typeDrivenCoverage ||
    (
      nodeDriven !== baseTypeNode &&
      containsAnyOrUnknownTypeNode(nodeDriven) &&
      !containsAnyOrUnknownTypeNode(typeDriven)
    );
}

function shouldPreferTypeDrivenShrink(
  nodeDriven: ts.TypeNode,
  typeDriven: ts.TypeNode,
  baseTypeNode: ts.TypeNode,
  retainedPaths: readonly (readonly string[])[],
  checker: ts.TypeChecker,
  hasDirectAccess: boolean,
): boolean {
  const requestedHeads = getTopLevelRequestedHeads(retainedPaths);
  const typeDrivenCoverage = countRepresentedRequestedHeads(
    typeDriven,
    requestedHeads,
    checker,
  );
  const nodeDrivenCoverage = countRepresentedRequestedHeads(
    nodeDriven,
    requestedHeads,
    checker,
  );

  return (
    nodeDriven === baseTypeNode &&
    typeDriven !== baseTypeNode &&
    !hasDirectAccess
  ) ||
    typeDrivenCoverage > nodeDrivenCoverage ||
    (
      containsAnyOrUnknownTypeNode(nodeDriven) &&
      !containsAnyOrUnknownTypeNode(typeDriven)
    );
}

function choosePreferredShrinkCandidate(
  primaryStrategy: "type" | "node",
  nodeDriven: ts.TypeNode | undefined,
  typeDriven: ts.TypeNode | undefined,
  baseTypeNode: ts.TypeNode,
  retainedPaths: readonly (readonly string[])[],
  checker: ts.TypeChecker,
  hasDirectAccess: boolean,
): ts.TypeNode | undefined {
  if (primaryStrategy === "type") {
    if (!typeDriven) return nodeDriven;
    if (!nodeDriven) return typeDriven;
    return shouldPreferNodeDrivenShrink(
        nodeDriven,
        typeDriven,
        baseTypeNode,
        retainedPaths,
        checker,
      )
      ? nodeDriven
      : typeDriven;
  }

  if (!nodeDriven) return typeDriven;
  if (!typeDriven) return nodeDriven;
  return shouldPreferTypeDrivenShrink(
      nodeDriven,
      typeDriven,
      baseTypeNode,
      retainedPaths,
      checker,
      hasDirectAccess,
    )
    ? typeDriven
    : nodeDriven;
}

function typeIncludesUndefined(type: ts.Type): boolean {
  if ((type.flags & ts.TypeFlags.Undefined) !== 0) {
    return true;
  }
  if ((type.flags & ts.TypeFlags.Union) !== 0) {
    const union = type as ts.UnionType;
    return union.types.some((member) => typeIncludesUndefined(member));
  }
  return false;
}

function isNullishType(type: ts.Type): boolean {
  return !!(type.flags & (
    ts.TypeFlags.Undefined |
    ts.TypeFlags.Null |
    ts.TypeFlags.Void
  ));
}

function isPrimitiveScalarLikeType(type: ts.Type): boolean {
  return !!(type.flags & (
    ts.TypeFlags.StringLike |
    ts.TypeFlags.NumberLike |
    ts.TypeFlags.BooleanLike |
    ts.TypeFlags.BigIntLike |
    ts.TypeFlags.ESSymbolLike
  ));
}

function getSymbolTypeAtSource(
  symbol: ts.Symbol,
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
): ts.Type {
  const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0] ??
    sourceFile;
  return checker.getTypeOfSymbolAtLocation(symbol, declaration);
}

function isNullishTypeNode(node: ts.TypeNode): boolean {
  return node.kind === ts.SyntaxKind.UndefinedKeyword ||
    node.kind === ts.SyntaxKind.NullKeyword ||
    node.kind === ts.SyntaxKind.VoidKeyword;
}

function typeNodeIncludesUndefined(node: ts.TypeNode): boolean {
  if (node.kind === ts.SyntaxKind.UndefinedKeyword) {
    return true;
  }
  if (ts.isUnionTypeNode(node)) {
    return node.types.some((member) => typeNodeIncludesUndefined(member));
  }
  return false;
}

export function containsAnyOrUnknownTypeNode(node: ts.TypeNode): boolean {
  let found = false;
  const visit = (current: ts.Node) => {
    if (found) return;
    if (
      current.kind === ts.SyntaxKind.AnyKeyword ||
      current.kind === ts.SyntaxKind.UnknownKeyword
    ) {
      found = true;
      return;
    }
    current.forEachChild(visit);
  };
  visit(node);
  return found;
}

function isSyntheticTypeNode(node: ts.TypeNode): boolean {
  return node.pos < 0 || node.end < 0;
}

function getRequestedPropertyNameText(
  name: ts.PropertyName,
  checker?: ts.TypeChecker,
): string | undefined {
  return getPropertyNameText(name, checker);
}

function isArrayShapeType(type: ts.Type, checker: ts.TypeChecker): boolean {
  const typeChecker = checker as ts.TypeChecker & {
    isArrayType?: (type: ts.Type) => boolean;
    isTupleType?: (type: ts.Type) => boolean;
  };
  const symbolName = type.getSymbol()?.getName();
  return !!(
    typeChecker.isArrayType?.(type) ||
    typeChecker.isTupleType?.(type) ||
    symbolName === "Array" ||
    symbolName === "ReadonlyArray"
  );
}

function isHomogeneousArrayType(
  type: ts.Type,
  checker: ts.TypeChecker,
): boolean {
  const typeChecker = checker as ts.TypeChecker & {
    isArrayType?: (type: ts.Type) => boolean;
    isTupleType?: (type: ts.Type) => boolean;
  };
  if (typeChecker.isTupleType?.(type)) {
    return false;
  }
  if (typeChecker.isArrayType?.(type)) {
    return true;
  }
  const symbolName = type.getSymbol()?.getName();
  return symbolName === "Array" || symbolName === "ReadonlyArray";
}

function isNumericIndexableType(
  type: ts.Type,
  checker: ts.TypeChecker,
): boolean {
  return isArrayShapeType(type, checker) ||
    !!checker.getIndexTypeOfType(type, ts.IndexKind.Number);
}

function isNumericPathSegment(segment: string): boolean {
  return /^\d+$/.test(segment);
}

function isArrayRootOnlyPath(
  path: readonly string[],
): boolean {
  if (path.length !== 1) {
    return false;
  }

  const [head] = path;
  return !!head && NON_ITEM_PROPS.has(head);
}

function getArrayItemPaths(
  paths: readonly (readonly string[])[],
): readonly (readonly string[])[] {
  const itemPaths: (readonly string[])[] = [];
  for (const path of paths) {
    if (path.length === 0) continue;
    const [head, ...tail] = path;
    if (!head) continue;
    if (isArrayRootOnlyPath(path)) {
      continue;
    }
    itemPaths.push(isNumericPathSegment(head) ? tail : path);
  }
  return uniquePaths(itemPaths);
}

function getArrayElementType(
  type: ts.Type,
  checker: ts.TypeChecker,
): ts.Type | undefined {
  const numericIndex = checker.getIndexTypeOfType(type, ts.IndexKind.Number);
  if (numericIndex) {
    return numericIndex;
  }

  if ((type.flags & ts.TypeFlags.Object) !== 0) {
    const objectType = type as ts.ObjectType;
    if ((objectType.objectFlags & ts.ObjectFlags.Reference) !== 0) {
      const ref = objectType as ts.TypeReference;
      const typeArgs = checker.getTypeArguments(ref);
      if (typeArgs[0]) {
        return typeArgs[0];
      }
    }
  }

  return undefined;
}

function getSymbolPropertyHead(
  symbol: ts.Symbol,
  checker?: ts.TypeChecker,
): string | undefined {
  for (const declaration of symbol.declarations ?? []) {
    if (
      (ts.isPropertySignature(declaration) ||
        ts.isPropertyDeclaration(declaration)) &&
      declaration.name
    ) {
      const head = getRequestedPropertyNameText(declaration.name, checker);
      if (head) return head;
    }
  }
  return undefined;
}

function findPropertySymbol(
  type: ts.Type,
  head: string,
  checker: ts.TypeChecker,
): ts.Symbol | undefined {
  const direct = type.getProperty(head);
  if (direct) return direct;

  for (const prop of checker.getPropertiesOfType(type)) {
    if (getSymbolPropertyHead(prop, checker) === head) {
      return prop;
    }
  }

  if (type.isUnion()) {
    for (const member of type.types) {
      const prop = findPropertySymbol(member, head, checker);
      if (prop) return prop;
    }
  }

  return undefined;
}

export function isCellLikeTypeNode(node: ts.TypeNode): boolean {
  if (!ts.isTypeReferenceNode(node)) return false;
  const name = ts.isIdentifier(node.typeName)
    ? node.typeName.text
    : ts.isQualifiedName(node.typeName)
    ? node.typeName.right.text
    : undefined;
  if (!name) return false;
  return name === "Cell" ||
    name === "Writable" ||
    name === "OpaqueCell" ||
    name === "OpaqueRef" ||
    name === "ReadonlyCell" ||
    name === "WriteonlyCell" ||
    name === "Stream";
}

export function printTypeNode(
  node: ts.TypeNode,
  sourceFile: ts.SourceFile,
): string {
  const printer = ts.createPrinter({ removeComments: true });
  return printer.printNode(ts.EmitHint.Unspecified, node, sourceFile);
}

// ---------------------------------------------------------------------------
// Core type-shrinking
// ---------------------------------------------------------------------------

function buildShrunkTypeNodeFromType(
  type: ts.Type,
  paths: readonly (readonly string[])[],
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
  factory: ts.NodeFactory,
  typeRegistry?: WeakMap<ts.Node, ts.Type>,
  fullShapePaths: readonly (readonly string[])[] = [],
): ts.TypeNode | undefined {
  const typeToNodeFlags = ts.NodeBuilderFlags.NoTruncation |
    ts.NodeBuilderFlags.UseStructuralFallback;
  const normalized = uniquePaths(paths);
  const normalizedFullShapePaths = uniquePaths(fullShapePaths);
  if (normalized.length === 0) {
    return undefined;
  }
  if (normalizedFullShapePaths.some((path) => path.length === 0)) {
    const node = checker.typeToTypeNode(type, sourceFile, typeToNodeFlags) ??
      factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);
    typeRegistry?.set(node, type);
    return node;
  }

  // Keep array-like roots as arrays. Narrowing `T[]` to `{ length: number }`
  // breaks runtime schema matching for downstream derives/lifts.
  // However, when only array-intrinsic properties like `length` are accessed
  // (no item-level access), shrink the item type to `unknown` to avoid
  // fetching full item schemas unnecessarily.
  if (isArrayShapeType(type, checker)) {
    const itemPaths = getArrayItemPaths(normalized);
    const fullShapeItemPaths = getArrayItemPaths(normalizedFullShapePaths);
    const allNonItem = normalized.every((path) => isArrayRootOnlyPath(path));
    if (allNonItem && isHomogeneousArrayType(type, checker)) {
      // No item access — emit unknown[] to avoid fetching item schemas.
      return factory.createArrayTypeNode(
        factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
      );
    }
    if (itemPaths.length > 0 && isHomogeneousArrayType(type, checker)) {
      const elementType = getArrayElementType(type, checker);
      if (elementType) {
        const elementNode = buildShrunkTypeNodeFromType(
          elementType,
          itemPaths,
          checker,
          sourceFile,
          factory,
          typeRegistry,
          fullShapeItemPaths,
        ) ??
          checker.typeToTypeNode(elementType, sourceFile, typeToNodeFlags) ??
          factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);
        const arrayNode = factory.createArrayTypeNode(elementNode);
        ensureTypeNodeRegistered(arrayNode, checker, typeRegistry);
        return arrayNode;
      }
    }
    const node = checker.typeToTypeNode(type, sourceFile, typeToNodeFlags) ??
      factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);
    typeRegistry?.set(node, type);
    return node;
  }

  if (normalized.some((path) => path.length === 0)) {
    const node = checker.typeToTypeNode(type, sourceFile, typeToNodeFlags) ??
      factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);
    typeRegistry?.set(node, type);
    return node;
  }

  // Strip nullish constituents from union types (e.g. `T | undefined`) so the
  // shrinking logic can resolve properties on the non-nullish part. This runs
  // after the direct-access check above so leaf types like `string | undefined`
  // are returned as-is when they have an empty-path access.
  // After shrinking, re-wrap with the nullish members to preserve the union
  // semantics (e.g. `foo?.bar` means `undefined` is still a valid value for foo).
  if ((type.flags & ts.TypeFlags.Union) !== 0) {
    const nonNullable = checker.getNonNullableType(type);
    if (nonNullable !== type) {
      const shrunkInner = buildShrunkTypeNodeFromType(
        nonNullable,
        paths,
        checker,
        sourceFile,
        factory,
        typeRegistry,
        normalizedFullShapePaths,
      );
      if (!shrunkInner) return undefined;
      // Collect the nullish members to re-append
      const nullishMembers: ts.TypeNode[] = [];
      if (type.isUnion()) {
        for (const constituent of type.types) {
          if (
            constituent.flags &
            (ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.Void)
          ) {
            const node = checker.typeToTypeNode(
              constituent,
              sourceFile,
              typeToNodeFlags,
            );
            if (node) {
              typeRegistry?.set(node, constituent);
              nullishMembers.push(node);
            }
          }
        }
      }
      if (nullishMembers.length === 0) return shrunkInner;
      const unionNode = factory.createUnionTypeNode([
        shrunkInner,
        ...nullishMembers,
      ]);
      ensureTypeNodeRegistered(unionNode, checker, typeRegistry);
      return unionNode;
    }
  }

  const grouped = groupPathsByHead(normalized);
  const fullShapeGrouped = groupPathsByHead(normalizedFullShapePaths);
  const properties: ts.TypeElement[] = [];

  for (const [head, childPaths] of grouped) {
    let propType: ts.Type | undefined;
    let isOptional = false;

    const prop = findPropertySymbol(type, head, checker);
    if (prop) {
      const declaration = prop.valueDeclaration ?? prop.declarations?.[0] ??
        sourceFile;
      propType = checker.getTypeOfSymbolAtLocation(prop, declaration);
      isOptional = !!(prop.flags & ts.SymbolFlags.Optional) ||
        (propType ? typeIncludesUndefined(propType) : false);
    } else {
      // Numeric/unknown-key accesses can be represented via index signatures
      // rather than named properties. Use the index type when available.
      const numericIndex = Number.isFinite(Number(head));
      const indexType = checker.getIndexTypeOfType(
        type,
        numericIndex ? ts.IndexKind.Number : ts.IndexKind.String,
      ) ?? checker.getIndexTypeOfType(type, ts.IndexKind.String);
      if (!indexType) continue;
      propType = indexType;
      isOptional = typeIncludesUndefined(indexType);
    }

    const hasDirectAccess = childPaths.some((path) => path.length === 0);
    const fullShapeChildPaths = fullShapeGrouped.get(head) ?? [];

    if (!propType) {
      continue;
    }

    // Nested primitive leaves still need their original runtime shape. For
    // object properties like `input.text.length`, shrinking `text` to
    // `{ length: number }` changes a string leaf into an object and breaks the
    // authored callback contract. Keep the primitive property type intact here;
    // root-level primitive projections (e.g. `summary.length`) are still
    // handled by the recursive shrink above.
    if (!hasDirectAccess && isPrimitiveScalarLikeType(propType)) {
      const propTypeNode = checker.typeToTypeNode(
        propType,
        sourceFile,
        typeToNodeFlags,
      ) ?? factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);
      typeRegistry?.set(propTypeNode, propType);
      properties.push(
        factory.createPropertySignature(
          undefined,
          createPropertyName(head, factory),
          isOptional
            ? factory.createToken(ts.SyntaxKind.QuestionToken)
            : undefined,
          propTypeNode,
        ),
      );
      continue;
    }

    if (!hasDirectAccess && isAnyOrUnknownType(propType)) {
      // Preserve node-based precision for unresolved nested members.
      continue;
    }

    const shrunkChild = buildShrunkTypeNodeFromType(
      propType,
      childPaths,
      checker,
      sourceFile,
      factory,
      typeRegistry,
      fullShapeChildPaths,
    );
    if (!shrunkChild && !hasDirectAccess) {
      // We failed to materialize a deeper path; let caller fall back to
      // node-based shrinking instead of widening to the full property shape.
      continue;
    }

    const propTypeNode = shrunkChild ??
      checker.typeToTypeNode(propType, sourceFile, typeToNodeFlags) ??
      factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);
    if (!shrunkChild) {
      typeRegistry?.set(propTypeNode, propType);
    }

    properties.push(
      factory.createPropertySignature(
        undefined,
        createPropertyName(head, factory),
        isOptional
          ? factory.createToken(ts.SyntaxKind.QuestionToken)
          : undefined,
        propTypeNode,
      ),
    );
  }

  if (properties.length === 0) {
    return undefined;
  }

  return createRegisteredTypeLiteral(
    properties,
    { factory, checker, typeRegistry },
  );
}

function buildShrunkTypeNodeFromTypeNode(
  node: ts.TypeNode,
  paths: readonly (readonly string[])[],
  factory: ts.NodeFactory,
  checker?: ts.TypeChecker,
  typeRegistry?: WeakMap<ts.Node, ts.Type>,
  fullShapePaths: readonly (readonly string[])[] = [],
): ts.TypeNode | undefined {
  const normalized = uniquePaths(paths);
  const normalizedFullShapePaths = uniquePaths(fullShapePaths);
  if (normalized.length === 0) {
    return undefined;
  }
  if (normalizedFullShapePaths.some((path) => path.length === 0)) {
    return node;
  }
  const hasDirectAccess = normalized.some((path) => path.length === 0);

  if (hasDirectAccess) {
    // For Cell-like types, an empty path typically comes from `.get()` being
    // tracked as a full read.  If there are also longer paths (e.g. from
    // `.get().length`), try shrinking the inner type using those paths.
    if (
      ts.isTypeReferenceNode(node) &&
      isCellLikeTypeNode(node) &&
      node.typeArguments &&
      node.typeArguments.length > 0
    ) {
      const nonEmptyPaths = normalized.filter((path) => path.length > 0);
      if (nonEmptyPaths.length > 0) {
        const [inner, ...rest] = node.typeArguments;
        if (inner) {
          const shrunkInner = buildShrunkTypeNodeFromTypeNode(
            inner,
            nonEmptyPaths,
            factory,
            checker,
            typeRegistry,
            normalizedFullShapePaths,
          );
          if (shrunkInner && shrunkInner !== inner) {
            return factory.updateTypeReferenceNode(
              node,
              node.typeName,
              factory.createNodeArray([shrunkInner, ...rest]),
            );
          }
        }
      }
    }
    if (!normalized.some((path) => path.length > 0)) {
      return node;
    }
  }

  // Shrink array types: when only array-intrinsic properties (e.g. `length`)
  // are accessed, replace the item type with `unknown` to avoid fetching full
  // item schemas.  The result stays array-shaped for runtime schema matching.
  // Handles `Item[]` (ArrayTypeNode), `Array<Item>` (TypeReferenceNode), and
  // type aliases that resolve to arrays (via the type checker).
  {
    let isArray = ts.isArrayTypeNode(node) ||
      // readonly T[]  →  TypeOperator(readonly, ArrayTypeNode)
      (ts.isTypeOperatorNode(node) &&
        node.operator === ts.SyntaxKind.ReadonlyKeyword &&
        ts.isArrayTypeNode(node.type)) ||
      (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName) &&
        (node.typeName.text === "Array" ||
          node.typeName.text === "ReadonlyArray"));
    // Fall back to the checker for type aliases that resolve to arrays
    // (but not tuples or numeric-indexed objects, which have different
    // schema semantics).
    if (!isArray && checker && ts.isTypeReferenceNode(node)) {
      const resolvedType = getTypeFromTypeNodeWithFallback(
        node,
        checker,
        typeRegistry,
      );
      const tc = checker as ts.TypeChecker & {
        isArrayType?: (t: ts.Type) => boolean;
      };
      isArray = !!tc.isArrayType?.(resolvedType);
    }
    if (isArray) {
      const itemPaths = getArrayItemPaths(normalized);
      const fullShapeItemPaths = getArrayItemPaths(normalizedFullShapePaths);
      const allNonItem = normalized.every((path) => isArrayRootOnlyPath(path));
      if (allNonItem) {
        const arrayNode = factory.createArrayTypeNode(
          factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
        );
        if (checker) {
          ensureTypeNodeRegistered(arrayNode, checker, typeRegistry);
        }
        return arrayNode;
      }
      if (itemPaths.length > 0) {
        if (ts.isArrayTypeNode(node)) {
          const shrunkElement = buildShrunkTypeNodeFromTypeNode(
            node.elementType,
            itemPaths,
            factory,
            checker,
            typeRegistry,
            fullShapeItemPaths,
          ) ?? node.elementType;
          return factory.updateArrayTypeNode(node, shrunkElement);
        }

        if (
          ts.isTypeOperatorNode(node) &&
          node.operator === ts.SyntaxKind.ReadonlyKeyword &&
          ts.isArrayTypeNode(node.type)
        ) {
          const shrunkElement = buildShrunkTypeNodeFromTypeNode(
            node.type.elementType,
            itemPaths,
            factory,
            checker,
            typeRegistry,
            fullShapeItemPaths,
          ) ?? node.type.elementType;
          return factory.updateTypeOperatorNode(
            node,
            factory.updateArrayTypeNode(node.type, shrunkElement),
          );
        }

        if (
          ts.isTypeReferenceNode(node) &&
          ts.isIdentifier(node.typeName) &&
          node.typeArguments?.[0] &&
          (node.typeName.text === "Array" ||
            node.typeName.text === "ReadonlyArray")
        ) {
          const [inner] = node.typeArguments;
          const shrunkInner = buildShrunkTypeNodeFromTypeNode(
            inner,
            itemPaths,
            factory,
            checker,
            typeRegistry,
            fullShapeItemPaths,
          ) ?? inner;
          return factory.updateTypeReferenceNode(
            node,
            node.typeName,
            factory.createNodeArray([shrunkInner]),
          );
        }

        if (checker && ts.isTypeReferenceNode(node)) {
          const resolvedType = getTypeFromTypeNodeWithFallback(
            node,
            checker,
            typeRegistry,
          );
          if (isArrayShapeType(resolvedType, checker)) {
            return buildShrunkTypeNodeFromType(
              resolvedType,
              normalized,
              checker,
              node.getSourceFile(),
              factory,
              typeRegistry,
              normalizedFullShapePaths,
            );
          }
        }
      }
      // Item access or other paths we could not materialize — keep full array type.
      return node;
    }
  }

  // Shrink object type literals by filtering to only the accessed members.
  if (ts.isTypeLiteralNode(node)) {
    return shrinkTypeLiteralMembers(
      node.members,
      normalized,
      factory,
      checker,
      typeRegistry,
      normalizedFullShapePaths,
    );
  }

  if (
    ts.isTypeReferenceNode(node) &&
    isCellLikeTypeNode(node) &&
    node.typeArguments &&
    node.typeArguments.length > 0
  ) {
    const [inner, ...rest] = node.typeArguments;
    if (!inner) return undefined;
    const shrunkInner = buildShrunkTypeNodeFromTypeNode(
      inner,
      normalized,
      factory,
      checker,
      typeRegistry,
      normalizedFullShapePaths,
    ) ?? inner;
    return factory.updateTypeReferenceNode(
      node,
      node.typeName,
      factory.createNodeArray([shrunkInner, ...rest]),
    );
  }

  // For non-Cell-like TypeReferences (type aliases, interfaces), resolve the
  // declaration and shrink its members directly.  This preserves source-level
  // TypeNodes (e.g. Date, string-literal unions) that would be lost by the
  // type-driven fallback.
  if (ts.isTypeReferenceNode(node) && checker) {
    const members = resolveTypeReferenceMembers(node, checker, typeRegistry);
    if (members) {
      const shrunk = shrinkTypeLiteralMembers(
        members,
        normalized,
        factory,
        checker,
        typeRegistry,
        normalizedFullShapePaths,
      );
      if (!shrunk) return undefined;
      // If the shrunk type is identical to the original declaration (same
      // member count and no nested changes), keep the original TypeReference
      // to preserve $ref/$defs in schema generation.
      if (isUnchangedShrink(members, shrunk)) {
        return node;
      }
      return shrunk;
    }
    // Could not resolve to concrete members — let the caller fall back.
    return undefined;
  }

  if (ts.isUnionTypeNode(node)) {
    const nullish: ts.TypeNode[] = [];
    const nonNullish: ts.TypeNode[] = [];
    for (const member of node.types) {
      (isNullishTypeNode(member) ? nullish : nonNullish).push(member);
    }
    if (nonNullish.length === 0) return node;

    let changed = false;
    const shrunkMembers = nonNullish.map((member) => {
      const s = buildShrunkTypeNodeFromTypeNode(
        member,
        normalized,
        factory,
        checker,
        typeRegistry,
        normalizedFullShapePaths,
      );
      if (s && s !== member) {
        changed = true;
        return s;
      }
      return member;
    });
    if (!changed) return node;

    const all = [...shrunkMembers, ...nullish];
    if (all.length === 1) {
      return all[0];
    }
    const unionNode = factory.createUnionTypeNode(all);
    if (checker) {
      ensureTypeNodeRegistered(unionNode, checker, typeRegistry);
    }
    return unionNode;
  }

  return node;
}

/**
 * Resolves a TypeReference to its declaration members (PropertySignatures).
 * Works for type aliases with TypeLiteral bodies and interface declarations.
 */
function resolveTypeReferenceMembers(
  node: ts.TypeReferenceNode,
  checker: ts.TypeChecker,
  typeRegistry?: WeakMap<ts.Node, ts.Type>,
): readonly ts.TypeElement[] | undefined {
  const type = getTypeFromTypeNodeWithFallback(node, checker, typeRegistry);
  return resolveDeclaredObjectMembers(type, checker, typeRegistry);
}

function resolveDeclaredObjectMembers(
  type: ts.Type,
  checker: ts.TypeChecker,
  typeRegistry?: WeakMap<ts.Node, ts.Type>,
): readonly ts.TypeElement[] | undefined {
  return resolveDeclaredObjectMembersWithSeen(
    type,
    checker,
    typeRegistry,
    new Set<ts.Declaration>(),
  );
}

function resolveDeclaredObjectMembersWithSeen(
  type: ts.Type,
  checker: ts.TypeChecker,
  typeRegistry: WeakMap<ts.Node, ts.Type> | undefined,
  seen: Set<ts.Declaration>,
): readonly ts.TypeElement[] | undefined {
  const symbol = type.aliasSymbol ?? type.symbol;
  if (!symbol?.declarations?.length) return undefined;

  const resolvedMembers: ts.TypeElement[][] = [];
  for (const decl of symbol.declarations) {
    const members = resolveMembersFromDeclaration(
      decl,
      checker,
      typeRegistry,
      seen,
    );
    if (members && members.length > 0) {
      resolvedMembers.push([...members]);
    }
  }

  if (resolvedMembers.length === 0) {
    return undefined;
  }

  return mergeResolvedMembers(resolvedMembers, checker);
}

function resolveMembersFromDeclaration(
  decl: ts.Declaration,
  checker: ts.TypeChecker,
  typeRegistry: WeakMap<ts.Node, ts.Type> | undefined,
  seen: Set<ts.Declaration>,
): readonly ts.TypeElement[] | undefined {
  if (seen.has(decl)) {
    return undefined;
  }
  seen.add(decl);

  if (ts.isTypeAliasDeclaration(decl) && ts.isTypeLiteralNode(decl.type)) {
    return decl.type.members;
  }

  if (!ts.isInterfaceDeclaration(decl)) {
    return undefined;
  }

  const inheritedMembers: ts.TypeElement[][] = [];
  for (const clause of decl.heritageClauses ?? []) {
    if (clause.token !== ts.SyntaxKind.ExtendsKeyword) {
      continue;
    }

    for (const heritageType of clause.types) {
      const inheritedType = getTypeFromTypeNodeWithFallback(
        heritageType,
        checker,
        typeRegistry,
      );
      const members = resolveDeclaredObjectMembersWithSeen(
        inheritedType,
        checker,
        typeRegistry,
        seen,
      );
      if (members && members.length > 0) {
        inheritedMembers.push([...members]);
      }
    }
  }

  return mergeResolvedMembers(
    [...inheritedMembers, [...decl.members]],
    checker,
  );
}

function mergeResolvedMembers(
  memberSets: readonly (readonly ts.TypeElement[])[],
  checker: ts.TypeChecker,
): readonly ts.TypeElement[] {
  const merged: ts.TypeElement[] = [];
  const propertyIndexes = new Map<string, number>();

  for (const members of memberSets) {
    for (const member of members) {
      if (ts.isPropertySignature(member) && member.name) {
        const name = getRequestedPropertyNameText(member.name, checker);
        if (name) {
          const existingIndex = propertyIndexes.get(name);
          if (existingIndex !== undefined) {
            merged[existingIndex] = member;
            continue;
          }
          propertyIndexes.set(name, merged.length);
        }
      }

      merged.push(member);
    }
  }

  return merged;
}

/**
 * Returns true when the shrunk TypeLiteral is structurally identical to the
 * original declaration members — same member count, same member names, and
 * each member's type node is the original (not a newly created node).
 */
function isUnchangedShrink(
  originalMembers: readonly ts.TypeElement[],
  shrunk: ts.TypeNode,
): boolean {
  if (!ts.isTypeLiteralNode(shrunk)) return false;
  const origProps = originalMembers.filter(
    (m): m is ts.PropertySignature =>
      ts.isPropertySignature(m) && !!m.name && !!m.type,
  );
  if (shrunk.members.length !== origProps.length) return false;
  // Check each shrunk member's type is the exact same node object as the
  // original — if any type was recreated by recursive shrinking, the node
  // identity will differ.
  for (const member of shrunk.members) {
    if (!ts.isPropertySignature(member) || !member.name || !member.type) {
      return false;
    }
    const name = getPropertyNameText(member.name);
    if (!name) return false;
    const orig = origProps.find(
      (p) => getPropertyNameText(p.name) === name,
    );
    if (!orig) return false;
    if (member.type !== orig.type) return false;
  }
  return true;
}

/**
 * Shared logic: filters a list of type members to only the accessed property
 * heads and recursively shrinks child types.
 */
function shrinkTypeLiteralMembers(
  members: readonly ts.TypeElement[],
  normalizedPaths: readonly (readonly string[])[],
  factory: ts.NodeFactory,
  checker?: ts.TypeChecker,
  typeRegistry?: WeakMap<ts.Node, ts.Type>,
  fullShapePaths: readonly (readonly string[])[] = [],
): ts.TypeNode | undefined {
  const grouped = groupPathsByHead(normalizedPaths);
  const fullShapeGrouped = groupPathsByHead(fullShapePaths);
  const result: ts.TypeElement[] = [];

  for (const member of members) {
    if (!ts.isPropertySignature(member) || !member.name || !member.type) {
      continue;
    }

    const propertyName = getRequestedPropertyNameText(member.name, checker);
    if (!propertyName) continue;
    const childPaths = grouped.get(propertyName);
    if (!childPaths) continue;

    const shrunkChild = buildShrunkTypeNodeFromTypeNode(
      member.type,
      childPaths,
      factory,
      checker,
      typeRegistry,
      fullShapeGrouped.get(propertyName) ?? [],
    ) ?? member.type;

    result.push(
      factory.updatePropertySignature(
        member,
        member.modifiers,
        member.name,
        member.questionToken ??
          (typeNodeIncludesUndefined(shrunkChild)
            ? factory.createToken(ts.SyntaxKind.QuestionToken)
            : undefined),
        shrunkChild,
      ),
    );
  }

  if (result.length === 0) {
    return undefined;
  }
  return checker
    ? createRegisteredTypeLiteral(result, { factory, checker, typeRegistry })
    : factory.createTypeLiteralNode(result);
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Node-level check: does this TypeNode have a member named `head`? */
function typeNodeHasHead(
  node: ts.TypeNode,
  head: string,
  checker: ts.TypeChecker,
): boolean {
  if (ts.isTypeLiteralNode(node)) {
    return node.members.some(
      (m) =>
        ts.isPropertySignature(m) && m.name &&
        getRequestedPropertyNameText(m.name, checker) === head,
    );
  }

  if (ts.isUnionTypeNode(node)) {
    // Valid if ANY non-nullish constituent has it
    return node.types.some(
      (m) => !isNullishTypeNode(m) && typeNodeHasHead(m, head, checker),
    );
  }

  if (ts.isTypeReferenceNode(node)) {
    const members = resolveTypeReferenceMembers(node, checker);
    if (members) {
      return members.some(
        (m) =>
          ts.isPropertySignature(m) && m.name &&
          getRequestedPropertyNameText(m.name, checker) === head,
      );
    }
  }

  return false;
}

/** Type-level check: does this ts.Type have a property named `head`? */
function typeHasHead(
  type: ts.Type,
  head: string,
  checker: ts.TypeChecker,
): boolean {
  // Direct property lookup (works for simple object types)
  if (findPropertySymbol(type, head, checker)) return true;

  // For unions, check each non-primitive constituent individually
  // (getProperty on a union uses intersection semantics)
  if (type.isUnion()) {
    for (const constituent of type.types) {
      if (constituent.getProperty(head)) return true;
    }
  }

  // Numeric heads are valid on array-like types (index access)
  if (Number.isFinite(Number(head))) {
    if (isNumericIndexableType(type, checker)) {
      return true;
    }
  }

  return false;
}

/**
 * Checks whether `head` can resolve as a property on the given type.
 * Tries the shrunk TypeNode first, then baseTypeNode, then the resolved
 * ts.Type. Handles unions (any non-nullish constituent), TypeReferences
 * (resolved declarations), and arrays (numeric index heads).
 */
function typeHasProperty(
  head: string,
  shrunk: ts.TypeNode | undefined,
  baseTypeNode: ts.TypeNode,
  baseType: ts.Type | undefined,
  checker: ts.TypeChecker,
): boolean {
  // 1. Check the shrunk node (if available)
  if (shrunk && typeNodeHasHead(shrunk, head, checker)) return true;

  // 2. Check the base type node
  if (typeNodeHasHead(baseTypeNode, head, checker)) return true;

  // 3. Fall back to the resolved semantic type (handles aliases, generics,
  //    mapped types, and other forms that aren't visible at the node level).
  if (baseType) {
    const nonNullable = checker.getNonNullableType(baseType);
    if (typeHasHead(nonNullable, head, checker)) return true;
  }

  return false;
}

function getArrayElementTypeNode(
  node: ts.TypeNode | undefined,
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
  typeRegistry?: WeakMap<ts.Node, ts.Type>,
): ts.TypeNode | undefined {
  if (!node) return undefined;

  const current = ts.isParenthesizedTypeNode(node) ? node.type : node;

  if (ts.isUnionTypeNode(current)) {
    for (const member of current.types) {
      if (isNullishTypeNode(member)) continue;
      const elementNode = getArrayElementTypeNode(
        member,
        checker,
        sourceFile,
        typeRegistry,
      );
      if (elementNode) {
        return elementNode;
      }
    }
    return undefined;
  }

  if (ts.isArrayTypeNode(current)) {
    return current.elementType;
  }

  if (
    ts.isTypeOperatorNode(current) &&
    current.operator === ts.SyntaxKind.ReadonlyKeyword &&
    ts.isArrayTypeNode(current.type)
  ) {
    return current.type.elementType;
  }

  if (
    ts.isTypeReferenceNode(current) &&
    ts.isIdentifier(current.typeName) &&
    current.typeArguments?.[0] &&
    (current.typeName.text === "Array" ||
      current.typeName.text === "ReadonlyArray")
  ) {
    return current.typeArguments[0];
  }

  const resolvedType = getTypeFromTypeNodeWithFallback(
    current,
    checker,
    typeRegistry,
  );
  if (!isArrayShapeType(resolvedType, checker)) {
    return undefined;
  }

  const elementType = getArrayElementType(resolvedType, checker);
  if (!elementType) {
    return undefined;
  }

  const typeToNodeFlags = ts.NodeBuilderFlags.NoTruncation |
    ts.NodeBuilderFlags.UseStructuralFallback;
  const elementNode = checker.typeToTypeNode(
    elementType,
    sourceFile,
    typeToNodeFlags,
  );
  if (elementNode) {
    ensureTypeNodeRegistered(elementNode, checker, typeRegistry);
  }
  return elementNode;
}

/**
 * After shrinking, validates that the requested property paths were actually
 * materialised. Reports a diagnostic when the base type is too narrow or
 * `unknown`/`any` and property accesses cannot resolve.
 */
export function validateShrinkCoverage(
  paramSummary: CapabilityParamSummary,
  baseTypeNode: ts.TypeNode,
  baseType: ts.Type | undefined,
  paths: readonly (readonly string[])[],
  shrunk: ts.TypeNode | undefined,
  context: TransformationContext,
  fnNode: ts.Node,
  checker: ts.TypeChecker,
): void {
  if (paths.length === 0 && !paramSummary.wildcard) return;

  // For wildcard parameters with no explicit property paths, check if
  // the base type is `unknown` — passing an unknown-typed value to an
  // opaque function (like console.log) will not produce useful data at
  // runtime because the schema cannot express what to fetch.
  if (paramSummary.wildcard) {
    if (paramSummary.name.startsWith("__")) return;
    const isUnknownBase = baseTypeNode.kind === ts.SyntaxKind.UnknownKeyword ||
      (baseType !== undefined &&
        (baseType.flags & ts.TypeFlags.Unknown) !== 0);
    if (isUnknownBase) {
      context.reportDiagnostic({
        severity: "error",
        type: "schema:unknown-type-access",
        message:
          `Parameter '${paramSummary.name}' is typed as 'unknown' but is ` +
          `passed to a function the compiler cannot analyze. The generated ` +
          `schema cannot express what data to fetch. Replace 'unknown' with ` +
          `a concrete type that describes the expected shape.`,
        node: fnNode,
      });
    }
    return; // wildcard params still skip path-level validation
  }

  // Skip validation for synthetic parameters injected by the transformer
  // pipeline (e.g. ClosureTransformer's __cf_ parameters or __param indices).
  // These are internal implementation details, not user-authored types.
  if (paramSummary.name.startsWith("__")) return;

  const nonNullableBaseType = baseType
    ? checker.getNonNullableType(baseType)
    : undefined;

  if (nonNullableBaseType && isArrayShapeType(nonNullableBaseType, checker)) {
    const arrayRootPaths = uniquePaths(
      paths.filter((path) => isArrayRootOnlyPath(path)),
    );
    const arrayItemPaths = getArrayItemPaths(paths);

    if (arrayItemPaths.length > 0) {
      const elementType = getArrayElementType(nonNullableBaseType, checker);
      const elementTypeNode = getArrayElementTypeNode(
        baseTypeNode,
        checker,
        context.sourceFile,
        context.options.typeRegistry,
      ) ?? ts.factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);
      const shrunkElementNode = getArrayElementTypeNode(
        shrunk,
        checker,
        context.sourceFile,
        context.options.typeRegistry,
      );

      validateShrinkCoverage(
        paramSummary,
        elementTypeNode,
        elementType,
        arrayItemPaths,
        shrunkElementNode,
        context,
        fnNode,
        checker,
      );
    }

    if (arrayRootPaths.length === 0) {
      return;
    }

    paths = arrayRootPaths;
  }

  // Collect requested top-level property names. Synthetic callback lowering can
  // introduce helper reads like `.key("foo")`; ignore those when the base type
  // does not actually define a `key` property.
  const requestedHeads = new Set<string>();
  for (const p of paths) {
    const head = p[0];
    if (!head) {
      continue;
    }
    if (
      head === "key" &&
      !typeHasProperty(head, shrunk, baseTypeNode, baseType, checker)
    ) {
      continue;
    }
    requestedHeads.add(head);
  }
  if (requestedHeads.size === 0) return;

  // Skip validation for `never` — it is a bottom type where property access
  // is vacuously valid. This avoids false positives on synthetic parameters
  // injected by earlier transformers (e.g. ClosureTransformer).
  if (
    baseTypeNode.kind === ts.SyntaxKind.NeverKeyword ||
    (baseType !== undefined && (baseType.flags & ts.TypeFlags.Never) !== 0)
  ) {
    return;
  }

  // Skip validation for `any` — it is a top type where all property accesses
  // are valid. The runtime fetches all data for `any`-typed parameters, so
  // every key is reachable. This differs from `unknown` which cannot express
  // what to fetch.
  if (
    baseTypeNode.kind === ts.SyntaxKind.AnyKeyword ||
    (baseType !== undefined && (baseType.flags & ts.TypeFlags.Any) !== 0)
  ) {
    return;
  }

  // Case 1: unknown base type — every path is unresolvable
  const isUnknownBase = baseTypeNode.kind === ts.SyntaxKind.UnknownKeyword ||
    (baseType !== undefined &&
      (baseType.flags & (ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter)) !==
        0);

  if (isUnknownBase) {
    const pathList = [...requestedHeads].map((h) => `'.${h}'`).join(", ");
    context.reportDiagnostic({
      severity: "error",
      type: "schema:unknown-type-access",
      message:
        `Parameter '${paramSummary.name}' is typed as 'unknown' but the ` +
        `code accesses ${pathList}. The type must declare all properties ` +
        `the code may read. Replace 'unknown' with a concrete type that ` +
        `includes these properties.`,
      node: fnNode,
    });
    return;
  }

  // Case 2: concrete type but some accessed properties are typed `unknown`.
  // This catches interfaces like `{ amounts?: unknown }` where the property
  // exists but its type is `unknown`, meaning the runtime schema will contain
  // `{ type: "unknown" }` and the runtime will return opaque undefined.
  if (nonNullableBaseType) {
    const unknownProps: string[] = [];
    for (const head of requestedHeads) {
      const prop = nonNullableBaseType.getProperty(head) ??
        (nonNullableBaseType.isUnion()
          ? nonNullableBaseType.types.find((t) => t.getProperty(head))
            ?.getProperty(
              head,
            )
          : undefined);
      if (!prop) continue;
      const propType = checker.getTypeOfSymbol(prop);
      // Check the raw property type for `unknown`. Note: we check propType
      // directly rather than after getNonNullableType because TS maps
      // getNonNullableType(unknown) to Object, losing the unknown flag.
      // For optional props (`foo?: unknown`), the type is still `unknown`
      // since `unknown | undefined` collapses to `unknown`.
      if ((propType.flags & ts.TypeFlags.Unknown) !== 0) {
        unknownProps.push(head);
      }
    }
    if (unknownProps.length > 0) {
      const propList = unknownProps.map((h) => `'.${h}'`).join(", ");
      context.reportDiagnostic({
        severity: "error",
        type: "schema:unknown-type-access",
        message: `Parameter '${paramSummary.name}' has ` +
          `${unknownProps.length === 1 ? "property" : "properties"} ` +
          `${propList} typed as 'unknown'. The generated schema cannot ` +
          `express what data to fetch for unknown-typed properties. ` +
          `Replace 'unknown' with a concrete type that describes the ` +
          `expected shape.`,
        node: fnNode,
      });
      return;
    }
  }

  // Case 3: concrete type but some paths didn't resolve.
  const missing = [...requestedHeads].filter(
    (h) => !typeHasProperty(h, shrunk, baseTypeNode, baseType, checker),
  );
  if (missing.length === 0) return;

  const missingList = missing.map((h) => `'.${h}'`).join(", ");
  const typeText = printTypeNode(baseTypeNode, context.sourceFile);
  context.reportDiagnostic({
    severity: "error",
    type: "schema:path-not-in-type",
    message: `Parameter '${paramSummary.name}' accesses ${missingList} but ` +
      `type '${typeText}' does not include ` +
      `${missing.length === 1 ? "it" : "them"}. Add the missing ` +
      `${missing.length === 1 ? "property" : "properties"} to the type.`,
    node: fnNode,
  });
}

// ---------------------------------------------------------------------------
// Wrapping and defaults
// ---------------------------------------------------------------------------

export function wrapTypeNodeWithCapability(
  node: ts.TypeNode,
  capability: ReactiveCapability,
  factory: ts.NodeFactory,
): ts.TypeNode {
  const wrapperName = capability === "readonly"
    ? "ReadonlyCell"
    : capability === "writeonly"
    ? "WriteonlyCell"
    : capability === "writable"
    ? "Writable"
    : "OpaqueCell";

  return factory.createTypeReferenceNode(
    factory.createQualifiedName(
      factory.createIdentifier("__cfHelpers"),
      factory.createIdentifier(wrapperName),
    ),
    [node],
  );
}

function createIdentityOnlyReplacementTypeNode(
  node: ts.TypeNode,
  semanticType: ts.Type | undefined,
  forceOpaque: boolean,
  checker: ts.TypeChecker,
  factory: ts.NodeFactory,
  typeRegistry?: WeakMap<ts.Node, ts.Type>,
): ts.TypeNode {
  const unknownNode = factory.createKeywordTypeNode(
    ts.SyntaxKind.UnknownKeyword,
  );
  const resolvedType = semanticType ??
    getTypeFromTypeNodeWithFallback(
      node,
      checker,
      typeRegistry,
    );
  if (
    forceOpaque ||
    isCellLikeTypeNode(node) ||
    isCellLikeType(resolvedType, checker)
  ) {
    const wrappedNode = wrapTypeNodeWithCapability(
      unknownNode,
      "opaque",
      factory,
    );
    const wrappedType = resolveIdentitySemanticType(
      wrappedNode,
      checker,
      typeRegistry,
    );
    if (wrappedType && typeRegistry) {
      typeRegistry.set(wrappedNode, wrappedType);
    }
    return wrappedNode;
  }
  return unknownNode;
}

function createIdentityOnlyNullishTypeNode(
  type: ts.Type,
  node: ts.TypeNode,
  checker: ts.TypeChecker,
  factory: ts.NodeFactory,
  typeRegistry?: WeakMap<ts.Node, ts.Type>,
): ts.TypeNode {
  const typeToNodeFlags = ts.NodeBuilderFlags.NoTruncation |
    ts.NodeBuilderFlags.UseStructuralFallback;
  const nullishNode = checker.typeToTypeNode(
    type,
    node.getSourceFile(),
    typeToNodeFlags,
  ) ?? (
    (type.flags & ts.TypeFlags.Null) !== 0
      ? factory.createLiteralTypeNode(factory.createNull())
      : factory.createKeywordTypeNode(ts.SyntaxKind.UndefinedKeyword)
  );
  typeRegistry?.set(nullishNode, type);
  return nullishNode;
}

function createIdentityOnlyRootTypeNode(
  node: ts.TypeNode,
  semanticType: ts.Type | undefined,
  forceOpaque: boolean,
  checker: ts.TypeChecker,
  factory: ts.NodeFactory,
  typeRegistry?: WeakMap<ts.Node, ts.Type>,
): ts.TypeNode {
  const resolvedType = semanticType ??
    resolveIdentitySemanticType(node, checker, typeRegistry);

  if (!resolvedType) {
    return createIdentityOnlyReplacementTypeNode(
      node,
      resolvedType,
      forceOpaque,
      checker,
      factory,
      typeRegistry,
    );
  }

  if (isNullishType(resolvedType)) {
    return createIdentityOnlyNullishTypeNode(
      resolvedType,
      node,
      checker,
      factory,
      typeRegistry,
    );
  }

  if (resolvedType.isUnion()) {
    const members = resolvedType.types.map((memberType) =>
      isNullishType(memberType)
        ? createIdentityOnlyNullishTypeNode(
          memberType,
          node,
          checker,
          factory,
          typeRegistry,
        )
        : createIdentityOnlyReplacementTypeNode(
          checker.typeToTypeNode(
            memberType,
            node.getSourceFile(),
            ts.NodeBuilderFlags.NoTruncation |
              ts.NodeBuilderFlags.UseStructuralFallback,
          ) ?? factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
          memberType,
          forceOpaque,
          checker,
          factory,
          typeRegistry,
        )
    );

    if (members.length === 1) {
      return members[0]!;
    }

    const unionNode = factory.createUnionTypeNode(members);
    ensureTypeNodeRegistered(unionNode, checker, typeRegistry);
    return unionNode;
  }

  return createIdentityOnlyReplacementTypeNode(
    node,
    resolvedType,
    forceOpaque,
    checker,
    factory,
    typeRegistry,
  );
}

function getIdentityChildSemanticType(
  type: ts.Type | undefined,
  head: string,
  location: ts.Node,
  checker: ts.TypeChecker,
): ts.Type | undefined {
  if (!type) {
    return undefined;
  }

  const nonNullable = checker.getNonNullableType(type);
  const prop = findPropertySymbol(nonNullable, head, checker);
  if (prop) {
    const declaration = prop.valueDeclaration ?? prop.declarations?.[0] ??
      location;
    return checker.getTypeOfSymbolAtLocation(prop, declaration);
  }

  const numericIndex = Number.isFinite(Number(head));
  return checker.getIndexTypeOfType(
    nonNullable,
    numericIndex ? ts.IndexKind.Number : ts.IndexKind.String,
  ) ?? checker.getIndexTypeOfType(nonNullable, ts.IndexKind.String);
}

function resolveIdentitySemanticType(
  node: ts.TypeNode,
  checker: ts.TypeChecker,
  typeRegistry?: WeakMap<ts.Node, ts.Type>,
): ts.Type | undefined {
  try {
    return getTypeFromTypeNodeWithFallback(node, checker, typeRegistry);
  } catch (_error: unknown) {
    return undefined;
  }
}

function applyIdentityOnlyPathsToTypeNode(
  node: ts.TypeNode,
  paths: readonly (readonly string[])[],
  cellLikePaths: readonly (readonly string[])[],
  factory: ts.NodeFactory,
  checker: ts.TypeChecker,
  semanticType?: ts.Type,
  typeRegistry?: WeakMap<ts.Node, ts.Type>,
): ts.TypeNode {
  const normalized = uniquePaths(paths);
  const normalizedCellLikePaths = uniquePaths(cellLikePaths);
  if (normalized.length === 0) {
    return node;
  }
  const resolvedSemanticType = semanticType ??
    resolveIdentitySemanticType(node, checker, typeRegistry);
  if (normalized.some((path) => path.length === 0)) {
    return createIdentityOnlyRootTypeNode(
      node,
      resolvedSemanticType,
      normalizedCellLikePaths.some((path) => path.length === 0),
      checker,
      factory,
      typeRegistry,
    );
  }

  if (ts.isParenthesizedTypeNode(node)) {
    const updated = applyIdentityOnlyPathsToTypeNode(
      node.type,
      normalized,
      normalizedCellLikePaths,
      factory,
      checker,
      resolvedSemanticType,
      typeRegistry,
    );
    return updated === node.type
      ? node
      : factory.updateParenthesizedType(node, updated);
  }

  const itemPaths = getArrayItemPaths(normalized);
  const itemCellLikePaths = getArrayItemPaths(normalizedCellLikePaths);
  if (itemPaths.length > 0) {
    const itemSemanticType = resolvedSemanticType
      ? getArrayElementType(
        checker.getNonNullableType(resolvedSemanticType),
        checker,
      )
      : undefined;
    if (ts.isArrayTypeNode(node)) {
      const updated = applyIdentityOnlyPathsToTypeNode(
        node.elementType,
        itemPaths,
        itemCellLikePaths,
        factory,
        checker,
        itemSemanticType,
        typeRegistry,
      );
      if (updated === node.elementType) {
        return node;
      }
      const arrayNode = factory.updateArrayTypeNode(node, updated);
      ensureTypeNodeRegistered(arrayNode, checker, typeRegistry);
      return arrayNode;
    }

    if (
      ts.isTypeOperatorNode(node) &&
      node.operator === ts.SyntaxKind.ReadonlyKeyword &&
      ts.isArrayTypeNode(node.type)
    ) {
      const updated = applyIdentityOnlyPathsToTypeNode(
        node.type.elementType,
        itemPaths,
        itemCellLikePaths,
        factory,
        checker,
        itemSemanticType,
        typeRegistry,
      );
      if (updated === node.type.elementType) {
        return node;
      }
      const readonlyArray = factory.updateArrayTypeNode(node.type, updated);
      const readonlyNode = factory.updateTypeOperatorNode(
        node,
        readonlyArray,
      );
      ensureTypeNodeRegistered(readonlyNode, checker, typeRegistry);
      return readonlyNode;
    }

    if (
      ts.isTypeReferenceNode(node) &&
      ts.isIdentifier(node.typeName) &&
      node.typeArguments?.[0] &&
      (node.typeName.text === "Array" || node.typeName.text === "ReadonlyArray")
    ) {
      const [inner] = node.typeArguments;
      const updated = applyIdentityOnlyPathsToTypeNode(
        inner,
        itemPaths,
        itemCellLikePaths,
        factory,
        checker,
        itemSemanticType,
        typeRegistry,
      );
      if (updated === inner) {
        return node;
      }
      const arrayRef = factory.updateTypeReferenceNode(
        node,
        node.typeName,
        factory.createNodeArray([updated]),
      );
      ensureTypeNodeRegistered(arrayRef, checker, typeRegistry);
      return arrayRef;
    }
  }

  if (ts.isTypeLiteralNode(node)) {
    const grouped = groupPathsByHead(normalized);
    const cellLikeGrouped = groupPathsByHead(normalizedCellLikePaths);
    let changed = false;
    const members = node.members.map((member) => {
      if (!ts.isPropertySignature(member) || !member.type || !member.name) {
        return member;
      }
      const propertyName = getRequestedPropertyNameText(member.name, checker);
      if (!propertyName) {
        return member;
      }
      const childPaths = grouped.get(propertyName);
      if (!childPaths) {
        return member;
      }
      const updated = applyIdentityOnlyPathsToTypeNode(
        member.type,
        childPaths,
        cellLikeGrouped.get(propertyName) ?? [],
        factory,
        checker,
        getIdentityChildSemanticType(
          resolvedSemanticType,
          propertyName,
          member,
          checker,
        ),
        typeRegistry,
      );
      if (updated === member.type) {
        return member;
      }
      changed = true;
      return factory.updatePropertySignature(
        member,
        member.modifiers,
        member.name,
        member.questionToken ??
          (typeNodeIncludesUndefined(updated)
            ? factory.createToken(ts.SyntaxKind.QuestionToken)
            : undefined),
        updated,
      );
    });

    if (!changed) {
      return node;
    }
    return createRegisteredTypeLiteral(
      members,
      { factory, checker, typeRegistry },
    );
  }

  if (
    ts.isTypeReferenceNode(node) &&
    isCellLikeTypeNode(node) &&
    node.typeArguments?.[0]
  ) {
    const [inner, ...rest] = node.typeArguments;
    const updated = applyIdentityOnlyPathsToTypeNode(
      inner,
      normalized,
      normalizedCellLikePaths,
      factory,
      checker,
      unwrapCellLikeType(resolvedSemanticType, checker) ?? resolvedSemanticType,
      typeRegistry,
    );
    if (updated === inner) {
      return node;
    }
    const cellNode = factory.updateTypeReferenceNode(
      node,
      node.typeName,
      factory.createNodeArray([updated, ...rest]),
    );
    ensureTypeNodeRegistered(cellNode, checker, typeRegistry);
    return cellNode;
  }

  if (ts.isUnionTypeNode(node)) {
    let changed = false;
    const members = node.types.map((member) => {
      const updated = applyIdentityOnlyPathsToTypeNode(
        member,
        normalized,
        normalizedCellLikePaths,
        factory,
        checker,
        resolvedSemanticType,
        typeRegistry,
      );
      if (updated !== member) {
        changed = true;
      }
      return updated;
    });

    if (!changed) {
      return node;
    }
    const unionNode = factory.createUnionTypeNode(members);
    ensureTypeNodeRegistered(unionNode, checker, typeRegistry);
    return unionNode;
  }

  return node;
}

function wrapTypeNodeWithDefault(
  node: ts.TypeNode,
  defaultType: ts.TypeNode,
  factory: ts.NodeFactory,
): ts.TypeNode {
  return factory.createTypeReferenceNode(
    factory.createQualifiedName(
      factory.createIdentifier("__cfHelpers"),
      factory.createIdentifier("Default"),
    ),
    [node, defaultType],
  );
}

function applySingleDefaultToTypeNode(
  node: ts.TypeNode,
  path: readonly string[],
  defaultType: ts.TypeNode,
  factory: ts.NodeFactory,
  checker?: ts.TypeChecker,
): { node: ts.TypeNode; applied: boolean } {
  if (path.length === 0) {
    return {
      node: wrapTypeNodeWithDefault(node, defaultType, factory),
      applied: true,
    };
  }

  const [head, ...tail] = path;
  if (!head) {
    return { node, applied: false };
  }

  if (ts.isTypeLiteralNode(node)) {
    let applied = false;
    const members = node.members.map((member) => {
      if (!ts.isPropertySignature(member) || !member.type || !member.name) {
        return member;
      }
      const memberName = getPropertyNameText(member.name, checker);
      if (memberName !== head) {
        return member;
      }
      const updatedChild = applySingleDefaultToTypeNode(
        member.type,
        tail,
        defaultType,
        factory,
        checker,
      );
      if (!updatedChild.applied) {
        return member;
      }
      applied = true;
      return factory.updatePropertySignature(
        member,
        member.modifiers,
        member.name,
        member.questionToken,
        updatedChild.node,
      );
    });

    return applied
      ? { node: factory.createTypeLiteralNode(members), applied: true }
      : { node, applied: false };
  }

  if (ts.isTupleTypeNode(node)) {
    const index = Number(head);
    if (
      !Number.isInteger(index) || index < 0 || index >= node.elements.length
    ) {
      return { node, applied: false };
    }
    const element = node.elements[index];
    if (!element) return { node, applied: false };
    const updatedChild = applySingleDefaultToTypeNode(
      element,
      tail,
      defaultType,
      factory,
      checker,
    );
    if (!updatedChild.applied) {
      return { node, applied: false };
    }
    const nextElements = [...node.elements];
    nextElements[index] = updatedChild.node;
    return {
      node: factory.updateTupleTypeNode(node, nextElements),
      applied: true,
    };
  }

  if (ts.isUnionTypeNode(node)) {
    let applied = false;
    const members = node.types.map((member) => {
      const updatedChild = applySingleDefaultToTypeNode(
        member,
        path,
        defaultType,
        factory,
        checker,
      );
      if (updatedChild.applied) {
        applied = true;
      }
      return updatedChild.node;
    });

    return applied
      ? { node: factory.createUnionTypeNode(members), applied: true }
      : { node, applied: false };
  }

  return { node, applied: false };
}

function applyDefaultsToTypeNode(
  node: ts.TypeNode,
  defaults: readonly CapabilityParamDefault[] | undefined,
  factory: ts.NodeFactory,
  checker?: ts.TypeChecker,
): { node: ts.TypeNode; appliedCount: number } {
  if (!defaults || defaults.length === 0) {
    return { node, appliedCount: 0 };
  }

  const ordered = [...defaults].sort((a, b) => b.path.length - a.path.length);
  let next = node;
  let appliedCount = 0;
  for (const entry of ordered) {
    const updated = applySingleDefaultToTypeNode(
      next,
      entry.path,
      entry.defaultType,
      factory,
      checker,
    );
    if (updated.applied) {
      next = updated.node;
      appliedCount++;
    }
  }
  return { node: next, appliedCount };
}

export function applyCapabilityDefaultsToTypeNode(
  node: ts.TypeNode,
  defaults: readonly CapabilityParamDefault[] | undefined,
  baseType: ts.Type | undefined,
  paths: readonly (readonly string[])[],
  wildcard: boolean,
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
  factory: ts.NodeFactory,
): ts.TypeNode {
  const initial = applyDefaultsToTypeNode(node, defaults, factory, checker);
  if (initial.appliedCount > 0 || !defaults || defaults.length === 0) {
    return initial.node;
  }
  if (!baseType) {
    return initial.node;
  }

  let fallbackNode: ts.TypeNode | undefined;
  if (!wildcard && paths.length > 0) {
    fallbackNode = buildShrunkTypeNodeFromType(
      baseType,
      paths,
      checker,
      sourceFile,
      factory,
    );
  }
  fallbackNode ??= typeToSchemaTypeNode(baseType, checker, sourceFile);
  if (!fallbackNode) {
    return initial.node;
  }

  const fallback = applyDefaultsToTypeNode(
    fallbackNode,
    defaults,
    factory,
    checker,
  );
  return fallback.appliedCount > 0 ? fallback.node : initial.node;
}

function collectAllPropertyLeafPaths(
  type: ts.Type,
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
  prefix: readonly string[],
  seen: Set<ts.Type>,
): readonly (readonly string[])[] {
  if (seen.has(type) || isNumericIndexableType(type, checker)) {
    return [prefix];
  }
  const nextSeen = new Set(seen);
  nextSeen.add(type);

  const properties = checker.getPropertiesOfType(type);
  if (properties.length === 0) {
    return [prefix];
  }

  const paths: string[][] = [];
  for (const property of properties) {
    const childType = getSymbolTypeAtSource(property, checker, sourceFile);
    const childPrefix = [...prefix, property.getName()];
    const childPaths = collectAllPropertyLeafPaths(
      childType,
      checker,
      sourceFile,
      childPrefix,
      nextSeen,
    );
    for (const path of childPaths) {
      paths.push([...path]);
    }
  }
  return paths;
}

function buildDefaultsOnlyFallbackPaths(
  baseType: ts.Type | undefined,
  defaults: readonly CapabilityParamDefault[] | undefined,
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
): readonly (readonly string[])[] {
  if (!baseType || !defaults || defaults.length === 0) {
    return [];
  }

  const nestedHeads = new Set<string>();
  for (const entry of defaults) {
    if (entry.path.length > 1) {
      const [head] = entry.path;
      if (head) nestedHeads.add(head);
    }
  }

  const fallbackPaths: string[][] = [];
  for (const property of checker.getPropertiesOfType(baseType)) {
    const head = property.getName();
    if (!nestedHeads.has(head)) {
      fallbackPaths.push([head]);
      continue;
    }

    const childType = getSymbolTypeAtSource(property, checker, sourceFile);
    const leafPaths = collectAllPropertyLeafPaths(
      childType,
      checker,
      sourceFile,
      [head],
      new Set<ts.Type>(),
    );
    for (const path of leafPaths) {
      fallbackPaths.push([...path]);
    }
  }

  for (const entry of defaults) {
    fallbackPaths.push([...entry.path]);
  }

  return uniquePaths(fallbackPaths);
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Shared implementation for applying capability summary shrinking and wrapping
 * to a type node. Both `applyCapabilitySummaryToArgument` and
 * `applyCapabilitySummaryToParameter` delegate here after resolving their
 * respective param summary and base types.
 */
export function applyShrinkAndWrap(
  paramSummary: CapabilityParamSummary,
  baseTypeNode: ts.TypeNode,
  baseType: ts.Type | undefined,
  shouldWrap: boolean,
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
  factory: ts.NodeFactory,
  mode: CapabilitySummaryApplicationMode = "full",
  wrapCapability: ReactiveCapability = paramSummary.capability,
  context?: TransformationContext,
  fnNode?: ts.Node,
): ts.TypeNode {
  const shrinkPlan = deriveCapabilityShrinkPlan(paramSummary);
  const {
    retainedPaths,
    fullShapePaths,
    identityPaths,
    identityCellPaths,
    identityOnlyRoot,
    effectiveIdentityPaths,
  } = shrinkPlan;

  if (mode === "defaults_only") {
    if (context && fnNode) {
      validateShrinkCoverage(
        paramSummary,
        baseTypeNode,
        baseType,
        retainedPaths,
        undefined,
        context,
        fnNode,
        checker,
      );
    }

    const next = identityOnlyRoot
      ? applyIdentityOnlyPathsToTypeNode(
        baseTypeNode,
        effectiveIdentityPaths,
        identityCellPaths,
        factory,
        checker,
        baseType,
        context?.options.typeRegistry,
      )
      : applyCapabilityDefaultsToTypeNode(
        baseTypeNode,
        paramSummary.defaults,
        baseType,
        buildDefaultsOnlyFallbackPaths(
          baseType,
          paramSummary.defaults,
          checker,
          sourceFile,
        ),
        false,
        checker,
        sourceFile,
        factory,
      );

    if (!shouldWrap) {
      return next;
    }
    return wrapTypeNodeWithCapability(next, wrapCapability, factory);
  }

  let next = identityOnlyRoot
    ? applyIdentityOnlyPathsToTypeNode(
      baseTypeNode,
      effectiveIdentityPaths,
      identityCellPaths,
      factory,
      checker,
      baseType,
      context?.options.typeRegistry,
    )
    : baseTypeNode;
  let shrunk: ts.TypeNode | undefined;
  if (
    !identityOnlyRoot &&
    !paramSummary.wildcard &&
    retainedPaths.length > 0
  ) {
    const hasDirectAccess = retainedPaths.some((path) => path.length === 0);
    const preferTypeDriven = !!baseType && isSyntheticTypeNode(baseTypeNode);
    if (preferTypeDriven) {
      // Synthetic inferred nodes can lose property precision in node-only mode.
      const typeDriven = buildShrunkTypeNodeFromType(
        baseType!,
        retainedPaths,
        checker,
        sourceFile,
        factory,
        context?.options.typeRegistry,
        fullShapePaths,
      );
      const nodeDriven = buildShrunkTypeNodeFromTypeNode(
        baseTypeNode,
        retainedPaths,
        factory,
        checker,
        context?.options.typeRegistry,
        fullShapePaths,
      );
      shrunk = choosePreferredShrinkCandidate(
        "type",
        nodeDriven,
        typeDriven,
        baseTypeNode,
        retainedPaths,
        checker,
        hasDirectAccess,
      );
    } else {
      // Source-authored nodes preserve exact unions/aliases, but type-driven
      // shrinking can still produce a better result for arrays and inferred
      // wrappers. Compute both and choose the more informative shrink.
      const nodeDriven = buildShrunkTypeNodeFromTypeNode(
        baseTypeNode,
        retainedPaths,
        factory,
        checker,
        context?.options.typeRegistry,
        fullShapePaths,
      );
      const typeDriven = baseType
        ? buildShrunkTypeNodeFromType(
          baseType,
          retainedPaths,
          checker,
          sourceFile,
          factory,
          context?.options.typeRegistry,
          fullShapePaths,
        )
        : undefined;
      shrunk = choosePreferredShrinkCandidate(
        "node",
        nodeDriven,
        typeDriven,
        baseTypeNode,
        retainedPaths,
        checker,
        hasDirectAccess,
      );
    }
    if (shrunk) {
      next = shrunk;
    }
  }
  if (!identityOnlyRoot && identityPaths.length > 0) {
    next = applyIdentityOnlyPathsToTypeNode(
      next,
      identityPaths,
      identityCellPaths,
      factory,
      checker,
      baseType,
      context?.options.typeRegistry,
    );
    shrunk = next;
  }
  if (context && fnNode) {
    validateShrinkCoverage(
      paramSummary,
      baseTypeNode,
      baseType,
      retainedPaths,
      shrunk,
      context,
      fnNode,
      checker,
    );
  }

  next = applyCapabilityDefaultsToTypeNode(
    next,
    paramSummary.defaults,
    baseType,
    retainedPaths,
    paramSummary.wildcard,
    checker,
    sourceFile,
    factory,
  );

  if (!shouldWrap) {
    return next;
  }
  return wrapTypeNodeWithCapability(next, wrapCapability, factory);
}
