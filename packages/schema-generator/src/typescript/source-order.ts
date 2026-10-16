/**
 * The order a schema lists what TypeScript holds without an order of its own:
 * a union's members, and a mapped type's properties.
 *
 * The checker keeps a union's members sorted by the order it created their
 * types in, and a mapped type over a union of keys enumerates its properties
 * in that order too. For most types that order belongs to the program rather
 * than to the source: a literal, an object type, an instantiation is created
 * the first time anything in the program mentions it, so one module compiled
 * inside two programs lists the same union two ways. A module's pattern
 * identity hashes its source alone, so both listings would run under one
 * identity, and anything keyed on the schema would split between them.
 *
 * The checker's intrinsic types — `string`, `number`, `undefined`, `null`,
 * `true`, `false` and the rest — are the exception. It creates them before it
 * reads any source, always in the same order, so their place in a union is
 * the same in every program, ahead of every other member. They keep it here.
 * Every other member is put in an order read from the source: the order a
 * union is written in where the source writes one, and otherwise the order
 * `compareTypesBySource()` gives.
 */

import ts from "typescript";

import {
  getTypeAliasDeclaration,
  readUnionMemberNodes,
  unwrapTypeParentheses,
} from "./type-node.ts";

/**
 * Whether `node` is written in a source file, so that the order of what it
 * lists is the source's. A node a transform builds, as ts-transformers builds
 * one for an inferred type from the checker's type, lists a union's members
 * in the checker's order, and is not.
 */
export function isWrittenNode(node: ts.Node): boolean {
  return node.pos >= 0 && (node.flags & ts.NodeFlags.Synthesized) === 0;
}

/**
 * `items`, a union's members or what stands for them in the checker's order,
 * in source order: the items whose types are intrinsic first, as they came,
 * then those `rankOf` places, by their rank, and then the rest, in the order
 * `compareTypesBySource()` gives their types. Items of one rank are ordered
 * by their types the same way, as the members a `boolean` written in a union
 * stands for are. Items whose types the comparison cannot tell apart keep the
 * order they came in.
 */
export function inSourceOrder<T>(
  items: readonly T[],
  typeOf: (item: T) => ts.Type,
  rankOf: (item: T) => number | undefined = () => undefined,
): T[] {
  const intrinsic = items.filter((item) => isIntrinsic(typeOf(item)));
  const ranked = items
    .filter((item) => !isIntrinsic(typeOf(item)))
    .map((item) => ({
      item,
      rank: rankOf(item) ?? Number.POSITIVE_INFINITY,
    }));
  ranked.sort((left, right) =>
    left.rank !== right.rank
      ? left.rank - right.rank
      : compareTypesBySource(typeOf(left.item), typeOf(right.item))
  );
  return [...intrinsic, ...ranked.map(({ item }) => item)];
}

/**
 * `properties`, the checker's properties of `type`, in source order, `node`
 * being the node `type` is read at, if any.
 *
 * A mapped type's properties follow the union of keys it maps over, so they
 * are put in the order `node` writes their keys in, where it writes a key
 * union for them (`writtenMappedKeys()`); else in the source order of the
 * type it maps, as `Omit<T, K>` maps `T` (`mappedSourceOrder()`); else in the
 * order of their declarations, a property with neither after those with one,
 * by name.
 *
 * An interface or a class without type parameters lists its own members as
 * the checker lists them, and then each base type's properties, base by base
 * in the order its heritage clauses name them, each base's in its own source
 * order: a base can be a mapped type, as an `Omit<…>` is, whose checker
 * order is its key union's (`inheritedSourceOrder()`). Any other type keeps
 * the checker's order between declarations and orders each run of
 * consecutive properties declared in one place by their declarations, as
 * does a type met again while its own order is being read, as
 * `interface Wrap extends Empty<Wrap>` meets `Wrap`.
 */
