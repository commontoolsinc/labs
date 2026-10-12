/**
 * Finds a recursion that instantiates its declaration without end, as
 * `Nest<T[]>` inside `Nest<T>` does, for a reading that writes out what it
 * reads: the schema generator's reading of a type under no type parameter
 * bindings, and the contract overlay of a handler's event and state
 * (`ts-transformers`). Such a reading ends a recursion where it meets a type it
 * has read already, which this one never does: each level is a new
 * instantiation. It keeps the types it is read within and asks
 * `expandsWithoutEnd()` before it descends further.
 *
 * The cut is small because what these readings read, they write: a reading
 * left to a depth bound alone writes out every level up to it. A cut that is
 * wrong, as it is for a chain that shrinks toward its end through one
 * declaration more than `MAX_EXPANDING_NESTING` times, leaves the remainder
 * reported as unread or, in the overlay, as written; it refuses nothing. The
 * writer-policy reading (`writer-policy.ts`) writes nothing out and can refuse
 * a schema on its answer, so it is bounded by depth and by count instead.
 */

import ts from "typescript";

/**
 * How many readings of one declaration, each instantiated after the one it is
 * read inside, may nest before the innermost is taken for a recursion that
 * instantiates the declaration without end (`expandsWithoutEnd()`). The
 * checker takes three for a recursion where its answer is only "maybe"; this
 * is set past the nesting data is written with and past the period of a
 * recursion that returns to a type it has read.
 */
export const MAX_EXPANDING_NESTING = 8;

/**
 * Whether `type`, read inside `path`, the types it is read within, outermost
 * first, is a recursion that instantiates its declaration without end, as
 * `Nest<T[]>` inside `Nest<T>` does: `MAX_EXPANDING_NESTING` readings of one
 * declaration, `type` among them, each instantiated after the last, as the ids
 * the checker numbers its types with in creation order show. A nesting its
 * author wrote out, `Pair<Pair<Pair<string>>>`, is instantiated from the
 * inside out, so its readings are not counted. The checker tells the two apart
 * the same way (`isDeeplyNestedType`).
 */
export const expandsWithoutEnd = (
  type: ts.Type,
  path: readonly ts.Type[],
  checker: ts.TypeChecker,
): boolean =>
  recursionIdentities(type, checker).some((identity) => {
    let count = 0;
    let lastId = 0;
    for (const outer of [...path, type]) {
      if (!recursionIdentities(outer, checker).includes(identity)) continue;
      const id = (outer as ts.Type & { id?: number }).id ?? 0;
      if (id >= lastId && ++count >= MAX_EXPANDING_NESTING) return true;
      lastId = id;
    }
    return false;
  });

/**
 * Whether `type` is a deferred reference: an array or a tuple a type alias
 * writes in its own recursion, as `[T, Tup<T[]>?]` in `type Tup<T> = …`,
 * which the checker instantiates from the node that writes it.
 */
export const isDeferredReference = (type: ts.Type): boolean =>
  ((type as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference) !== 0 &&
  (type as ObjectTypeWithInternals).node !== undefined;

/** A mapped type as the checker holds it once it resolves its members. */
type MappedTypeWithInternals = ts.ObjectType & {
  readonly modifiersType?: ts.Type;
};

/** An object type as the checker holds it: a deferred reference's node. */
type ObjectTypeWithInternals = ts.ObjectType & { readonly node?: ts.Node };

/**
 * The declarations `type`, an object type, is a reading of, as the checker
 * names them to find a recursion (`getRecursionIdentity`): an instantiated
 * mapped type reads the type it maps over where that type has a declaration
 * (`getMappedTargetWithSymbol`), so `DeepReadonly<T[K]>` inside
 * `DeepReadonly<T>` is a reading of `T[K]`, not of the mapped type again; a
 * deferred reference, as the tuple `[T, Tup<T[]>?]` an alias writes, reads the
 * node that writes it; and a type with a symbol reads its symbol. Each member
 * of an intersection is a reading of its own declarations. Any other array or
 * tuple is a reading of none: it recurses without end only through a
 * declaration or a deferred reference of its own, which is counted, and data
 * nests arrays of objects deeper than the cut.
 */
const recursionIdentities = (
  type: ts.Type,
  checker: ts.TypeChecker,
): readonly object[] => {
  const instantiatedMapped = ts.ObjectFlags.Mapped |
    ts.ObjectFlags.Instantiated;
  let read = type;
  while (
    ((read as ts.ObjectType).objectFlags & instantiatedMapped) ===
      instantiatedMapped
  ) {
    if (!(read as MappedTypeWithInternals).modifiersType) {
      checker.getPropertiesOfType(read);
    }
    const target = (read as MappedTypeWithInternals).modifiersType;
    if (
      !target ||
      !(target.symbol ||
        (target.isIntersection() && target.types.some((part) => part.symbol)))
    ) {
      break;
    }
    read = target;
  }
  if (read.isIntersection()) {
    return read.types.flatMap((part) => recursionIdentities(part, checker));
  }
  const objectFlags = (read as ts.ObjectType).objectFlags ?? 0;
  if (
    (read.flags & ts.TypeFlags.Object) === 0 ||
    (objectFlags & (ts.ObjectFlags.ObjectLiteral | ts.ObjectFlags.ArrayLiteral))
  ) {
    return [read];
  }
  const node = (read as ObjectTypeWithInternals).node;
  if ((objectFlags & ts.ObjectFlags.Reference) && node) return [node];
  if (checker.isArrayType(read) || checker.isTupleType(read)) return [];
  if (
    read.symbol &&
    !((objectFlags & ts.ObjectFlags.Anonymous) &&
      (read.symbol.flags & ts.SymbolFlags.Class))
  ) {
    return [read.symbol];
  }
  return [read];
};
