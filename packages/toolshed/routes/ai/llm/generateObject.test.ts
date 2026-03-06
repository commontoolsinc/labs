import { assertEquals, assertRejects } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import env from "@/env.ts";
import { findModel, MODELS } from "./models.ts";

if (env.ENV !== "test") {
  throw new Error("ENV must be 'test'");
}

describe("generateObject server-side", () => {
  describe("findModel", () => {
    it("returns undefined for unknown model names", () => {
      const result = findModel("nonexistent:model-xyz");
      assertEquals(result, undefined);
    });

    it("returns undefined for empty string", () => {
      const result = findModel("");
      assertEquals(result, undefined);
    });
  });

  describe("model registration", () => {
    it("MODELS is empty in test environment (no API keys)", () => {
      // In test env (.env.test has no API keys), no models should be registered
      assertEquals(Object.keys(MODELS).length, 0);
    });
  });

  describe("generateObject function", () => {
    it("throws when model is not found", async () => {
      // Import the actual generateObject function
      const { generateObject } = await import("./generateObject.ts");

      await assertRejects(
        () =>
          generateObject({
            schema: {
              type: "object",
              properties: { name: { type: "string" } },
            },
            messages: [{ role: "user", content: "test" }],
            model: "nonexistent:model",
          }),
        Error,
      );
    });

    it("throws when no model specified and default model not registered", async () => {
      const { generateObject } = await import("./generateObject.ts");

      await assertRejects(
        () =>
          generateObject({
            schema: {
              type: "object",
              properties: { value: { type: "number" } },
            },
            messages: [{ role: "user", content: "give me a number" }],
            // No model specified — falls back to DEFAULT_GENERATE_OBJECT_MODELS
          }),
        Error,
      );
    });
  });
});
