import ts from "typescript";
import { getPropertyNameText } from "@commontools/schema-generator/property-name";
import { createPropertyName } from "../utils/identifiers.ts";
import { uniquePaths } from "../utils/path-serialization.ts";
import {
  type CapabilityParamDefault,
  type CapabilityParamSummary,
  type ReactiveCapability,
  TransformationContext,
} from "../core/mod.ts";
import { isAnyOrUnknownType, typeToSchemaTypeNode } from "../ast/mod.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CapabilitySummaryApplicationMode = "full" | "defaults_only";

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
): ts.TypeNode | undefined {
  const typeToNodeFlags = ts.NodeBuilderFlags.NoTruncation |
    ts.NodeBuilderFlags.UseStructuralFallback;
  const normalized = uniquePaths(paths);
  if (normalized.length === 0) {
    return undefined;
  }

  // Keep array-like roots as arrays. Narrowing `T[]` to `{ length: number }`
  // breaks runtime schema matching for downstream derives/lifts.
  const typeChecker = checker as ts.TypeChecker & {
    isArrayType?: (type: ts.Type) => boolean;
    isTupleType?: (type: ts.Type) => boolean;
  };
  const isArrayLike = typeChecker.isArrayType?.(type) ||
    typeChecker.isTupleType?.(type) ||
    !!checker.getIndexTypeOfType(type, ts.IndexKind.Number);
  if (isArrayLike) {
    return checker.typeToTypeNode(type, sourceFile, typeToNodeFlags) ??
      factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);
  }

  if (normalized.some((path) => path.length === 0)) {
    return checker.typeToTypeNode(type, sourceFile, typeToNodeFlags) ??
      factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);
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
            if (node) nullishMembers.push(node);
          }
        }
      }
      if (nullishMembers.length === 0) return shrunkInner;
      return factory.createUnionTypeNode([shrunkInner, ...nullishMembers]);
    }
  }

  const grouped = groupPathsByHead(normalized);
  const properties: ts.TypeElement[] = [];

  for (const [head, childPaths] of grouped) {
    let propType: ts.Type | undefined;
    let isOptional = false;

    const prop = type.getProperty(head);
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

    if (!propType) {
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
    );
    if (!shrunkChild && !hasDirectAccess) {
      // We failed to materialize a deeper path; let caller fall back to
      // node-based shrinking instead of widening to the full property shape.
      continue;
    }

    const propTypeNode = shrunkChild ??
      checker.typeToTypeNode(propType, sourceFile, typeToNodeFlags) ??
      factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);

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

  return factory.createTypeLiteralNode(properties);
}