export function propertiesInSourceOrder(
  type: ts.Type,
  properties: readonly ts.Symbol[],
  node: ts.TypeNode | undefined,
  checker: ts.TypeChecker,
): readonly ts.Symbol[] {
  return orderProperties(type, properties, node, checker, new Set());
}

/**
 * `propertiesInSourceOrder()`, `entered` holding the types whose order is
 * being read further up, which are not followed into again.
 */
function orderProperties(
  type: ts.Type,
  properties: readonly ts.Symbol[],
  node: ts.TypeNode | undefined,
  checker: ts.TypeChecker,
  entered: ReadonlySet<ts.Type>,
): readonly ts.Symbol[] {
  if (properties.length <= 1) return properties;
  const reentered = entered.has(type);
  const inside = new Set(entered).add(type);
  const mapped = (type.flags & ts.TypeFlags.Object) !== 0 &&
    ((type as ts.ObjectType).objectFlags & ts.ObjectFlags.Mapped) !== 0;
  if (mapped) {
    const keys = writtenMappedKeys(node, checker) ??
      (reentered
        ? undefined
        : mappedSourceOrder(type, properties, checker, inside));
    const rankOf = (property: ts.Symbol) =>
      keys?.get(property.getName()) ?? Number.POSITIVE_INFINITY;
    return [...properties].sort((left, right) =>
      rankOf(left) - rankOf(right) || compareByDeclaration(left, right)
    );
  }
  const inherited = reentered
    ? undefined
    : inheritedSourceOrder(type, properties, checker, inside);
  if (inherited !== undefined) return inherited;
  const ordered: ts.Symbol[] = [];
  let run: ts.Symbol[] = [];
  let runParent: ts.Node | undefined;
  const flush = () => {
    for (const property of run.sort(compareByDeclaration)) {
      ordered.push(property);
    }
    run = [];
  };
  for (const property of properties) {
    const parent = property.declarations?.[0]?.parent;
    if (parent === undefined || parent !== runParent) flush();
    run.push(property);
    runParent = parent;
  }
  flush();
  return ordered;
}

/**
 * The properties of `type`, an interface or a class without type
 * parameters, in source order: its own members as the checker lists them,
 * then each base type's properties in turn, in the base's own source order,
 * a property already placed not placed again, each base read past the
 * types in `entered` (`orderProperties()`). Returns `undefined` for any
 * other type. Base types are read only once the checker has resolved them,
 * as it has for a type whose properties it listed, so nothing is created.
 */
function inheritedSourceOrder(
  type: ts.Type,
  properties: readonly ts.Symbol[],
  checker: ts.TypeChecker,
  entered: ReadonlySet<ts.Type>,
): readonly ts.Symbol[] | undefined {
  if (
    !type.isClassOrInterface() ||
    (type as ts.InterfaceType).typeParameters?.length
  ) {
    return undefined;
  }
  const bases = checker.getBaseTypes(type);
  if (bases.length === 0) return undefined;
  const byName = new Map(properties.map((property) => [
    property.getName(),
    property,
  ]));
  const ordered: ts.Symbol[] = [];
  const place = (name: string) => {
    const property = byName.get(name);
    if (property === undefined) return;
    byName.delete(name);
    ordered.push(property);
  };
  const own = new Set<ts.Node>(type.getSymbol()?.declarations ?? []);
  for (const property of properties) {
    const declaration = property.declarations?.[0];
    if (declaration !== undefined && own.has(memberOwner(declaration))) {
      place(property.getName());
    }
  }
  for (const base of bases) {
    const baseProperties = checker.getPropertiesOfType(base);
    for (
      const property of orderProperties(
        base,
        baseProperties,
        undefined,
        checker,
        entered,
      )
    ) {
      place(property.getName());
    }
  }
  for (const property of properties) place(property.getName());
  return ordered;
}

/**
 * The class or interface declaration that declares the member `declaration`:
 * its parent, or for a constructor's parameter property the class the
 * constructor belongs to.
 */
