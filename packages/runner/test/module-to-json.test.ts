import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { moduleToJSON } from "../src/builder/json-utils.ts";
import type { Module } from "../src/builder/types.ts";

describe("moduleToJSON", () => {
  it("merges helper metadata from implementation source and module", () => {
    const module = {
      type: "javascript",
      implementation:
        "({ state }) => derive(state.count, (value) => value + NAME)",
      helpers: ["ifElse"],
      commontoolsAliases: ["commontools_1"],
    } as unknown as Module;

    const json = moduleToJSON(module);

    expect(json).toMatchObject({
      helpers: ["NAME", "derive", "ifElse"],
      commontoolsAliases: ["commontools_1"],
      implementation:
        "({ state }) => derive(state.count, (value) => value + NAME)",
    });
  });

  it("omits helper metadata when no commontools references exist", () => {
    const module = {
      type: "javascript",
      implementation: "(value) => value + 1",
    } as unknown as Module;

    const json = moduleToJSON(module);

    expect(json).not.toHaveProperty("helpers");
    expect(json).not.toHaveProperty("commontoolsAliases");
  });
});