function buildShrunkTypeNodeFromTypeNode(
  node: ts.TypeNode,
  paths: readonly (readonly string[])[],
  factory: ts.NodeFactory,
  checker?: ts.TypeChecker,
): ts.TypeNode | undefined {
  const normalized = uniquePaths(paths);
  if (normalized.length === 0) {
    return undefined;
  }

  if (normalized.some((path) => path.length === 0)) {
    return node;
  }

  // Shrink object type literals by filtering to only the accessed members.
  if (ts.isTypeLiteralNode(node)) {
    return shrinkTypeLiteralMembers(node.members, normalized, factory, checker);
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
    const members = resolveTypeReferenceMembers(node, checker);
    if (members) {
      const shrunk = shrinkTypeLiteralMembers(
        members,
        normalized,
        factory,
        checker,
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
      );
      if (s && s !== member) {
        changed = true;
        return s;
      }
      return member;
    });
    if (!changed) return node;

    const all = [...shrunkMembers, ...nullish];
    return all.length === 1 ? all[0] : factory.createUnionTypeNode(all);
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
): readonly ts.TypeElement[] | undefined {
  const type = checker.getTypeFromTypeNode(node);
  const symbol = type.aliasSymbol ?? type.symbol;
  if (!symbol?.declarations?.length) return undefined;
  for (const decl of symbol.declarations) {
    if (ts.isTypeAliasDeclaration(decl) && ts.isTypeLiteralNode(decl.type)) {
      return decl.type.members;
    }
    if (ts.isInterfaceDeclaration(decl)) {
      return decl.members;
    }
  }
  return undefined;
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
): ts.TypeNode | undefined {
  const grouped = groupPathsByHead(normalizedPaths);
  const result: ts.TypeElement[] = [];

  for (const member of members) {
    if (!ts.isPropertySignature(member) || !member.name || !member.type) {
      continue;
    }

    const propertyName = getPropertyNameText(member.name);
    if (!propertyName) continue;
    const childPaths = grouped.get(propertyName);
    if (!childPaths) continue;

    const shrunkChild = buildShrunkTypeNodeFromTypeNode(
      member.type,
      childPaths,
      factory,
      checker,
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
  return factory.createTypeLiteralNode(result);
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
        getPropertyNameText(m.name) === head,
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
          getPropertyNameText(m.name) === head,
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
  if (type.getProperty(head)) return true;

  // For unions, check each non-primitive constituent individually
  // (getProperty on a union uses intersection semantics)
  if (type.isUnion()) {
    for (const constituent of type.types) {
      if (constituent.getProperty(head)) return true;
    }
  }

  // Numeric heads are valid on array-like types (index access)
  if (Number.isFinite(Number(head))) {
    const tc = checker as ts.TypeChecker & {
      isArrayType?: (t: ts.Type) => boolean;
      isTupleType?: (t: ts.Type) => boolean;
    };
    if (
      tc.isArrayType?.(type) || tc.isTupleType?.(type) ||
      !!checker.getIndexTypeOfType(type, ts.IndexKind.Number)
    ) {
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
  // pipeline (e.g. ClosureTransformer's __ct_ parameters or __param indices).
  // These are internal implementation details, not user-authored types.
  if (paramSummary.name.startsWith("__")) return;

  // Collect requested top-level property names, filtering out the reactive
  // proxy accessor method "key" which is injected by the capability-lowering
  // transformer and is not a user-authored property.
  const requestedHeads = new Set<string>();
  for (const p of paths) {
    if (p.length > 0 && p[0] !== undefined && p[0] !== "key") {
      requestedHeads.add(p[0]);
    }
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

  // Case 2: concrete type but some paths didn't resolve.
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
      factory.createIdentifier("__ctHelpers"),
      factory.createIdentifier(wrapperName),
    ),
    [node],
  );
}

function wrapTypeNodeWithDefault(
  node: ts.TypeNode,
  defaultType: ts.TypeNode,
  factory: ts.NodeFactory,
): ts.TypeNode {
  return factory.createTypeReferenceNode(
    factory.createQualifiedName(
      factory.createIdentifier("__ctHelpers"),
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
      const memberName = getPropertyNameText(member.name);
      if (memberName !== head) {
        return member;
      }
      const updatedChild = applySingleDefaultToTypeNode(
        member.type,
        tail,
        defaultType,
        factory,
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
  const initial = applyDefaultsToTypeNode(node, defaults, factory);
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

  const fallback = applyDefaultsToTypeNode(fallbackNode, defaults, factory);
  return fallback.appliedCount > 0 ? fallback.node : initial.node;
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
  context?: TransformationContext,
  fnNode?: ts.Node,
): ts.TypeNode {
  const paths = uniquePaths([
    ...paramSummary.readPaths,
    ...paramSummary.writePaths,
  ]);

  let next = baseTypeNode;
  let shrunk: ts.TypeNode | undefined;
  if (!paramSummary.wildcard && paths.length > 0) {
    const preferTypeDriven = !!baseType && isSyntheticTypeNode(baseTypeNode);
    if (preferTypeDriven) {
      // Synthetic inferred nodes can lose property precision in node-only mode.
      const typeDriven = buildShrunkTypeNodeFromType(
        baseType!,
        paths,
        checker,
        sourceFile,
        factory,
      );
      const nodeDriven = buildShrunkTypeNodeFromTypeNode(
        baseTypeNode,
        paths,
        factory,
        checker,
      );
      shrunk = typeDriven ?? nodeDriven;
      if (
        typeDriven &&
        nodeDriven &&
        containsAnyOrUnknownTypeNode(typeDriven) &&
        !containsAnyOrUnknownTypeNode(nodeDriven)
      ) {
        // Prefer node-driven shrinking when type-driven rebuilding widens nested
        // members to `any`/`unknown` (e.g. array items or optional fields).
        shrunk = nodeDriven;
      }
    } else {
      // Source-authored nodes preserve exact unions/aliases; keep them first.
      shrunk = buildShrunkTypeNodeFromTypeNode(
        baseTypeNode,
        paths,
        factory,
        checker,
      );
      if (!shrunk && baseType) {
        shrunk = buildShrunkTypeNodeFromType(
          baseType,
          paths,
          checker,
          sourceFile,
          factory,
        );
      }
    }
    if (shrunk) {
      next = shrunk;
    }
  }
  if (context && fnNode) {
    validateShrinkCoverage(
      paramSummary,
      baseTypeNode,
      baseType,
      paths,
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
    paths,
    paramSummary.wildcard,
    checker,
    sourceFile,
    factory,
  );

  if (!shouldWrap) {
    return next;
  }
  return wrapTypeNodeWithCapability(next, paramSummary.capability, factory);
}
