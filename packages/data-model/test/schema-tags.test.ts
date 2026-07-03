import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type { JSONSchema } from "@commonfabric/api";
import { extractHashtags, tagsFromSchema } from "@/schema-tags.ts";

describe("extractHashtags", () => {
  it("extracts tags lowercased without the leading #", () => {
    expect(extractHashtags("A #Note about #capture")).toEqual([
      "note",
      "capture",
    ]);
  });

  it("deduplicates while preserving first-appearance order", () => {
    expect(extractHashtags("#b then #a then #B again")).toEqual(["b", "a"]);
  });

  it("includes underscores in a token", () => {
    expect(extractHashtags("#todo_list")).toEqual(["todo_list"]);
  });

  it("ends a token at a hyphen", () => {
    expect(extractHashtags("#quick-capture")).toEqual(["quick"]);
  });

  it("accepts letters from non-Latin scripts and diacritics", () => {
    expect(extractHashtags("#café #日本語 #привет #مرحبا")).toEqual([
      "café",
      "日本語",
      "привет",
      "مرحبا",
    ]);
  });

  it("ends a token at whitespace and punctuation", () => {
    expect(extractHashtags("#todo, and #done!")).toEqual(["todo", "done"]);
  });

  it("returns empty for text without hashtags", () => {
    expect(extractHashtags("no tags here")).toEqual([]);
  });
});

describe("tagsFromSchema", () => {
  it("reads structured tags from the root", () => {
    const schema: JSONSchema = {
      type: "object",
      description: "A #note",
      tags: ["note"],
    };
    expect(tagsFromSchema(schema)).toEqual(["note"]);
  });

  it("aggregates structured tags across nested schemas", () => {
    const schema: JSONSchema = {
      type: "object",
      tags: ["note"],
      properties: {
        annotations: {
          type: "array",
          tags: ["annotation"],
          items: { type: "string" },
        },
      },
    };
    expect(tagsFromSchema(schema)).toEqual(["note", "annotation"]);
  });

  it("does not read tags from data positions like default", () => {
    const schema: JSONSchema = {
      type: "object",
      tags: ["note"],
      properties: {
        config: {
          type: "object",
          default: { tags: ["not-a-schema-tag"] },
        },
      },
    };
    expect(tagsFromSchema(schema)).toEqual(["note"]);
  });

  it("reads only structured tags, ignoring hashtags in description text", () => {
    const schema: JSONSchema = {
      type: "object",
      description: "A #stale-tag in prose",
      tags: ["fresh-tag"],
      properties: {
        content: { type: "string", description: "See #backlink." },
      },
    };
    expect(tagsFromSchema(schema)).toEqual(["fresh-tag"]);
  });

  it("returns empty when a schema has hashtags only in its description", () => {
    const schema: JSONSchema = {
      type: "object",
      description: "An #annotation with no structured tags.",
    };
    expect(tagsFromSchema(schema)).toEqual([]);
  });

  it("returns empty for boolean and missing schemas", () => {
    expect(tagsFromSchema(true)).toEqual([]);
    expect(tagsFromSchema(undefined)).toEqual([]);
  });

  it("collects tags from anyOf/allOf/oneOf branches", () => {
    const schema: JSONSchema = {
      type: "object",
      anyOf: [{ type: "object", tags: ["from-anyof"] }],
      allOf: [{ type: "object", tags: ["from-allof"] }],
      oneOf: [{ type: "object", tags: ["from-oneof"] }],
    };
    expect(tagsFromSchema(schema)).toEqual([
      "from-anyof",
      "from-allof",
      "from-oneof",
    ]);
  });

  it("skips boolean schemas sitting in a schema-collection keyword", () => {
    const schema: JSONSchema = {
      type: "object",
      // A boolean schema as an anyOf branch is a non-object node; the walk
      // must skip it without error and still collect the sibling's tags.
      anyOf: [true, { type: "object", tags: ["real"] }],
    };
    expect(tagsFromSchema(schema)).toEqual(["real"]);
  });

  it("skips non-string entries in a tags array", () => {
    const schema: JSONSchema = { type: "object" };
    Object.assign(schema, {
      tags: ["good", 42, "also-good"],
    });
    expect(tagsFromSchema(schema)).toEqual(["good", "also-good"]);
  });

  it("visits a shared schema node only once", () => {
    const shared: JSONSchema = { type: "object", tags: ["shared"] };
    const schema: JSONSchema = {
      type: "object",
      anyOf: [shared],
      allOf: [shared],
    };
    // The visited set prevents the shared node from being walked twice; the
    // tag is collected once regardless.
    expect(tagsFromSchema(schema)).toEqual(["shared"]);
  });
});
