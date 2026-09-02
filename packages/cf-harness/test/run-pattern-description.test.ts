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
});
