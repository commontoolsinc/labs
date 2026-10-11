/**
 * Recognizes a writer policy from a type alone: a CFC metadata carrier whose
 * metadata holds a `writeAuthorizedBy` or a `writePolicyAnyOf`. Only a
 * `typeof` node names a writer, so a type says that a value carries one but
 * never which.
 */

import ts from "typescript";

import {
  carrierStamps,
  cfcCarrierProperty,
  memberValueType,
} from "./cfc-carrier.ts";

/**
 * The writer policy `metadata`, a CFC carrier's metadata type, holds, by the
 * alias that writes it: a `writeAuthorizedBy` or a `writePolicyAnyOf`, whose
 * writers only `typeof` nodes name, so no reading of the type alone mints
 * them. `undefined` for metadata holding neither.
 */
export const writerPolicyHeldBy = (
  metadata: ts.Type,
  checker: ts.TypeChecker,
): "WriteAuthorizedBy" | "WritePolicyAnyOf" | undefined => {
  const value = checker.getNonNullableType(metadata);
  return value.getProperty("writePolicyAnyOf")
    ? "WritePolicyAnyOf"
    : value.getProperty("writeAuthorizedBy")
    ? "WriteAuthorizedBy"
    : undefined;
};

/** A writer policy, by the alias that writes it (`writerPolicyHeldBy()`). */
type WriterPolicyAlias = NonNullable<ReturnType<typeof writerPolicyHeldBy>>;

/** The first alias `read` gives for `items`, read in order. */
const firstWriterPolicy = <T>(
  items: readonly T[],
  read: (item: T) => WriterPolicyAlias | undefined,
): WriterPolicyAlias | undefined => {
  for (const item of items) {
    const alias = read(item);
    if (alias !== undefined) return alias;
  }
  return undefined;
};

/**
 * The writer policy `carrier`, a CFC carrier's `__ct_cfc__` member, records
 * among the policies it records (`carrierStamps()`), by the alias that writes
 * it: the first one it records, or `undefined` where it records none.
 */
const recordedWriterPolicy = (
  carrier: ts.Symbol,
  checker: ts.TypeChecker,
): WriterPolicyAlias | undefined =>
  firstWriterPolicy(
    carrierStamps(
      memberValueType(carrier, checker.getTypeOfSymbol(carrier), checker),
      checker,
    ),
    (stamp) => writerPolicyHeldBy(stamp.meta, checker),
  );

/**
 * Whether `type` itself carries a writer policy: a member of an intersection
 * that is a CFC carrier holding one, read through unions and intersections
 * but not into the values the type holds.
 */
export const carriesWriterPolicy = (
  type: ts.Type,
  checker: ts.TypeChecker,
): boolean =>
  type.isUnionOrIntersection() &&
  type.types.some((member) => {
    const carrier = cfcCarrierProperty(member);
    return carrier
      ? recordedWriterPolicy(carrier, checker) !== undefined
      : carriesWriterPolicy(member, checker);
  });

/**
 * The writer policy `type`, or a value it holds, carries, by the alias that
 * writes it: the first a reading finds, through unions, intersections, object
 * properties and index signatures, and array and tuple elements, or
 * `undefined` where none does. A carrier is a member of an intersection that
 * is a CFC carrier holding a policy. Each type is read once, which is what ends
 * the reading of a recursive type; no depth bound cuts it short, since one
 * would answer that a policy past it is absent. A function's signature, a
 * cell's methods among them, holds no value, and is not read.
 */
export const writerPolicyHeldWithin = (
  type: ts.Type,
  checker: ts.TypeChecker,
  seen: Set<ts.Type> = new Set(),
): WriterPolicyAlias | undefined => {
  if (seen.has(type)) return undefined;
  seen.add(type);
  const within = (inner: ts.Type) =>
    writerPolicyHeldWithin(inner, checker, seen);
  if (type.isUnionOrIntersection()) {
    return firstWriterPolicy(type.types, (member) => {
      const carrier = cfcCarrierProperty(member);
      return carrier ? recordedWriterPolicy(carrier, checker) : within(member);
    });
  }
  if ((type.flags & ts.TypeFlags.Object) === 0) return undefined;
  if (checker.isArrayType(type) || checker.isTupleType(type)) {
    return firstWriterPolicy(
      checker.getTypeArguments(type as ts.TypeReference),
      within,
    );
  }
  if (type.getCallSignatures().length > 0) return undefined;
  return firstWriterPolicy(
    type.getProperties(),
    (property) => within(checker.getTypeOfSymbol(property)),
  ) ??
    firstWriterPolicy(
      checker.getIndexInfosOfType(type),
      (info) => within(info.type),
    );
};

/**
 * Whether `type`, or a value it holds, carries a writer policy
 * (`writerPolicyHeldWithin()`).
 */
export const holdsWriterPolicy = (
  type: ts.Type,
  checker: ts.TypeChecker,
): boolean => writerPolicyHeldWithin(type, checker) !== undefined;
