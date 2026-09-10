/** Model-facing `run_pattern` guidance stays within what the harness detects. */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type { JSONSchema } from "@commonfabric/api";

import { runPatternToolDescriptor } from "../src/tools/run-pattern.ts";

describe("run-pattern description", () => {
  it("states that the post-run pointer check is authoritative", () => {
    const schema = runPatternToolDescriptor.inputSchema;
    if (
      typeof schema !== "object" || schema === null ||
      schema.type !== "object" || schema.properties === undefined
    ) {
      throw new Error("expected `run_pattern` object input schema");
    }
    const sourceText = schema.properties.sourceText as JSONSchema;
    const description = typeof sourceText === "object" && sourceText !== null
      ? sourceText.description
      : undefined;

    expect(description).toContain("known smell");
    expect(description).toContain("checks the actual pattern pointer");
    expect(description).toContain("session-only identity");
    expect(description).not.toContain("creates a piece no other runtime");
  });

  it("tells the model to bound a query's rows", () => {
    expect(runPatternToolDescriptor.description).toContain(
      "Bound every query's rows with a LIMIT",
    );
    expect(runPatternToolDescriptor.description).toContain(
      "an ordinary result row is materialized as its own document in the space",
    );
  });

  it("exempts an aggregate from the LIMIT it asks of every other query", () => {
    expect(runPatternToolDescriptor.description).toContain(
      "an aggregate returning one row per group",
    );
    expect(runPatternToolDescriptor.description).toContain(
      "bounded by its own shape and needs no LIMIT",
    );
  });

  it("tells the model that an unnamed object position is refused before the run", () => {
    expect(runPatternToolDescriptor.description).toContain(
      "Declare every position your pattern reads at",
    );
    expect(runPatternToolDescriptor.description).toContain(
      "refused before it runs, naming the position",
    );
  });

  it("states the same bound on a caller's `resultSchema`", () => {
    const schema = runPatternToolDescriptor.inputSchema;
    if (
      typeof schema !== "object" || schema === null ||
      schema.type !== "object" || schema.properties === undefined
    ) {
      throw new Error("expected `run_pattern` object input schema");
    }
    const resultSchema = schema.properties.resultSchema as JSONSchema;
    const description = typeof resultSchema === "object" &&
        resultSchema !== null
      ? resultSchema.description
      : undefined;

    expect(description).toContain(
      "Every object position here names its properties",
    );
  });
});