function memberOwner(declaration: ts.Declaration): ts.Node {
  const parent = declaration.parent;
  return ts.isParameter(declaration) && ts.isConstructorDeclaration(parent)
    ? parent.parent
    : parent;
}

/**
 * The places, by property name, of the properties of the type a mapped type
 * maps, as `Omit<T, K>` and `Pick<T, K>` map `T`, in that type's source
 * order (`orderProperties()`, past the types in `entered`): the first type
 * argument of the alias `type` is read through, where `type` has properties
 * and every one is one of its, declared where its namesake there is
 * declared. The checker links a
 * property to the declaration it maps only for a mapped type that maps
 * another's properties, so a mapped type over keys of its own, as
 * `{ [P in "a" | "b"]: T }` is, does not qualify. Returns `undefined`
 * otherwise.
 */
function mappedSourceOrder(
  type: ts.Type,
  properties: readonly ts.Symbol[],
  checker: ts.TypeChecker,
  entered: ReadonlySet<ts.Type>,
): Map<string, number> | undefined {
  const source = type.aliasTypeArguments?.[0];
  if (
    properties.length === 0 || source === undefined ||
    (source.flags & ts.TypeFlags.Object) === 0
  ) {
    return undefined;
  }
  const sourceProperties = checker.getPropertiesOfType(source);
  const declarations = new Map(sourceProperties.map((property) => [
    property.getName(),
    property.declarations?.[0],
  ]));
  const mapsSource = properties.every((property) => {
    const declaration = property.declarations?.[0];
    return declaration !== undefined &&
      declarations.get(property.getName()) === declaration;
  });
  if (!mapsSource) return undefined;
  const places = new Map<string, number>();
  for (
    const property of orderProperties(
      source,
      sourceProperties,
      undefined,
      checker,
      entered,
    )
  ) {
    places.set(property.getName(), places.size);
  }
  return places;
}

/**
 * The keys `node` writes for the mapped type it denotes, by the names of the
 * properties they make (`propertyNameOfKey()`), each by its place: the key union of a mapped type written in place, or the key argument
 * a reference passes to an alias of one, as `Record<"b" | "a", V>` passes
 * `"b" | "a"`. Returns `undefined` where `node` writes no key union, as it
 * does for an alias whose mapped type does not map over a parameter of its
 * own, or where a transform built `node`.
 */
function writtenMappedKeys(
  node: ts.TypeNode | undefined,
  checker: ts.TypeChecker,
): Map<string, number> | undefined {
  if (node === undefined || !isWrittenNode(node)) return undefined;
  const written = unwrapTypeParentheses(node);
  let keyNode: ts.TypeNode | undefined;
  if (ts.isMappedTypeNode(written)) {
    keyNode = written.typeParameter.constraint;
  } else if (ts.isTypeReferenceNode(written) && written.typeArguments) {
    keyNode = aliasKeyArgument(written, checker);
  }
  if (keyNode === undefined) return undefined;
  const keys = new Map<string, number>();
  for (const member of readUnionMemberNodes(keyNode, checker)) {
    const name = propertyNameOfKey(unwrapTypeParentheses(member));
    if (name !== undefined && !keys.has(name)) keys.set(name, keys.size);
  }
  return keys;
}

/**
 * The property name the literal key `key` writes, as the checker names the
 * property a mapped type makes for it: a string as written, a number in its
 * canonical form (`1.0` names `"1"`, `-1` names `"-1"`). Returns `undefined`
 * for any other key.
 */
function propertyNameOfKey(key: ts.TypeNode): string | undefined {
  if (!ts.isLiteralTypeNode(key)) return undefined;
  const { literal } = key;
  if (ts.isStringLiteral(literal)) return literal.text;
  if (ts.isNumericLiteral(literal)) return String(Number(literal.text));
  if (
    ts.isPrefixUnaryExpression(literal) &&
    literal.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(literal.operand)
  ) {
    return String(-Number(literal.operand.text));
  }
  return undefined;
}

