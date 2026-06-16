import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { extractHashtags } from "@/schema-tags.ts";

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
