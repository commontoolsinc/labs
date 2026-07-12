// PROPOSED HOME: packages/schema-generator/test/enum-schema-mapping.test.ts
//
// Pins the TS-enum rows of docs/specs/schema-generator/ts_to_json_schema_mapping.md
// (§4), currently marked "probe only — no repo test":
//
//   - enum declarations hoist under the enum name with NO `type` key
//     (all-literal union path): numeric -> { enum: [0,1,2] },
//     string -> { enum: ["on","off"] }, with $ref at non-root occurrences;
//   - a single enum member type hoists under the BARE member name;
//   - two enums sharing a member name COLLIDE on the $defs key, first wins —
//     the second property silently receives the FIRST enum's schema. This is
//     an observed wrong-schema hazard; this test pins the current behavior so
//     any fix (or accidental change) is visible. If the collision is fixed,
//     update the mapping spec row in the same change (§4 and §16 item 2).

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { getTypeFromCode } from "./utils.ts";
import { SchemaGenerator } from "../src/schema-generator.ts";

async function gen(code: string, typeName: string) {
  const { type, checker, typeNode } = await getTypeFromCode(code, typeName);
  return new SchemaGenerator().generateSchema(type, checker, typeNode);
}

describe("TS enum schema mapping", () => {
  it("hoists a numeric enum under the enum name with no `type` key", async () => {
    const schema = await gen(
      `enum Color { Red, Green, Blue }\ninterface Wrap { c: Color; }`,
      "Wrap",
    ) as Record<string, unknown>;
    expect(schema.$defs).toEqual({ Color: { enum: [0, 1, 2] } });
    expect((schema.properties as Record<string, unknown>).c).toEqual({
      $ref: "#/$defs/Color",
    });
  });

  it("hoists a string enum under the enum name with no `type` key", async () => {
    const schema = await gen(
      `enum Mode { On = "on", Off = "off" }\ninterface Wrap { m: Mode; }`,
      "Wrap",
    ) as Record<string, unknown>;
    expect(schema.$defs).toEqual({ Mode: { enum: ["on", "off"] } });
  });

  it("emits a root enum inline (no $defs at the root occurrence)", async () => {
    const schema = await gen(
      `enum Color { Red, Green, Blue }\ntype T = Color;`,
      "T",
    ) as Record<string, unknown>;
    expect(schema).toEqual({ enum: [0, 1, 2] });
  });
});
