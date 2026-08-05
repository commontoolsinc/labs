import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  FABRIC_PRIMITIVE_SCHEMA_TYPES,
  isFabricPrimitiveSchemaType,
} from "@commonfabric/api";

import {
  codecClasses,
  FabricBytes,
  FabricEpochDays,
  FabricEpochNsec,
  FabricHash,
  FabricRegExp,
  schemaTypeOfFabricPrimitive,
} from "@/fabric-primitives/index.ts";

describe("schemaTypeOfFabricPrimitive()", () => {
  it("maps each primitive class to its schema type name", () => {
    expect(schemaTypeOfFabricPrimitive(new FabricBytes(new Uint8Array([1]))))
      .toBe("FabricBytes");
    expect(schemaTypeOfFabricPrimitive(new FabricEpochDays(1n)))
      .toBe("FabricEpochDays");
    expect(schemaTypeOfFabricPrimitive(new FabricEpochNsec(1n)))
      .toBe("FabricEpochNsec");
    expect(
      schemaTypeOfFabricPrimitive(new FabricHash(new Uint8Array(32), "fid1")),
    ).toBe("FabricHash");
    expect(schemaTypeOfFabricPrimitive(new FabricRegExp(/x/)))
      .toBe("FabricRegExp");
  });

  it("covers every codec class, and every name is in the api vocabulary", () => {
    // The vocabulary in `@commonfabric/api` and the class list here must not
    // drift: one entry per codec class, each mapping to a distinct name the
    // api predicate recognizes.
    expect(FABRIC_PRIMITIVE_SCHEMA_TYPES.length).toBe(codecClasses().length);
    for (const name of FABRIC_PRIMITIVE_SCHEMA_TYPES) {
      expect(isFabricPrimitiveSchemaType(name)).toBe(true);
    }
    expect(isFabricPrimitiveSchemaType("object")).toBe(false);
    expect(isFabricPrimitiveSchemaType("FabricNope")).toBe(false);
  });
});
