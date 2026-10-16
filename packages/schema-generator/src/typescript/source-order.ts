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
 * union for them (`writtenMappedKeys()`), and otherwise in the order of their
 * declarations, a property with neither after those with one, by name. Any
 * other type lists its own members as they are declared and then each base
 * type's properties, in the order its heritage clauses name them, and a base
 * can be a mapped type, as an interface extending an `Omit<…>` has: so each
 * run of consecutive properties declared in one place is put in the order of
 * their declarations there.
 */
export function propertiesInSourceOrder(
  type: ts.Type,
  properties: readonly ts.Symbol[],
  node: ts.TypeNode | undefined,
  checker: ts.TypeChecker,
): readonly ts.Symbol[] {
  const mapped = (type.flags & ts.TypeFlags.Object) !== 0 &&
    ((type as ts.ObjectType).objectFlags & ts.ObjectFlags.Mapped) !== 0;
  if (mapped) {
    const keys = writtenMappedKeys(node, checker);
    const rankOf = (property: ts.Symbol) =>
      keys?.get(property.getName()) ?? Number.POSITIVE_INFINITY;
    return [...properties].sort((left, right) =>
      rankOf(left) - rankOf(right) || compareByDeclaration(left, right)
    );
  }
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
 * The string keys `node` writes for the mapped type it denotes, each by its
 * place: the key union of a mapped type written in place, or the key argument
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
    const key = unwrapTypeParentheses(member);
    if (ts.isLiteralTypeNode(key) && ts.isStringLiteral(key.literal)) {
      if (!keys.has(key.literal.text)) keys.set(key.literal.text, keys.size);
    }
  }
  return keys;
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
 * literals by kind and value, then declared types — a TS enum's members as
 * they are declared in it, any other declared type by name and then by
 * declaration — and then every other type. Two instantiations of one
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
 * Compares two types the source declares: by the name of their symbol, then
 * by where that symbol is first declared. Two members of TS enums are
 * compared by where they are declared alone, so one enum's members keep their
 * declared order.
 */
function compareDeclaredTypes(left: ts.Type, right: ts.Type): number {
  const leftSymbol = left.getSymbol()!;
  const rightSymbol = right.getSymbol()!;
  const leftAt = declarationPlace(leftSymbol.declarations?.[0]);
  const rightAt = declarationPlace(rightSymbol.declarations?.[0]);
  const byPlace = compareStrings(leftAt?.file ?? "", rightAt?.file ?? "") ||
    (leftAt?.pos ?? 0) - (rightAt?.pos ?? 0);
  const enumMembers = (left.flags & right.flags & ts.TypeFlags.EnumLiteral) !==
    0;
  return enumMembers
    ? byPlace
    : compareStrings(leftSymbol.getName(), rightSymbol.getName()) || byPlace;
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
