/**
 * The schema type name for each primitive class, and the agreement among the
 * hand-maintained lists that name them.
 *
 * The mapping under test, the roster of classes that travel over the wire, and
 * the vocabulary the api package publishes all have to hold the same set, and
 * nothing derives any of them from another. So the check is exact membership
 * in both directions against a table this file writes out for itself, which is
 * what turns "a class was added and only one list was updated" into a failure
 * rather than a silent gap.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  FABRIC_PRIMITIVE_SCHEMA_TYPES,
  isFabricPrimitiveSchemaType,
} from "@commonfabric/api";

import type { FabricPrimitive } from "@/interface.ts";
import {
  BaseFabricPrimitive,
  codecClasses,
  FabricBytes,
  FabricEpochDays,
  FabricEpochNsec,
  FabricHash,
  FabricRegExp,
  schemaTypeOfFabricPrimitive,
} from "@/fabric-primitives/index.ts";

/**
 * One row per concrete primitive class: the constructor, an instance factory,
 * and the expected schema type name. This table is the test's own exhaustive
 * enumeration; the assertions below compare it against BOTH authoritative
 * lists (`codecClasses()` and `FABRIC_PRIMITIVE_SCHEMA_TYPES`) by exact
 * membership, so a class added to either list without a row here — or a row
 * whose instance `schemaTypeOfFabricPrimitive()` cannot map — fails rather
 * than slipping through on a length match.
 */
const CASES: readonly {
  ctor: unknown;
  make: () => FabricPrimitive;
  name: string;
}[] = [
  {
    ctor: FabricBytes,
    make: () => new FabricBytes(new Uint8Array([1])),
    name: "FabricBytes",
  },
  {
    ctor: FabricEpochDays,
    make: () => new FabricEpochDays(1n),
    name: "FabricEpochDays",
  },
  {
    ctor: FabricEpochNsec,
    make: () => new FabricEpochNsec(1n),
    name: "FabricEpochNsec",
  },
  {
    ctor: FabricHash,
    make: () => new FabricHash(new Uint8Array(32), "fid1"),
    name: "FabricHash",
  },
  {
    ctor: FabricRegExp,
    make: () => new FabricRegExp(/x/),
    name: "FabricRegExp",
  },
];

describe("schemaTypeOfFabricPrimitive()", () => {
  it("maps an instance of each primitive class to its schema type name", () => {
    for (const { make, name } of CASES) {
      expect(schemaTypeOfFabricPrimitive(make())).toBe(name);
    }
  });

  it("the case table exactly matches the codec-class list", () => {
    // Set equality by constructor identity, both directions: a codec class
    // without a table row (the production-throws case) fails here, as does a
    // stale row for a class no longer registered.
    const tableCtors = new Set<unknown>(CASES.map(({ ctor }) => ctor));
    expect(tableCtors.size).toBe(CASES.length);
    for (const cls of codecClasses()) {
      expect(tableCtors.has(cls)).toBe(true);
    }
    expect(codecClasses().length).toBe(CASES.length);
  });

  it("the case table exactly matches the api schema-type vocabulary", () => {
    const tableNames = new Set(CASES.map(({ name }) => name));
    expect(tableNames.size).toBe(CASES.length);
    for (const name of FABRIC_PRIMITIVE_SCHEMA_TYPES) {
      expect(tableNames.has(name)).toBe(true);
    }
    expect(FABRIC_PRIMITIVE_SCHEMA_TYPES.length).toBe(CASES.length);
  });

  it("throws on a FabricPrimitive subclass outside the mapping", () => {
    // Death before confusion: a primitive class that reaches the mapping
    // without a schema type name must fail loudly, not degrade to "object".
    class RogueFabricPrimitive extends BaseFabricPrimitive {}
    expect(() => schemaTypeOfFabricPrimitive(new RogueFabricPrimitive()))
      .toThrow(/RogueFabricPrimitive/);
  });

  it("isFabricPrimitiveSchemaType() accepts exactly the vocabulary", () => {
    for (const { name } of CASES) {
      expect(isFabricPrimitiveSchemaType(name)).toBe(true);
    }
    expect(isFabricPrimitiveSchemaType("object")).toBe(false);
    expect(isFabricPrimitiveSchemaType("FabricNope")).toBe(false);
  });
});
