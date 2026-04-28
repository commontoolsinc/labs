import { assertEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { normalizeSchemaForProvider } from "./schema.ts";

describe("normalizeSchemaForProvider", () => {
  it("strips undefined branches from anyOf", () => {
    assertEquals(
      normalizeSchemaForProvider({
        type: "object",
        properties: {
          injectionDetected: {
            anyOf: [{ type: "undefined" }, { type: "boolean" }],
          },
        },
      }),
      {
        type: "object",
        properties: {
          injectionDetected: { type: "boolean" },
        },
      },
    );
  });

  it("preserves sibling annotations when collapsing anyOf", () => {
    assertEquals(
      normalizeSchemaForProvider({
        description: "Optional boolean flag",
        anyOf: [{ type: "undefined" }, { type: "boolean" }],
      }),
      {
        description: "Optional boolean flag",
        type: "boolean",
      },
    );
  });

  it("drops properties that only allow undefined", () => {
    assertEquals(
      normalizeSchemaForProvider({
        type: "object",
        properties: {
          keep: { type: "string" },
          drop: { type: "undefined" },
        },
        required: ["keep", "drop"],
      }),
      {
        type: "object",
        properties: {
          keep: { type: "string" },
        },
        required: ["keep"],
      },
    );
  });

  it("strips undefined from type arrays", () => {
    assertEquals(
      normalizeSchemaForProvider({
        type: ["undefined", "string", "number"],
      }),
      {
        type: ["string", "number"],
      },
    );
  });
});
