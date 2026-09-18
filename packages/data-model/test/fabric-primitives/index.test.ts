/**
 * What `fabric-primitives/index.ts` derives from its list of classes, and that
 * list's agreement with the vocabularies in `interface.ts`. Nothing here names
 * a class: each case ranges over `codecClasses()`, over one of those
 * vocabularies, or over the primitives the shared corpus holds, so a class
 * added to the package is covered without an edit here.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { JSON_CODEC } from "@/codec-interface/interface.ts";
import {
  codecClasses,
  fabricPrimitiveClassOfSchemaType,
} from "@/fabric-primitives/index.ts";
import {
  FABRIC_PRIMITIVE_CODEC_TYPE_TAGS,
  FABRIC_PRIMITIVE_SCHEMA_TYPES,
  type FabricPrimitiveSchemaType,
  isFabricPrimitiveSchemaType,
} from "@/fabric-primitives/interface.ts";
import { FabricPrimitive } from "@/interface.ts";
import { LAYER_CORPUS } from "../fabric-value-corpus.ts";

/**
 * The `FabricPrimitive`s among the corpus, labeled as the corpus labels them.
 */
const PRIMITIVES = LAYER_CORPUS.filter(
  (entry): entry is [string, FabricPrimitive] =>
    entry[1] instanceof FabricPrimitive,
);

describe("fabric-primitives/index", () => {
  describe("codecClasses()", () => {
    it("lists classes which each report a distinct `.schemaType`", () => {
      const names = codecClasses().map((cls) => cls.prototype.schemaType);
      expect(new Set(names).size).toBe(names.length);
    });

    it("lists classes whose reported `.schemaType`s are exactly `FABRIC_PRIMITIVE_SCHEMA_TYPES`", () => {
      const names = codecClasses().map((cls) => cls.prototype.schemaType);
      expect(new Set<string>(names)).toEqual(
        new Set<string>(FABRIC_PRIMITIVE_SCHEMA_TYPES),
      );
    });

    it("lists classes whose JSON codecs' type tags are exactly `FABRIC_PRIMITIVE_CODEC_TYPE_TAGS`", () => {
      const tags = codecClasses().map((cls) =>
        cls[JSON_CODEC].recognizedTypeTag
      );
      expect(new Set(tags)).toEqual(
        new Set<string | undefined>(
          Object.values(FABRIC_PRIMITIVE_CODEC_TYPE_TAGS),
        ),
      );
    });

    it("lists the class of every `FabricPrimitive` in the corpus", () => {
      expect(PRIMITIVES.length).toBeGreaterThan(0);
      const classes = new Set<unknown>(codecClasses());
      for (const [, value] of PRIMITIVES) {
        expect(classes.has(value.constructor)).toBe(true);
      }
    });
  });

  describe("fabricPrimitiveClassOfSchemaType()", () => {
    it("returns each listed class given the `.schemaType` it reports", () => {
      for (const cls of codecClasses()) {
        expect(fabricPrimitiveClassOfSchemaType(cls.prototype.schemaType))
          .toBe(cls);
      }
    });

    for (const [label, value] of PRIMITIVES) {
      it(`returns the class of ${label} given its \`.schemaType\``, () => {
        expect(fabricPrimitiveClassOfSchemaType(value.schemaType))
          .toBe(value.constructor);
      });
    }

    it("throws given a name no class reports", () => {
      expect(() =>
        fabricPrimitiveClassOfSchemaType("Bogus" as FabricPrimitiveSchemaType)
      ).toThrow(/`Bogus`/);
    });
  });

  describe("isFabricPrimitiveSchemaType()", () => {
    it("returns `true` for the `.schemaType` of every listed class", () => {
      for (const cls of codecClasses()) {
        expect(isFabricPrimitiveSchemaType(cls.prototype.schemaType))
          .toBe(true);
      }
    });

    it("returns `false` for a type name outside the vocabulary", () => {
      expect(isFabricPrimitiveSchemaType("object")).toBe(false);
      expect(isFabricPrimitiveSchemaType("FabricNope")).toBe(false);
    });
  });
});
