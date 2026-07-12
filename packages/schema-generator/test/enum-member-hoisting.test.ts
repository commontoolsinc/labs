// Proposed location: packages/schema-generator/test/enum-member-hoisting.test.ts
//
// Pins TS enum handling (mapping spec §4) and the KNOWN BUG in spec §16.2:
// single enum-member types hoist into $defs under the BARE member name with
// no disambiguation, so two enums sharing a member name — or an enum member
// sharing a name with any other named type — collide on the $defs key.
// First definition wins; later occurrences emit a $ref to the WRONG schema
// (silently wrong values, or even a wrong shape), order-dependently.
//
// The collision expectations below pin today's corrupted output ON PURPOSE
// so a fix (e.g. qualifying member defs as `<Enum>.<Member>` or inlining
// member literals) flips them consciously.
import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { SchemaGenerator } from "../src/schema-generator.ts";
import { getTypeFromCode } from "./utils.ts";

async function generate(code: string, typeName: string) {
  const generator = new SchemaGenerator();
  const { type, checker, typeNode } = await getTypeFromCode(code, typeName);
  return generator.generateSchema(type, checker, typeNode);
}

describe("TS enum hoisting", () => {
  it("hoists whole enums under the enum name (no member defs)", async () => {
    const schema = await generate(
      `enum AlphaMode { On = "alpha-on", Off = "alpha-off" }
       enum BetaMode { On = "beta-on", Off = "beta-off" }
       interface State { a: AlphaMode; b: BetaMode; }`,
      "State",
    );
    expect(schema).toEqual({
      type: "object",
      properties: {
        a: { $ref: "#/$defs/AlphaMode" },
        b: { $ref: "#/$defs/BetaMode" },
      },
      required: ["a", "b"],
      $defs: {
        AlphaMode: { enum: ["alpha-on", "alpha-off"] },
        BetaMode: { enum: ["beta-on", "beta-off"] },
      },
    });
  });

  it("hoists a single enum-member type under the bare member name", async () => {
    const schema = await generate(
      `enum Mode { On = "on", Off = "off" }
       interface S { m: Mode.On; }`,
      "S",
    );
    expect(schema).toEqual({
      type: "object",
      properties: { m: { $ref: "#/$defs/On" } },
      required: ["m"],
      $defs: { On: { type: "string", enum: ["on"] } },
    });
  });

  it("KNOWN BUG §16.2: members of two enums sharing a name collide, first wins", async () => {
    const schema = await generate(
      `enum AlphaMode { On = "alpha-on", Off = "alpha-off" }
       enum BetaMode { On = "beta-on", Off = "beta-off" }
       interface State { a: AlphaMode.On; b: BetaMode.On; }`,
      "State",
    );
    // BUG pinned: property `b` (BetaMode.On, value "beta-on") $refs the
    // AlphaMode.On definition and would validate "alpha-on" instead.
    expect(schema).toEqual({
      type: "object",
      properties: {
        a: { $ref: "#/$defs/On" },
        b: { $ref: "#/$defs/On" },
      },
      required: ["a", "b"],
      $defs: { On: { type: "string", enum: ["alpha-on"] } },
    });
  });

  it("KNOWN BUG §16.2: an enum member colliding with an interface name steals its $ref", async () => {
    const schema = await generate(
      `enum E { Config = "e-config" }
       interface Config { url: string; }
       interface App { mode: E.Config; settings: Config; }`,
      "App",
    );
    // BUG pinned: `settings` (an object type) $refs the enum-member string
    // schema because the member was formatted first. Reversing property
    // order reverses the winner (order-dependent corruption).
    expect(schema).toEqual({
      type: "object",
      properties: {
        mode: { $ref: "#/$defs/Config" },
        settings: { $ref: "#/$defs/Config" },
      },
      required: ["mode", "settings"],
      $defs: { Config: { type: "string", enum: ["e-config"] } },
    });
  });
});
