import ts from "typescript";
import { getPropertyNameText } from "@commonfabric/schema-generator/property-name";
import { isDefaultAliasSymbol } from "@commonfabric/schema-generator/property-optionality";
import { createPropertyName } from "../utils/identifiers.ts";

/**
 * Recovery of authored `Default<T, V>` values for type nodes rebuilt from
 * checker types.
 *
 * The checker cannot carry V: the conditional alias resolves away and the
 * literal V widens (`Default<string, "">` → `DefaultMarker<string>`), so any
 * type node rebuilt from a checker type silently loses the property's
 * `"default"` in injected schemas. The authored declaration — read in place,
 * never reused in output — is the only remaining source. These helpers find
 * that declaration, re-synthesize V as fresh literal nodes, and wrap rebuilt
 * nodes as `__cfHelpers.Default<rebuilt, V>`, the spelling the schema
 * pipeline already consumes for destructuring defaults.
 */

/**
 * The authored `Default<…>` reference on a type node, if any: directly, or as
 * a member of a top-level union (`boolean | Default<false>`). Deliberately
 * does NOT descend into type arguments of other references — a Default inside
 * `Writable<Default<…>>` belongs to the cell-like handling, not the leaf.
 */
function findAuthoredDefaultReference(
  node: ts.TypeNode,
  checker: ts.TypeChecker,
): ts.TypeReferenceNode | undefined {
  if (ts.isParenthesizedTypeNode(node)) {
    return findAuthoredDefaultReference(node.type, checker);
  }
  if (ts.isUnionTypeNode(node)) {
    for (const member of node.types) {
      const found = findAuthoredDefaultReference(member, checker);
      if (found) return found;
    }
    return undefined;
  }
  if (
    ts.isTypeReferenceNode(node) &&
    node.typeArguments && node.typeArguments.length > 0 &&
    node.pos >= 0
  ) {
    // Symbol-verified, NOT name-gated: a renamed import (`Default as D`)
    // must still graft, matching isDefaultTypeRef's symbol-resolution
    // behavior in regular input schemas. Resolve through import aliases —
    // at a use site the symbol is the ImportSpecifier in the using file,
    // not the api declaration.
    let symbol = checker.getSymbolAtLocation(node.typeName);
    if (symbol && (symbol.flags & ts.SymbolFlags.Alias) !== 0) {
      symbol = checker.getAliasedSymbol(symbol);
    }
    if (isDefaultAliasSymbol(symbol)) {
      return node;
    }
  }
  return undefined;
}

/**
 * Re-synthesize a default-VALUE type node as fresh synthetic literals, in the
 * style of `getStaticDefaultTypeNode` (destructuring-lowering.ts): authored
 * nodes can't be reused across source files — the printer slices the
 * DESTINATION file's text at the original positions — so the value is rebuilt
 * from its literal content. Returns undefined for anything that isn't
 * literal-shaped; the caller then simply grafts no default.
 */
function resynthesizeDefaultValueTypeNode(
  node: ts.TypeNode,
  factory: ts.NodeFactory,
  checker: ts.TypeChecker,
): ts.TypeNode | undefined {
  if (ts.isParenthesizedTypeNode(node)) {
    return resynthesizeDefaultValueTypeNode(node.type, factory, checker);
  }
  if (ts.isLiteralTypeNode(node)) {
    const literal = node.literal;
    if (ts.isStringLiteral(literal)) {
      return factory.createLiteralTypeNode(
        factory.createStringLiteral(literal.text),
      );
    }
    if (ts.isNumericLiteral(literal)) {
      return factory.createLiteralTypeNode(
        factory.createNumericLiteral(literal.text),
      );
    }
    if (
      ts.isPrefixUnaryExpression(literal) &&
      literal.operator === ts.SyntaxKind.MinusToken &&
      ts.isNumericLiteral(literal.operand)
    ) {
      return factory.createLiteralTypeNode(
        factory.createPrefixUnaryExpression(
          ts.SyntaxKind.MinusToken,
          factory.createNumericLiteral(literal.operand.text),
        ),
      );
    }
    switch (literal.kind) {
      case ts.SyntaxKind.TrueKeyword:
        return factory.createLiteralTypeNode(factory.createTrue());
      case ts.SyntaxKind.FalseKeyword:
        return factory.createLiteralTypeNode(factory.createFalse());
      case ts.SyntaxKind.NullKeyword:
        return factory.createLiteralTypeNode(factory.createNull());
      default:
        return undefined;
    }
  }
  if (node.kind === ts.SyntaxKind.UndefinedKeyword) {
    return factory.createKeywordTypeNode(ts.SyntaxKind.UndefinedKeyword);
  }
  if (ts.isTupleTypeNode(node)) {
    const elements: ts.TypeNode[] = [];
    for (const element of node.elements) {
      const synthesized = resynthesizeDefaultValueTypeNode(
        element,
        factory,
        checker,
      );
      if (!synthesized) return undefined;
      elements.push(synthesized);
    }
    return factory.createTupleTypeNode(elements);
  }
  if (ts.isTypeLiteralNode(node)) {
    const members: ts.TypeElement[] = [];
    for (const member of node.members) {
      if (!ts.isPropertySignature(member) || !member.type || !member.name) {
        return undefined;
      }
      const name = getPropertyNameText(member.name, checker);
      if (name === undefined) return undefined;
      const synthesized = resynthesizeDefaultValueTypeNode(
        member.type,
        factory,
        checker,
      );
      if (!synthesized) return undefined;
      members.push(
        factory.createPropertySignature(
          undefined,
          createPropertyName(name, factory),
          undefined,
          synthesized,
        ),
      );
    }
    return factory.createTypeLiteralNode(members);
  }
  return undefined;
}

/**
 * When a property symbol's AUTHORED declaration spells `Default<T, V>`,
 * recover V as fresh synthetic literal nodes.
 */
export function getAuthoredDefaultValueTypeNode(
  prop: ts.Symbol,
  factory: ts.NodeFactory,
  checker: ts.TypeChecker,
): ts.TypeNode | undefined {
  const declaration = prop.valueDeclaration ?? prop.declarations?.[0];
  if (
    !declaration ||
    !(ts.isPropertySignature(declaration) ||
      ts.isPropertyDeclaration(declaration)) ||
    !declaration.type
  ) {
    return undefined;
  }
  const reference = findAuthoredDefaultReference(declaration.type, checker);
  if (!reference?.typeArguments?.length) return undefined;
  // One-arg form `Default<V>` means V = T.
  const valueNode = reference.typeArguments[1] ?? reference.typeArguments[0];
  return valueNode
    ? resynthesizeDefaultValueTypeNode(valueNode, factory, checker)
    : undefined;
}

/**
 * When a property-access expression's resolved property declaration spells
 * `Default<T, V>`, recover V. Used for capture leaves that reach a property
 * through an access chain (`settings.note`) rather than a destructured
 * binding — the rebuilt leaf type node comes from the checker type and has
 * already lost the authored alias.
 */
export function getAuthoredDefaultValueForPropertyAccess(
  expr: ts.Expression,
  factory: ts.NodeFactory,
  checker: ts.TypeChecker,
): ts.TypeNode | undefined {
  if (!ts.isPropertyAccessExpression(expr)) return undefined;
  const symbol = checker.getSymbolAtLocation(expr.name);
  if (!symbol) return undefined;
  return getAuthoredDefaultValueTypeNode(symbol, factory, checker);
}

/**
 * Wrap a rebuilt type node as `__cfHelpers.Default<node, V>` — resolvable
 * regardless of the consumer file's imports.
 */
export function wrapTypeNodeWithDefault(
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
