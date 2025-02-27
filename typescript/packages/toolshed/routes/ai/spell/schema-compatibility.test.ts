import { assertEquals } from "@std/assert";
import { areSchemaCompatible } from "./schema-compatibility.ts";

Deno.test("schema compatibility utilities", async (t) => {
  await t.step("matches identical simple schemas", async () => {
    const schema1 = { count: { type: "number" } };
    const schema2 = { count: { type: "number" } };
    assertEquals(await areSchemaCompatible(schema1, schema2), true);
  });

  await t.step(
    "matches schemas with compatible subsets of fields",
    async () => {
      const schema1 = {
        count: { type: "number" },
        name: { type: "string" },
      };
      const schema2 = { count: { type: "number" } };
      assertEquals(await areSchemaCompatible(schema2, schema1), true);
    },
  );

  await t.step("matches compatible nested objects", async () => {
    const schema1 = {
      user: {
        type: "object",
        properties: {
          name: { type: "string" },
          age: { type: "number" },
        },
      },
    };
    const schema2 = {
      user: {
        type: "object",
        properties: {
          name: { type: "string" },
          age: { type: "number" },
          email: { type: "string" },
        },
      },
    };
    assertEquals(await areSchemaCompatible(schema1, schema2), true);
  });

  await t.step("handles different property orders", async () => {
    const schema1 = {
      name: { type: "string" },
      age: { type: "number" },
    };
    const schema2 = {
      age: { type: "number" },
      name: { type: "string" },
    };
    assertEquals(await areSchemaCompatible(schema1, schema2), true);
  });

  await t.step("rejects truly incompatible types", async () => {
    const schema1 = { count: { type: "number" } };
    const schema2 = { count: { type: "string" } };
    assertEquals(await areSchemaCompatible(schema1, schema2), false);
  });
});
