import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import type { JSONSchema } from "@commonfabric/api";
import {
  unboundedSchemaPosition,
  unboundedSchemaPositionMessage,
} from "../src/schema-read-bound.ts";

describe("schema-read-bound", () => {
  describe("unboundedSchemaPosition()", () => {
    it("returns `undefined` for no schema", () => {
      expect(unboundedSchemaPosition(undefined)).toBeUndefined();
    });

    it("returns `undefined` for a schema whose every object position names its properties", () => {
      expect(unboundedSchemaPosition({
        type: "object",
        properties: {
          total: { type: "number" },
          rows: {
            type: "array",
            items: {
              type: "object",
              properties: { name: { type: "string" } },
            },
          },
        },
      })).toBeUndefined();
    });

    it("returns the root position for the empty schema", () => {
      expect(unboundedSchemaPosition({})).toEqual({
        pointer: "",
        reason: "open-object",
      });
    });

    it("returns the root position for the `true` schema", () => {
      expect(unboundedSchemaPosition(true)).toEqual({
        pointer: "",
        reason: "open-object",
      });
    });

    it("returns `undefined` for the `false` schema", () => {
      expect(unboundedSchemaPosition(false)).toBeUndefined();
    });

    it("returns the position of an `object` declaring no properties", () => {
      // The shape a TypeScript `value: object` compiles to, nested where the
      // console's stalling run had it: an entry list whose value position is
      // the whole of whatever the entry holds.

      expect(unboundedSchemaPosition({
        type: "object",
        properties: {
          entries: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                value: { type: "object" },
              },
            },
          },
        },
      })).toEqual({
        pointer: "/properties/entries/items/properties/value",
        reason: "open-object",
      });
    });

    it("returns the position of an explicit `additionalProperties: true`", () => {
      expect(unboundedSchemaPosition({
        type: "object",
        properties: { piece: { type: "string" } },
        additionalProperties: true,
      })).toEqual({ pointer: "", reason: "open-object" });
    });

    it("returns `undefined` for properties with `additionalProperties` unset", () => {
      // The traverser descends only the named properties in this case, so the
      // position is closed even though the value may carry more keys.

      expect(unboundedSchemaPosition({
        type: "object",
        properties: { piece: { type: "string" } },
      })).toBeUndefined();
    });

    it("returns `undefined` for an `additionalProperties` schema that names its own properties", () => {
      expect(unboundedSchemaPosition({
        type: "object",
        additionalProperties: {
          type: "object",
          properties: { count: { type: "number" } },
        },
      })).toBeUndefined();
    });

    it("returns the position inside an open `additionalProperties` schema", () => {
      expect(unboundedSchemaPosition({
        type: "object",
        additionalProperties: { type: "object" },
      })).toEqual({
        pointer: "/additionalProperties",
        reason: "open-object",
      });
    });

    it("returns `undefined` for a typed position that cannot hold an object", () => {
      expect(unboundedSchemaPosition({
        type: "object",
        properties: { note: { type: "string" }, count: { type: "number" } },
      })).toBeUndefined();
    });

    it("returns the position of an untyped property", () => {
      expect(unboundedSchemaPosition({
        type: "object",
        properties: { note: { description: "anything at all" } },
      })).toEqual({
        pointer: "/properties/note",
        reason: "open-object",
      });
    });

    it("returns `undefined` for a union that excludes `object`", () => {
      expect(unboundedSchemaPosition({
        type: "object",
        properties: { note: { type: ["string", "null"] } },
      })).toBeUndefined();
    });

    it("returns the position of a union admitting `object`", () => {
      expect(unboundedSchemaPosition({
        type: "object",
        properties: { note: { type: ["string", "object"] } },
      })).toEqual({
        pointer: "/properties/note",
        reason: "open-object",
      });
    });

    it("returns `undefined` for a combinator whose arms each close the position", () => {
      expect(unboundedSchemaPosition({
        anyOf: [
          { type: "object", properties: { a: { type: "number" } } },
          { type: "object", properties: { b: { type: "number" } } },
        ],
      })).toBeUndefined();
    });

    it("returns the position of the open arm of a combinator", () => {
      expect(unboundedSchemaPosition({
        anyOf: [
          { type: "object", properties: { a: { type: "number" } } },
          { type: "object" },
        ],
      })).toEqual({ pointer: "/anyOf/1", reason: "open-object" });
    });

    it("returns the position of an open object inside a `$defs` body", () => {
      expect(unboundedSchemaPosition({
        type: "object",
        properties: { piece: { $ref: "#/$defs/piece" } },
        $defs: { piece: { type: "object" } },
      })).toEqual({ pointer: "/$defs/piece", reason: "open-object" });
    });

    it("returns `undefined` for a `$ref` chain that terminates", () => {
      expect(unboundedSchemaPosition({
        type: "object",
        properties: { piece: { $ref: "#/$defs/piece" } },
        $defs: {
          piece: {
            type: "object",
            properties: { name: { $ref: "#/$defs/name" } },
          },
          name: { type: "string" },
        },
      })).toBeUndefined();
    });

    it("returns the reference site for a self-referential `$ref`", () => {
      expect(unboundedSchemaPosition({
        type: "object",
        properties: { piece: { $ref: "#/$defs/piece" } },
        $defs: {
          piece: {
            type: "object",
            properties: { mentioned: { $ref: "#/$defs/piece" } },
          },
        },
      })).toEqual({
        pointer: "/properties/piece",
        reason: "recursive-ref",
        ref: "#/$defs/piece",
      });
    });

    it("returns the definition entered twice for a mutually recursive pair", () => {
      // The registry shape that stalled the console: `mentioned` and
      // `backlinks` both refer back through the piece array.

      expect(unboundedSchemaPosition({
        type: "object",
        properties: { pieces: { $ref: "#/$defs/pieceList" } },
        $defs: {
          pieceList: {
            type: "array",
            items: { $ref: "#/$defs/piece" },
          },
          piece: {
            type: "object",
            properties: {
              backlinks: { $ref: "#/$defs/pieceList" },
            },
          },
        },
      })).toEqual({
        pointer: "/properties/pieces",
        reason: "recursive-ref",
        ref: "#/$defs/pieceList",
      });
    });

    it("returns `undefined` for a definition two siblings share", () => {
      // A diamond is not a cycle: both properties reach `name`, and neither
      // reaches anything that reaches back.

      expect(unboundedSchemaPosition({
        type: "object",
        properties: {
          first: { $ref: "#/$defs/name" },
          second: { $ref: "#/$defs/name" },
        },
        $defs: { name: { type: "string" } },
      })).toBeUndefined();
    });

    it("returns `undefined` for a `$ref` naming no declared definition", () => {
      // An unresolved reference drives no read of its own, and what the
      // traverser does with it is not this check's claim to make.

      expect(unboundedSchemaPosition({
        type: "object",
        properties: { piece: { $ref: "#/$defs/absent" } },
        $defs: { present: { type: "string" } },
      })).toBeUndefined();
    });

    it("returns `undefined` for a recursive reference into an external schema", () => {
      expect(unboundedSchemaPosition({
        type: "object",
        properties: { piece: { $ref: "https://example.test/piece#" } },
      })).toBeUndefined();
    });

    it("resolves a percent-encoded reference to the definition it names", () => {
      // A `$ref` is a URI, so the fragment is decoded before the pointer is
      // split: `%2F` is a separator and `~1` is the name's own slash.

      expect(unboundedSchemaPosition({
        type: "object",
        properties: { piece: { $ref: "#%2F$defs%2Fa~1b" } },
        $defs: {
          "a/b": {
            type: "object",
            properties: { next: { $ref: "#/$defs/a~1b" } },
          },
        },
      })).toEqual({
        pointer: "/properties/piece",
        reason: "recursive-ref",
        ref: "#/$defs/a/b",
      });
    });

    it("reports a recursive `$ref` ahead of an open object", () => {
      // Both are present; the cycle is the one named, so the message a caller
      // gets is about one position at a time.

      expect(
        unboundedSchemaPosition({
          type: "object",
          properties: {
            open: { type: "object" },
            piece: { $ref: "#/$defs/piece" },
          },
          $defs: {
            piece: {
              type: "object",
              properties: { next: { $ref: "#/$defs/piece" } },
            },
          },
        })?.reason,
      ).toBe("recursive-ref");
    });

    it("escapes a property name carrying a pointer separator", () => {
      expect(unboundedSchemaPosition({
        type: "object",
        properties: { "a/b~c": { type: "object" } },
      })).toEqual({
        pointer: "/properties/a~1b~0c",
        reason: "open-object",
      });
    });
  });

  describe("unboundedSchemaPositionMessage()", () => {
    it("names the label, the pointer and what closing the position takes", () => {
      const message = unboundedSchemaPositionMessage(
        "run_pattern resultSchema",
        {
          pointer: "/properties/value",
          reason: "open-object",
        },
      );
      expect(message).toContain("run_pattern resultSchema");
      expect(message).toContain("`/properties/value`");
      expect(message).toContain("Declare the properties you need");
    });

    it("says the position is the root when the pointer is empty", () => {
      expect(unboundedSchemaPositionMessage("run_pattern resultSchema", {
        pointer: "",
        reason: "open-object",
      })).toContain("at its root");
    });

    it("names the reference on the cycle for a recursive position", () => {
      const message = unboundedSchemaPositionMessage(
        "the pattern's result schema",
        {
          pointer: "/properties/piece",
          reason: "recursive-ref",
          ref: "#/$defs/piece",
        },
      );
      expect(message).toContain("`#/$defs/piece` is reachable from itself");
      expect(message).toContain("`/properties/piece`");
    });
  });

  describe("a schema the check passes", () => {
    it("returns `undefined` for each of the shapes a bounded run declares", () => {
      // The four shapes that ran without stalling alongside the one that did:
      // a scalar result, a declared row list, a handle position, and a result
      // naming the framework's own keys.

      const bounded: readonly JSONSchema[] = [
        { type: "object", properties: { total: { type: "number" } } },
        {
          type: "object",
          properties: {
            rows: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  subject: { type: "string" },
                  receivedAt: { type: "string" },
                },
              },
            },
          },
        },
        {
          type: "object",
          properties: { db: { type: "string", asCell: ["cell"] } },
        },
        {
          type: "object",
          properties: {
            $NAME: { type: "string" },
            found: { type: "boolean" },
          },
        },
      ];
      for (const schema of bounded) {
        expect(unboundedSchemaPosition(schema)).toBeUndefined();
      }
    });
  });
});
