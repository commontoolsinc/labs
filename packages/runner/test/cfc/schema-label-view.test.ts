import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { JSONSchema } from "@commonfabric/api";
import { internSchema } from "@commonfabric/data-model-schema";

import { cfcSchemaEntries } from "../../src/cfc/schema-label-view.ts";

describe("schema-label-view", () => {
  describe("cfcSchemaEntries()", () => {
    const document = {
      type: "object",
      properties: {
        title: { type: "string", ifc: { integrity: ["reviewed"] } },
        rows: {
          type: "array",
          items: { type: "object", ifc: { confidentiality: ["secret"] } },
        },
      },
    } as const;

    it("keeps a deep-frozen document's entries by the document", () => {
      const frozen = internSchema(document);
      const entries = cfcSchemaEntries(frozen);
      expect(entries.map((entry) => entry.path)).toEqual([
        ["title"],
        ["rows", "*"],
      ]);
      expect(cfcSchemaEntries(frozen)).toBe(entries);
      expect(Object.isFrozen(entries)).toBe(true);
    });

    it("walks a mutable document on every ask", () => {
      const mutable = structuredClone(document) as {
        properties: { title: unknown };
      };
      const entries = cfcSchemaEntries(mutable as JSONSchema);
      expect(entries).toHaveLength(2);
      expect(cfcSchemaEntries(mutable as JSONSchema)).not.toBe(entries);
      mutable.properties.title = { type: "string" };
      expect(
        cfcSchemaEntries(mutable as JSONSchema).map((entry) => entry.path),
      ).toEqual([
        ["rows", "*"],
      ]);
    });

    it("walks a fragment under its document afresh", () => {
      const frozen = internSchema(document);
      const fragment = (frozen as typeof document).properties.rows;
      const whole = cfcSchemaEntries(frozen);
      const below = cfcSchemaEntries(fragment, ["rows"], [], frozen);
      expect(below).not.toBe(whole);
      expect(below.map((entry) => entry.path)).toEqual([["rows", "*"]]);
    });
  });
});
