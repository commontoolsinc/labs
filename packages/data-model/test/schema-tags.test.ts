import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type { JSONSchema } from "@commonfabric/api";
import { extractHashtags, tagsFromSchema } from "@/schema-tags.ts";

describe("extractHashtags", () => {
  it("extracts tags lowercased without the leading #", () => {
    expect(extractHashtags("A #Note about #quick-capture")).toEqual([
      "note",
      "quick-capture",
    ]);
  });

  it("deduplicates while preserving first-appearance order", () => {
    expect(extractHashtags("#b then #a then #B again")).toEqual(["b", "a"]);
  });

  it("stops tokens at characters outside [a-z0-9-]", () => {
    expect(extractHashtags("#todo_list")).toEqual(["todo"]);
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

  it("falls back to hashtags in description text for legacy schemas", () => {
    const schema: JSONSchema = {
      type: "object",
      description: "An #annotation pointing at an existing cell.",
      properties: {
        content: { type: "string", description: "See #backlink." },
      },
    };
    expect(tagsFromSchema(schema)).toEqual(["annotation", "backlink"]);
  });

  it("prefers structured tags over description text when both exist", () => {
    const schema: JSONSchema = {
      type: "object",
      description: "A #stale-tag in prose",
      tags: ["fresh-tag"],
    };
    expect(tagsFromSchema(schema)).toEqual(["fresh-tag"]);
  });

  it("returns empty for boolean and missing schemas", () => {
    expect(tagsFromSchema(true)).toEqual([]);
    expect(tagsFromSchema(undefined)).toEqual([]);
  });
});
