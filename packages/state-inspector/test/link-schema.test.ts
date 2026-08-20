/**
 * How a link's stored schema reaches annotated inspector output. The tool's
 * contract is that its output is what the store holds, so the distinctions
 * pinned here are between an absent schema, a stored `true`, and a schema too
 * large to write out — three states a reader has to be able to tell apart,
 * because a JSON Schema of `true` constrains nothing while a large one freezes
 * a shape.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { FabricLink } from "@commonfabric/data-model/fabric-instances";

import { annotate, decodedLinkOf, summarizeLink } from "../decode.ts";

/** A link in the legacy at-rest sigil form, carrying `schema` when given one. */
function sigilLink(schema?: unknown): unknown {
  return {
    "/": {
      "link@1": {
        id: "of:fid1:target",
        path: [],
        ...(schema === undefined ? {} : { schema }),
      },
    },
  };
}

/**
 * A schema with enough in it to exceed the inline budget, shaped like the ones
 * a pattern's argument cell really carries.
 */
function largeSchema(description: string): Record<string, unknown> {
  return {
    type: "object",
    description,
    properties: Object.fromEntries(
      Array.from({ length: 12 }, (_, index) => [
        `field${index}`,
        { type: "string", default: "" },
      ]),
    ),
    required: Array.from({ length: 12 }, (_, index) => `field${index}`),
  };
}

/** The `$link` body of an annotated single link. */
function annotatedLink(value: unknown): Record<string, unknown> {
  const annotated = annotate(value) as { $link: Record<string, unknown> };
  return annotated.$link;
}

describe("link-schema", () => {
  describe("decodedLinkOf()", () => {
    it("returns the stored schema itself rather than a flag", () => {
      const schema = { type: "string" };
      expect(decodedLinkOf(sigilLink(schema))?.schema).toEqual(schema);
    });

    it("returns `undefined` for a link storing no schema", () => {
      expect(decodedLinkOf(sigilLink())?.schema).toBe(undefined);
    });

    it("returns the stored schema of a modern `FabricLink`", () => {
      const schema = { type: "string" };
      const link = new FabricLink({ id: "of:x", path: [], schema });
      expect(decodedLinkOf(link)?.schema).toEqual(schema);
    });
  });

  describe("annotate()", () => {
    it("omits `schema` for a link storing no schema", () => {
      expect(Object.hasOwn(annotatedLink(sigilLink()), "schema")).toBe(false);
    });

    it("returns `true` for a link storing the schema `true`", () => {
      expect(annotatedLink(sigilLink(true)).schema).toBe(true);
    });

    it("returns `false` for a link storing the schema `false`", () => {
      expect(annotatedLink(sigilLink(false)).schema).toBe(false);
    });

    it("returns the empty schema for a link storing `{}`", () => {
      expect(annotatedLink(sigilLink({})).schema).toEqual({});
    });

    it("returns a small schema as itself", () => {
      const schema = { type: "object", properties: { a: { type: "string" } } };
      expect(annotatedLink(sigilLink(schema)).schema).toEqual(schema);
    });

    it("returns a summary naming the top-level keys of a large schema", () => {
      const schema = largeSchema("a description long enough to matter");
      const rendered = annotatedLink(sigilLink(schema)).schema as {
        $elidedSchema: { keys: string[]; bytes: number; digest: string };
      };
      expect(rendered.$elidedSchema.keys).toEqual([
        "type",
        "description",
        "properties",
        "required",
      ]);
      expect(rendered.$elidedSchema.bytes).toBeGreaterThan(200);
      expect(typeof rendered.$elidedSchema.digest).toBe("string");
    });

    it("returns a large schema in full at infinite `maxDepth`", () => {
      const schema = largeSchema("a description long enough to matter");
      const annotated = annotate(
        sigilLink(schema),
        Number.POSITIVE_INFINITY,
      ) as { $link: { schema: unknown } };
      expect(annotated.$link.schema).toEqual(schema);
    });

    it("returns a schema summary distinct from every schema a link can store", () => {
      const summarized = annotatedLink(sigilLink(largeSchema("wide")))
        .schema as Record<string, unknown>;
      // A reader who cannot tell an elision from the thing elided is back to
      // reading a fabricated schema, so the summary carries a key no schema
      // of its own does.
      expect(Object.keys(summarized)).toEqual(["$elidedSchema"]);
      expect(summarized).not.toEqual(true);
      expect(summarized).not.toEqual({});
    });

    it("returns different digests for two schemas of the same shape", () => {
      const digestOf = (description: string) =>
        (annotatedLink(sigilLink(largeSchema(description))).schema as {
          $elidedSchema: { digest: string };
        }).$elidedSchema.digest;
      // A stale schema and its replacement agree on every top-level key, so
      // the digest is what a diff of two revisions has to separate them by.
      expect(digestOf("one description")).not.toBe(digestOf("another one"));
    });

    it("returns the stored schema of a modern `FabricLink`", () => {
      const schema = { type: "string" };
      const link = new FabricLink({ id: "of:x", path: [], schema });
      expect(annotatedLink(link).schema).toEqual(schema);
    });

    it("returns a schema's own `$ref` untouched", () => {
      const schema = { $ref: "#/$defs/TopicLinkKind" };
      expect(annotatedLink(sigilLink(schema)).schema).toEqual(schema);
    });

    it("returns a sigil-shaped literal inside a schema in annotated form", () => {
      // A schema is walked like any other value, which is what keeps the
      // rendering JSON-safe where the stored form is not.
      const schema = { const: { "/": "of:target" } };
      expect(annotatedLink(sigilLink(schema)).schema).toEqual({
        const: { $ref: "of:target" },
      });
    });

    it("returns a schema holding a `bigint`, which the stored form cannot be serialized from", () => {
      const rendered = annotatedLink(sigilLink({ const: 1n })).schema;
      expect(rendered).toEqual({ const: { $bigint: "1" } });
      expect(() => JSON.stringify(rendered)).not.toThrow();
    });
  });

  describe("summarizeLink()", () => {
    it("marks a link that stores a schema", () => {
      expect(summarizeLink({ id: "of:x", schema: { type: "string" } }))
        .toContain("+schema");
    });

    it("marks a link that stores the schema `false`", () => {
      expect(summarizeLink({ id: "of:x", schema: false })).toContain("+schema");
    });

    it("does not mark a link that stores no schema", () => {
      expect(summarizeLink({ id: "of:x" })).not.toContain("+schema");
    });
  });
});
