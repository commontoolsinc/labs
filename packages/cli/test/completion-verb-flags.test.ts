import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { shapeVerbFlagCandidates } from "../lib/completion/verb-flags.ts";

/**
 * The `inputSchema` of one verb, in the shape `cf piece verbs --json` reports
 * it — a declared field with a doc comment, an optional boolean, and a
 * required field with none. Copied from a listing rather than invented, so the
 * candidates are shaped from what a real pattern produces.
 */
const ADD_ITEM = {
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string", description: "The item's display label." },
      pinned: {
        type: "boolean",
        description: "Whether the item starts pinned.",
      },
      sortKey: { type: "number" },
    },
    required: ["title"],
  },
} as const;

describe("shapeVerbFlagCandidates()", () => {
  it("names every declared field as the flag the parser accepts", () => {
    const values = shapeVerbFlagCandidates(ADD_ITEM).map((c) => c.value);
    expect(values).toContain("--title");
    expect(values).toContain("--pinned");
  });

  it("writes a camelCase field as its kebab-case flag", () => {
    // `flagNameForKey` is the mapping the parser itself applies, so `sortKey`
    // is reachable as `--sort-key` and as nothing else.
    const values = shapeVerbFlagCandidates(ADD_ITEM).map((c) => c.value);
    expect(values).toContain("--sort-key");
    expect(values).not.toContain("--sortKey");
  });

  it("offers both spellings of a boolean field", () => {
    const values = shapeVerbFlagCandidates(ADD_ITEM).map((c) => c.value);
    expect(values).toContain("--pinned");
    expect(values).toContain("--no-pinned");
    // Only a boolean is negatable.
    expect(values).not.toContain("--no-title");
  });

  it("annotates a field with the author's own doc comment", () => {
    const title = shapeVerbFlagCandidates(ADD_ITEM)
      .find((candidate) => candidate.value === "--title");
    expect(title?.description).toBe("The item's display label.");
  });

  it("falls back to whether the field is owed where no prose was written", () => {
    const sortKey = shapeVerbFlagCandidates(ADD_ITEM)
      .find((candidate) => candidate.value === "--sort-key");
    expect(sortKey?.description).toBe("optional");
  });

  it("offers the generic input flags after the declared ones", () => {
    const values = shapeVerbFlagCandidates(ADD_ITEM).map((c) => c.value);
    expect(values.slice(-3)).toEqual(["--json", "--json-file", "--help"]);
  });

  it("returns the generic flags alone for a verb declaring no input", () => {
    // The schema-less shape: nothing was declared, so nothing is derived, and
    // the flags every verb accepts are still the honest candidate set.
    expect(shapeVerbFlagCandidates({ inputSchema: true }).map((c) => c.value))
      .toEqual(["--json", "--json-file", "--help"]);
  });

  it("names the value flags for an input that is not an object", () => {
    // A non-object input is written whole, so `--value` is the field-shaped
    // flag and there are no per-field ones to derive.
    const values = shapeVerbFlagCandidates({
      inputSchema: { type: "string" },
    }).map((candidate) => candidate.value);
    expect(values).toEqual([
      "--value",
      "--value-file",
      "--json",
      "--json-file",
      "--help",
    ]);
  });

  it("sets a declared boolean `help` by the spellings that are not the help page", () => {
    // Bare `--help` opens the verb's own page whatever a field of that name
    // says, so offering it as the way to set the field names a flag that does
    // something else.
    const values = shapeVerbFlagCandidates({
      inputSchema: {
        type: "object",
        properties: { help: { type: "boolean" } },
      },
    }).map((candidate) => candidate.value);
    expect(values).toContain("--help=true");
    expect(values).toContain("--no-help");
    expect(values.filter((v) => v === "--help").length).toBe(1);
  });

  it("offers one candidate per value where a field collides with a generic flag", () => {
    // Nothing reserves a field name, so a verb may declare `json`. Two menu
    // entries of one value would mean two different things.
    const values = shapeVerbFlagCandidates({
      inputSchema: {
        type: "object",
        properties: { json: { type: "string" }, jsonFile: { type: "string" } },
      },
    }).map((candidate) => candidate.value);
    expect(values).toEqual([...new Set(values)]);
    expect(values.filter((v) => v === "--json").length).toBe(1);
  });

  it("reads fields an `allOf` contributes, which the payload door judges", () => {
    // The two doors read one schema. A field the parser accepts and this did
    // not offer would be a slot silently short of the vocabulary it claims.
    const values = shapeVerbFlagCandidates({
      inputSchema: {
        allOf: [
          { type: "object", properties: { title: { type: "string" } } },
          { type: "object", properties: { body: { type: "string" } } },
        ],
      },
    }).map((candidate) => candidate.value);
    expect(values).toContain("--title");
    expect(values).toContain("--body");
  });
});
