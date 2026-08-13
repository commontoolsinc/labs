import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { JSONSchema } from "@commonfabric/runner";
import { declaredResultProjection } from "../lib/cell-selection.ts";

/**
 * The declared result of a verb that hands an item back, with `Item` naming
 * itself through `parent`. That recursion is the only thing a derived bound
 * cuts, so every case here hangs its own position beside `item` and reads how
 * the derivation treats that position while the walk is already cutting
 * somewhere else. A declaration that re-enters nowhere derives no projection
 * at all, which would leave nothing to read.
 *
 * The declaration shapes below are the ones a compiled pattern cannot be made
 * to produce — a reference out of the document, a reference to a name that is
 * not there, a position with no shape under it — which is why they are driven
 * through the derivation directly rather than through a live verb. The
 * recursion they hang off is the same one the transformer lowers, spelled the
 * same way: a local `$ref` into `$defs`.
 */
function declarationBeside(
  beside: Readonly<Record<string, JSONSchema>>,
): JSONSchema {
  return {
    type: "object",
    properties: { item: { $ref: "#/$defs/Item" }, ...beside },
    $defs: {
      Item: {
        type: "object",
        properties: {
          title: { type: "string" },
          parent: { $ref: "#/$defs/Item" },
        },
      },
    },
  };
}

/** The projection schema {@link declarationBeside}'s declaration derives. */
function derivedSchemaBeside(
  beside: Readonly<Record<string, JSONSchema>>,
): JSONSchema | undefined {
  return declaredResultProjection(declarationBeside(beside))?.schema;
}

/**
 * `item` as the derivation writes it: `title` read as declared, and `parent`
 * rendering its address instead of being followed back into the item. The
 * `false` is what the position holds once its `$link` marker has been lifted
 * out into the projection's `markers`.
 */
const CUT_ITEM = {
  type: "object",
  properties: { title: true, parent: false },
  additionalProperties: false,
};

describe("declaredResultProjection", () => {
  it("returns a `$link` marker at the position where the declaration re-enters", () => {
    expect(declaredResultProjection(declarationBeside({}))).toEqual({
      source: "<the verb's declared result>",
      schema: {
        type: "object",
        properties: { item: CUT_ITEM },
        additionalProperties: false,
      },
      markers: {
        properties: { item: { properties: { parent: { marked: true } } } },
      },
      kind: "json",
      flag: "--schema",
    });
  });

  it("returns `undefined` where the verb declares no result to bound with", () => {
    expect(declaredResultProjection(undefined)).toBeUndefined();
    expect(declaredResultProjection(true)).toBeUndefined();
  });

  it("returns `undefined` for a declaration that re-enters nowhere", () => {
    expect(declaredResultProjection({
      type: "object",
      properties: {
        title: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
      },
    })).toBeUndefined();
  });

  it("returns `true` at an array position that declares no `items`", () => {
    expect(derivedSchemaBeside({ history: { type: "array" } })).toEqual({
      type: "object",
      properties: { item: CUT_ITEM, history: true },
      additionalProperties: false,
    });
  });

  it("returns `true` at a position declared as `true`", () => {
    expect(derivedSchemaBeside({ anything: true })).toEqual({
      type: "object",
      properties: { item: CUT_ITEM, anything: true },
      additionalProperties: false,
    });
  });

  it("returns `true` at an object position that declares no properties", () => {
    expect(derivedSchemaBeside({ metadata: { type: "object" } })).toEqual({
      type: "object",
      properties: { item: CUT_ITEM, metadata: true },
      additionalProperties: false,
    });
  });

  describe("a `$ref` the declaration does not resolve", () => {
    /** What every case in this group derives: the reference contributes no
     * bound, so its position is read exactly as an unbounded readback reads
     * it, and the recursion beside it is still cut. */
    const unbounded = {
      type: "object",
      properties: { item: CUT_ITEM, origin: true },
      additionalProperties: false,
    };

    it("returns `true` at a position whose `$ref` names nothing in the declaration", () => {
      expect(derivedSchemaBeside({ origin: { $ref: "#/$defs/Missing" } }))
        .toEqual(unbounded);
    });

    it("returns `true` at a position whose `$ref` points outside the declaration", () => {
      expect(
        derivedSchemaBeside({
          origin: { $ref: "https://example.com/item.json#/$defs/Item" },
        }),
      ).toEqual(unbounded);
    });

    it("returns `true` at a position whose `$ref` names an anchor rather than a pointer", () => {
      expect(derivedSchemaBeside({ origin: { $ref: "#Item" } }))
        .toEqual(unbounded);
    });

    it("returns `true` at a position whose `$ref` walks past a name the declaration does not have", () => {
      // `$defs/Item` has no `title` of its own — the title sits under
      // `properties` — so the walk runs out of document with a segment left.
      expect(
        derivedSchemaBeside({ origin: { $ref: "#/$defs/Item/title/type" } }),
      ).toEqual(unbounded);
    });
  });
});
