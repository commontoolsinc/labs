/**
 * The `delegate_task` model-facing contract, including bounded pattern
 * references selected from prior search results.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type { JSONSchema } from "@commonfabric/api";

import { delegateTaskTool } from "../src/tools/delegate-task.ts";

const objectProperties = (
  schema: JSONSchema,
): Readonly<Record<string, JSONSchema>> => {
  if (
    typeof schema !== "object" || schema === null ||
    schema.type !== "object" || schema.properties === undefined
  ) {
    throw new Error("expected an object schema with properties");
  }
  return schema.properties;
};

describe("delegate-task", () => {
  it("caps `patternRefs` at eight entries", () => {
    const patternRefs = objectProperties(
      delegateTaskTool.descriptor.inputSchema,
    ).patternRefs;

    expect(patternRefs).toBeDefined();
    expect(
      typeof patternRefs === "object" && patternRefs !== null
        ? patternRefs.maxItems
        : undefined,
    ).toBe(8);
  });

  it("caps each `patternRefs` note at 500 characters", () => {
    const patternRefs = objectProperties(
      delegateTaskTool.descriptor.inputSchema,
    ).patternRefs;
    if (
      typeof patternRefs !== "object" || patternRefs === null ||
      typeof patternRefs.items !== "object" || patternRefs.items === null
    ) {
      throw new Error("expected `patternRefs` item schema");
    }
    const note = objectProperties(patternRefs.items).note;

    expect(note).toBeDefined();
    expect(
      typeof note === "object" && note !== null ? note.maxLength : undefined,
    ).toBe(500);
  });
});
