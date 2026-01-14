import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import "@commontools/utils/equal-ignoring-symbols";
import { renameSchemaRefs } from "../src/schema-def-rename.ts";

describe("Schema $def Rename Support", () => {
  it("renames $defs and $refs", () => {
    // Example usage
    const exampleSchema = {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "$defs": {
        "Person": {
          "type": "object",
          "properties": {
            "name": { "type": "string" },
            "address": { "$ref": "#/$defs/Address" },
          },
        },
        "Address": {
          "type": "object",
          "properties": {
            "street": { "type": "string" },
            "city": { "type": "string" },
          },
        },
      },
      "type": "object",
      "properties": {
        "user": { "$ref": "#/$defs/Person" },
      },
    };

    const renameMap: Record<string, string> = {
      "Person": "User",
      "Address": "Location",
    };

    const renamedSchema = renameSchemaRefs(exampleSchema, renameMap);

    expect(renamedSchema).toEqual({
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "$defs": {
        "User": {
          "type": "object",
          "properties": {
            "name": { "type": "string" },
            "address": { "$ref": "#/$defs/Location" },
          },
        },
        "Location": {
          "type": "object",
          "properties": {
            "street": { "type": "string" },
            "city": { "type": "string" },
          },
        },
      },
      "type": "object",
      "properties": {
        "user": { "$ref": "#/$defs/User" },
      },
    });
  });
});
