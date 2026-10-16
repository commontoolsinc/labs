/**
 * The view a `$ref` resolves to within a deep-frozen document is deep-frozen
 * itself, so the memos keyed on a resolution's root hold for it.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type { JSONSchemaObj } from "@commonfabric/api";
import { deepFreeze, isDeepFrozen } from "@commonfabric/data-model";

import {
  resolveCfcSchemaRef,
  resolveCfcSchemaRefs,
} from "../../src/cfc/schema-refs.ts";

describe("schema-refs", () => {
  describe("resolveCfcSchemaRef()", () => {
    /** A document whose one definition names itself. */
    const document = (): JSONSchemaObj => ({
      $ref: "#/$defs/Node",
      $defs: {
        Node: {
          type: "object",
          properties: { next: { $ref: "#/$defs/Node" } },
        },
      },
    });

    it("returns a deep-frozen view carrying the document's own map for a deep-frozen document", () => {
      const root = deepFreeze(document());
      const view = resolveCfcSchemaRef(root, "#/$defs/Node") as JSONSchemaObj;

      expect(isDeepFrozen(view)).toBe(true);
      expect(view.$defs).toBe(root.$defs);
      expect(view.properties).toBe(
        (root.$defs!.Node as JSONSchemaObj).properties,
      );
    });

    it("keeps what a reference within the view resolves to", () => {
      const root = deepFreeze(document());
      const view = resolveCfcSchemaRef(root, "#/$defs/Node") as JSONSchemaObj;
      const next = (view.properties as Record<string, JSONSchemaObj>).next;

      const first = resolveCfcSchemaRefs(next, view);
      expect(first).toEqual(view);
      expect(resolveCfcSchemaRefs(next, view)).toBe(first);
    });

    it("leaves the view of a mutable document unfrozen", () => {
      const root = document();
      const view = resolveCfcSchemaRef(root, "#/$defs/Node") as JSONSchemaObj;

      expect(Object.isFrozen(view)).toBe(false);
      expect(Object.isFrozen(root.$defs)).toBe(false);
    });
  });
});
