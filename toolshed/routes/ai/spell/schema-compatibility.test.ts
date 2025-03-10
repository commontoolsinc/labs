import { assertEquals } from "@std/assert";
import { areSchemaCompatible } from "./schema-compatibility.ts";

Deno.test("schema compatibility utilities", async (t) => {
  await t.step("matches truly identical schemas", async () => {
    const schema1 = { count: { type: "number" } };
    const schema2 = { count: { type: "number" } };
    assertEquals(await areSchemaCompatible(schema1, schema2), true);
  });

  await t.step("rejects when schema1 has extra fields", async () => {
    const schema1 = {
      count: { type: "number" },
      name: { type: "string" },
    };
    const schema2 = { count: { type: "number" } };
    assertEquals(await areSchemaCompatible(schema1, schema2), false);
  });

  await t.step("rejects when schema2 has extra fields", async () => {
    const schema1 = { count: { type: "number" } };
    const schema2 = {
      count: { type: "number" },
      name: { type: "string" },
    };
    assertEquals(await areSchemaCompatible(schema1, schema2), false);
  });

  await t.step("matches identical nested schemas", async () => {
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
        },
      },
    };
    assertEquals(await areSchemaCompatible(schema1, schema2), true);
  });

  await t.step("rejects nested schemas with extra fields", async () => {
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
    assertEquals(await areSchemaCompatible(schema1, schema2), false);
  });

  await t.step("matches schemas with identical array types", async () => {
    const schema1 = {
      tags: {
        type: "array",
        items: { type: "string" },
      },
    };
    const schema2 = {
      tags: {
        type: "array",
        items: { type: "string" },
      },
    };
    assertEquals(await areSchemaCompatible(schema1, schema2), true);
  });

  await t.step("rejects schemas with different array item types", async () => {
    const schema1 = {
      tags: {
        type: "array",
        items: { type: "string" },
      },
    };
    const schema2 = {
      tags: {
        type: "array",
        items: { type: "number" },
      },
    };
    assertEquals(await areSchemaCompatible(schema1, schema2), false);
  });

  await t.step("matches identical union types", async () => {
    const schema1 = {
      id: { type: ["string", "number"] },
    };
    const schema2 = {
      id: { type: ["string", "number"] },
    };
    assertEquals(await areSchemaCompatible(schema1, schema2), true);
  });

  await t.step("rejects different union types", async () => {
    const schema1 = {
      id: { type: ["string", "number"] },
    };
    const schema2 = {
      id: { type: ["string", "boolean"] },
    };
    assertEquals(await areSchemaCompatible(schema1, schema2), false);
  });
});
