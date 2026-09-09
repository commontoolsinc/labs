import { deepEqual } from "@commonfabric/utils/deep-equal";
import { FabricSpecialObject } from "./interface.ts";
import { valueEqual } from "./valueEqual.ts";

/**
 * Compares two values of unknown type for logical equality, the way
 * `deepEqual()` does, with every `FabricSpecialObject` the walk reaches
 * decided by `valueEqual()` rather than by its properties.
 *
 * This is the comparison for an operand allowed to hold a `FabricValue`
 * without being known to be one: a schema `const` against a stored value, a
 * schema default against a materialized one, a write against the value it
 * replaces, a request against the snapshot a policy was checked over. A
 * special object -- a byte sequence, a temporal value, a content hash, a
 * regular expression, an error, a link, a map, a set -- keeps its state in
 * private fields and has no enumerable own properties, so `deepEqual()` on its
 * own reads two distinct same-class ones as equal. `valueEqual()` is defined
 * over `FabricValue`s and throws on any other class instance, which these
 * operands still carry -- a `Cell`, a query-result proxy.
 *
 * Operands arrive unwrapped. A special object is recognized by `instanceof`,
 * which a proxy decides rather than the value behind it, so a proxy that does
 * not forward the test hides the special object from this comparison and two
 * distinct ones read as equal -- the answer this function exists to prevent.
 * One that does forward it reaches `valueEqual()`, which reads a private field
 * through the proxy and throws. `data-model` sits below whatever built the
 * proxy and cannot unwrap one, so this is the caller's to do.
 *
 * So the walk is the frame, and the model decides the values only it can
 * decide. A special object is one of those, whatever it sits inside: two of
 * one class are compared by logical content, and one paired with anything else
 * is unequal.
 *
 * Containers follow `deepEqual()` so the walk can compare ordinary class
 * instances alongside Fabric values. It stops at identical references but
 * carries no pair tracking: separate cyclic graphs exhaust its stack, and
 * shared acyclic graphs can require repeated work. For known `FabricValue`
 * graphs, `valueEqual()` tracks pairs and reuses available immutable hashes.
 *
 * A pair of one class that class cannot yet hash still throws, from
 * `valueEqual()`. `FabricMap` and `FabricSet` carry stub codecs, and a stub
 * naming itself is the answer that names the work.
 *
 * Container semantics remain those of `deepEqual()`: literal strings and
 * property names, constructor identity, and named array properties. In
 * contrast, `valueEqual()` follows canonical Fabric content semantics. It
 * equates null-prototype and ordinary records, normalizes nested text as
 * UTF-8, ignores named array properties, and can equate different instance
 * classes whose codecs preserve the same tag and state. This walk separates
 * special objects of different classes before consulting their codecs.
 *
 * This is the compare-side half of admitting special objects; the walk-side
 * half is `isKeyableObjectOrArray()`, with `isWalkableObjectOrArray()` the
 * same question for a walk that must refuse a `FabricInstance` rather than
 * report one as unreachable.
 */
export function fabricAwareEqual(a: unknown, b: unknown): boolean {
  return deepEqual(a, b, specialObjectEqual);
}

/**
 * Helper for {@link fabricAwareEqual}, deciding the object pairs in which
 * either side is a `FabricSpecialObject` and declining the rest.
 */
function specialObjectEqual(a: object, b: object): boolean | undefined {
  const aIsSpecial = a instanceof FabricSpecialObject;
  const bIsSpecial = b instanceof FabricSpecialObject;

  if (!(aIsSpecial || bIsSpecial)) return undefined;
  if (!(aIsSpecial && bIsSpecial)) return false;

  // Two classes settle the pair without either one's contents, and so without
  // asking a codec about either, including classes with stub codecs.
  if (a.constructor !== b.constructor) return false;

  return valueEqual(a, b);
}