/**
 * The type argument `reference` passes for the keys of the mapped type its
 * alias is written as, or `undefined` where the alias is no mapped type, or
 * maps over keys that are not a parameter of its own.
 */
function aliasKeyArgument(
  reference: ts.TypeReferenceNode,
  checker: ts.TypeChecker,
): ts.TypeNode | undefined {
  const alias = getTypeAliasDeclaration(reference, checker);
  if (alias === undefined) return undefined;
  const aliased = unwrapTypeParentheses(alias.type);
  if (!ts.isMappedTypeNode(aliased)) return undefined;
  const constraint = aliased.typeParameter.constraint;
  if (
    constraint === undefined || !ts.isTypeReferenceNode(constraint) ||
    !ts.isIdentifier(constraint.typeName)
  ) {
    return undefined;
  }
  const name = constraint.typeName.text;
  const index =
    alias.typeParameters?.findIndex((parameter) =>
      parameter.name.text === name
    ) ?? -1;
  return index < 0 ? undefined : reference.typeArguments?.[index];
}

/**
 * An order on types that reads only what the source states about them, never
 * the order the checker created them in: intrinsic types by name, then
 * literals by kind and value, then declared types (`compareDeclaredTypes()`:
 * by name and declaration, a TS enum's members together, as the enum
 * declares them) — and then every other type. Two instantiations of one
 * declaration, and two types neither declared nor literal, compare equal.
 *
 * It reads a type's flags, value, and symbol, and nothing the checker would
 * have to create: resolving a type's arguments, or printing it, can create
 * types, and the generator's recursion bounds read how old a type is
 * (`expanding-recursion.ts`), so a comparison that created one would move
 * where they cut.
 */
export function compareTypesBySource(left: ts.Type, right: ts.Type): number {
  if (left === right) return 0;
  const leftTier = tierOf(left);
  const rightTier = tierOf(right);
  if (leftTier !== rightTier) return leftTier - rightTier;
  switch (leftTier) {
    case Tier.Intrinsic:
      return compareStrings(intrinsicName(left), intrinsicName(right));
    case Tier.NumberLiteral:
      return (left as ts.NumberLiteralType).value -
        (right as ts.NumberLiteralType).value;
    case Tier.BigIntLiteral:
      return compareBigInts(
        (left as ts.BigIntLiteralType).value,
        (right as ts.BigIntLiteralType).value,
      );
    case Tier.StringLiteral:
      return compareStrings(
        (left as ts.StringLiteralType).value,
        (right as ts.StringLiteralType).value,
      );
    case Tier.Declared:
      return compareDeclaredTypes(left, right);
    default:
      return 0;
  }
}

/** The tiers `compareTypesBySource()` orders types into, in its order. */
enum Tier {
  Intrinsic,
  NumberLiteral,
  BigIntLiteral,
  StringLiteral,
  Declared,
  Other,
}

/** The tier of `compareTypesBySource()` that `type` falls in. */
function tierOf(type: ts.Type): Tier {
  const { flags } = type;
  if (isIntrinsic(type)) return Tier.Intrinsic;
  // A TS enum's member is ordered by where its enum declares it.
  if (flags & ts.TypeFlags.EnumLiteral) return Tier.Declared;
  if (flags & ts.TypeFlags.NumberLiteral) return Tier.NumberLiteral;
  if (flags & ts.TypeFlags.BigIntLiteral) return Tier.BigIntLiteral;
  if (flags & ts.TypeFlags.StringLiteral) return Tier.StringLiteral;
  if ((type.getSymbol()?.declarations?.length ?? 0) > 0) return Tier.Declared;
  return Tier.Other;
}

/**
 * Compares two types the source declares, by one key for every pair, so the
 * order is transitive: the group a type belongs to, by the group's name and
 * then where it is declared, and then where in its group the type is
 * declared. A TS enum's member belongs to its enum, so one enum's members
 * stay together in the order the enum declares them; any other declared
 * type is a group of its own, its symbol's.
 */
