/**
 * Recognizes the carrier a CFC alias intersects its payload with: a member
 * holding the alias's labels under `__ct_cfc__` and nothing else
 * (`Cfc` in `packages/api/cfc.ts`). The checker drops an alias's name where it
 * reduces the alias's type, and then the carrier is all that says a value is
 * labelled.
 */

import ts from "typescript";

/**
 * The member a CFC metadata carrier holds. It is a phantom: no value holds it.
 */
export const CFC_CARRIER_PROPERTY = "__ct_cfc__";

/**
 * The `__ct_cfc__` member of `member` when that is all `member` holds: a CFC
 * metadata carrier, which a CFC alias intersects its payload with.
 */
export const cfcCarrierProperty = (
  member: ts.Type,
): ts.Symbol | undefined => {
  const properties = member.getProperties();
  return properties.length === 1 &&
      properties[0]!.name === CFC_CARRIER_PROPERTY
    ? properties[0]
    : undefined;
};

/**
 * Whether `member`, a member of an intersection, is a CFC carrier: the
 * `__ct_cfc__` member alone (`cfcCarrierProperty()`), or, while the payload is
 * a type parameter, the `CfcTag` conditional the checker defers it as, which
 * holds no part of the value. The deferred tag is recognized by its alias and
 * by the carrier member its branch writes.
 */
export const isCfcCarrierMember = (member: ts.Type): boolean => {
  if (cfcCarrierProperty(member)) return true;
  if ((member.flags & ts.TypeFlags.Conditional) === 0) return false;
  const declaration = member.aliasSymbol?.declarations?.find(
    ts.isTypeAliasDeclaration,
  );
  return declaration?.name.text === "CfcTag" &&
    ts.isConditionalTypeNode(declaration.type) &&
    writesCarrierMember(declaration.type.trueType);
};

/** Whether `node` writes the `__ct_cfc__` member, alone or in a union. */
const writesCarrierMember = (node: ts.TypeNode): boolean =>
  ts.isParenthesizedTypeNode(node)
    ? writesCarrierMember(node.type)
    : ts.isUnionTypeNode(node)
    ? node.types.some(writesCarrierMember)
    : ts.isTypeLiteralNode(node) &&
      node.members.some((member) =>
        ts.isPropertySignature(member) && ts.isIdentifier(member.name) &&
        member.name.text === CFC_CARRIER_PROPERTY
      );

/**
 * The type of the value `member` holds, given `type`, its type: `type` less
 * the `undefined` that an optional member's `?` adds.
 */
export function memberValueType(
  member: ts.Symbol,
  type: ts.Type,
  checker: ts.TypeChecker,
): ts.Type {
  if ((member.flags & ts.SymbolFlags.Optional) === 0 || !type.isUnion()) {
    return type;
  }
  // `getNonNullableType` also removes a `null`, which `?` does not add.
  return type.types.some((part) => (part.flags & ts.TypeFlags.Null) !== 0)
    ? type
    : checker.getNonNullableType(type);
}

/**
 * One policy a CFC carrier records: its metadata, and the payload it was
 * written around, where the carrier records one (`CfcStamp` in
 * `packages/api/cfc.ts`). A carrier that holds its metadata alone records
 * none.
 */
export type CarrierStamp = {
  readonly meta: ts.Type;
  readonly of: ts.Type | undefined;
};

/** The members a `CfcStamp` holds. */
const STAMP_MEMBER_NAMES: ReadonlySet<string> = new Set(["meta", "of"]);

/** Whether `type` is a `CfcStamp`: an object holding `meta`, and `of` at most besides. */
const isCarrierStamp = (type: ts.Type): boolean => {
  if ((type.flags & ts.TypeFlags.Object) === 0) return false;
  const names = type.getProperties().map((property) => property.name);
  return names.includes("meta") &&
    names.every((name) => STAMP_MEMBER_NAMES.has(name));
};

/**
 * The policies `value`, the type a carrier's `__ct_cfc__` holds, records. An
 * intersection or a mapped type folds several carriers into one, whose value
 * is then the intersection of what each held, and two spreads that may each
 * supply it make it their union; each member is a policy of its own.
 */
export const carrierStamps = (
  value: ts.Type,
  checker: ts.TypeChecker,
): CarrierStamp[] => {
  const parts = value.isIntersection() ||
      (value.isUnion() && value.types.every(isCarrierStamp))
    ? value.types
    : [value];
  return parts.map((part) => {
    if (!isCarrierStamp(part)) return { meta: part, of: undefined };
    const member = (name: string) => {
      const symbol = part.getProperty(name);
      return symbol &&
        memberValueType(symbol, checker.getTypeOfSymbol(symbol), checker);
    };
    // The payload is what the policy was written around, as written: only
    // the `undefined` its optional `?` adds is taken off, since the checker's
    // non-nullable form of a parameter `T` is `T & {}`, which no binding
    // names.
    const ofSymbol = part.getProperty("of");
    const of = ofSymbol && checker.getTypeOfSymbol(ofSymbol);
    const definedOf = of?.isUnion()
      ? of.types.filter((type) => (type.flags & ts.TypeFlags.Undefined) === 0)
      : undefined;
    return {
      meta: member("meta")!,
      of: definedOf?.length === 1 ? definedOf[0] : of,
    };
  });
};
