/** Pins empty-record defaults in schemas emitted for pattern arguments. */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";
import { parseModule, patternSchemas } from "./transformed-ast.ts";
import { transformSource } from "./utils.ts";

describe("default-empty-record-schema", () => {
  for (const form of ["union member", "two arguments"]) {
    it(`emits empty object defaults for the ${form} form`, async () => {
      const defaults = {
        literal: "{}",
        stringKeys: "Record<string, never>",
        propertyKeys: "Record<PropertyKey, never>",
        alias: "EmptyRecord",
      };
      const properties = Object.entries(defaults).map(([name, value]) => {
        const type = form === "union member"
          ? `Record<string, unknown> | Default<${value}>`
          : `Default<Record<string, unknown>, ${value}>`;
        return `${name}: Writable<${type}>;`;
      }).join("\n");
      const output = await transformSource(
        `/// <cts-enable />
        import { Default, pattern, Writable } from "commonfabric";
        type EmptyRecord = Record<string, never>;
        interface Input { ${properties} }
        export default pattern<Input>((state) => ({
          literal: state.literal,
          stringKeys: state.stringKeys,
          propertyKeys: state.propertyKeys,
          alias: state.alias,
        }));
        `,
        { types: COMMONFABRIC_TYPES },
      );
      const { input } = patternSchemas(parseModule(output));
      const schemas = input.properties as Record<
        string,
        Record<string, unknown>
      >;

      for (const name of Object.keys(defaults)) {
        expect(schemas[name]).toMatchObject({
          type: "object",
          asCell: ["cell"],
        });
      }
      expect(Object.fromEntries(
        Object.keys(defaults).map((name) => [name, schemas[name]?.default]),
      )).toEqual(Object.fromEntries(
        Object.keys(defaults).map((name) => [name, {}]),
      ));
    });
  }
});