function compareDeclaredTypes(left: ts.Type, right: ts.Type): number {
  const leftKey = declaredKey(left);
  const rightKey = declaredKey(right);
  return compareStrings(leftKey.name, rightKey.name) ||
    compareStrings(leftKey.file, rightKey.file) ||
    leftKey.pos - rightKey.pos ||
    leftKey.memberPos - rightKey.memberPos;
}

/**
 * The key `compareDeclaredTypes()` orders a declared type by: its group's
 * name, file and position, and the type's position in the group (`0` for a
 * type that is its own group).
 */
function declaredKey(
  type: ts.Type,
): { name: string; file: string; pos: number; memberPos: number } {
  const symbol = type.getSymbol()!;
  const declaration = symbol.declarations?.[0];
  if (
    (type.flags & ts.TypeFlags.EnumLiteral) !== 0 &&
    declaration !== undefined && ts.isEnumMember(declaration)
  ) {
    const owner = declaration.parent;
    const at = declarationPlace(owner);
    return {
      name: owner.name.text,
      file: at?.file ?? "",
      pos: at?.pos ?? 0,
      memberPos: declaration.pos,
    };
  }
  const at = declarationPlace(declaration);
  return {
    name: symbol.getName(),
    file: at?.file ?? "",
    pos: at?.pos ?? 0,
    memberPos: 0,
  };
}

/**
 * Compares two properties by where they are first declared, in the order the
 * checker lists one declaration's members in: by file, then the members it
 * binds first before those it binds late (`isLateBound()`), each by
 * position; then by name. A property with no declaration comes after one
 * with any.
 */
function compareByDeclaration(left: ts.Symbol, right: ts.Symbol): number {
  const leftDeclaration = left.declarations?.[0];
  const rightDeclaration = right.declarations?.[0];
  const leftAt = declarationPlace(leftDeclaration);
  const rightAt = declarationPlace(rightDeclaration);
  if (leftAt === undefined || rightAt === undefined) {
    if (leftAt !== rightAt) return leftAt === undefined ? 1 : -1;
    return compareStrings(left.getName(), right.getName());
  }
  return compareStrings(leftAt.file, rightAt.file) ||
    Number(isLateBound(leftDeclaration!)) -
      Number(isLateBound(rightDeclaration!)) ||
    leftAt.pos - rightAt.pos ||
    compareStrings(left.getName(), right.getName());
}

/**
 * Whether the checker binds `declaration`'s member after the declaration's
 * other members: a member of an interface, a class, or a type literal named
 * by a computed expression. An object literal's members are bound in the
 * order they are written, computed ones included.
 */
function isLateBound(declaration: ts.Declaration): boolean {
  const name = ts.getNameOfDeclaration(declaration);
  return name !== undefined && ts.isComputedPropertyName(name) &&
    !ts.isObjectLiteralExpression(declaration.parent);
}

/** Where `declaration` sits: its file's name and its position in it. */
function declarationPlace(
  declaration: ts.Declaration | undefined,
): { file: string; pos: number } | undefined {
  if (declaration === undefined) return undefined;
  return { file: declaration.getSourceFile().fileName, pos: declaration.pos };
}

/**
 * Whether `type` is one of the checker's intrinsic types, which it creates
 * before reading any source, in the same order in every program.
 */
function isIntrinsic(type: ts.Type): boolean {
  return intrinsicName(type) !== "";
}

/** The checker's name for an intrinsic type, or `""` for any other type. */
function intrinsicName(type: ts.Type): string {
  return (type as { intrinsicName?: string }).intrinsicName ?? "";
}

/** Compares two strings by their UTF-16 code units, as `<` does. */
function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Compares two bigint literal values. */
function compareBigInts(
  left: ts.PseudoBigInt,
  right: ts.PseudoBigInt,
): number {
  const leftValue = BigInt(`${left.negative ? "-" : ""}${left.base10Value}`);
  const rightValue = BigInt(`${right.negative ? "-" : ""}${right.base10Value}`);
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}
