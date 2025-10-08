import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createSchemaTransformerV2 } from "../../src/plugin.ts";
import { getTypeFromCode } from "../utils.ts";

describe("Schema: Record and mapped types", () => {
  const transformer = createSchemaTransformerV2();

  it("should generate correct schemas for Record<union, primitive>", async () => {
    const { type, checker, typeNode } = await getTypeFromCode(
      `interface Config {
        settings: Record<"theme" | "language" | "timezone", string>;
      }`,
      "Config",
    );
    const schema = transformer(type, checker, typeNode);

    console.log("=== Full Config schema ===");
    console.log(JSON.stringify(schema, null, 2));

    expect(schema.type).toBe("object");
    expect(schema.properties).toBeDefined();
    expect(schema.properties?.settings).toBeDefined();

    const settingsSchema = schema.properties!.settings as any;
    console.log("=== Settings schema ===");
    console.log(JSON.stringify(settingsSchema, null, 2));

    // Check if it's a ref or direct object
    if (settingsSchema.$ref) {
      console.log("=== Found $ref, checking $defs ===");
      console.log(JSON.stringify(schema.$defs, null, 2));
    }

    expect(settingsSchema.type).toBe("object");
    expect(settingsSchema.properties).toBeDefined();

    // Each property should have the correct type schema, not 'true'
    expect(settingsSchema.properties.theme).toEqual({ type: "string" });
    expect(settingsSchema.properties.language).toEqual({ type: "string" });
    expect(settingsSchema.properties.timezone).toEqual({ type: "string" });

    // All keys should be required
    expect(settingsSchema.required).toEqual([
      "theme",
      "language",
      "timezone",
    ]);
  });

  it("should generate correct schemas for Record<union, number>", async () => {
    const { type, checker, typeNode } = await getTypeFromCode(
      `interface Config {
        limits: Record<"cpu" | "memory" | "disk", number>;
      }`,
      "Config",
    );
    const schema = transformer(type, checker, typeNode);

    const limitsSchema = schema.properties!.limits as any;
    expect(limitsSchema.type).toBe("object");

    // Each property should have type: "number", not 'true'
    expect(limitsSchema.properties.cpu).toEqual({ type: "number" });
    expect(limitsSchema.properties.memory).toEqual({ type: "number" });
    expect(limitsSchema.properties.disk).toEqual({ type: "number" });
  });

  it("should generate correct schemas for Record<union, boolean>", async () => {
    const { type, checker, typeNode } = await getTypeFromCode(
      `interface Config {
        features: Record<"auth" | "api" | "ui", boolean>;
      }`,
      "Config",
    );
    const schema = transformer(type, checker, typeNode);

    const featuresSchema = schema.properties!.features as any;
    expect(featuresSchema.type).toBe("object");

    // Each property should have type: "boolean", not 'true'
    expect(featuresSchema.properties.auth).toEqual({ type: "boolean" });
    expect(featuresSchema.properties.api).toEqual({ type: "boolean" });
    expect(featuresSchema.properties.ui).toEqual({ type: "boolean" });
  });

  it("should generate correct schemas for Record<union, object>", async () => {
    const { type, checker, typeNode } = await getTypeFromCode(
      `interface Registry {
        handlers: Record<"create" | "update" | "delete", { enabled: boolean }>;
      }`,
      "Registry",
    );
    const schema = transformer(type, checker, typeNode);

    const handlersSchema = schema.properties!.handlers as any;
    expect(handlersSchema.type).toBe("object");

    // Each property should be an object with enabled: boolean
    expect(handlersSchema.properties.create).toEqual({
      type: "object",
      properties: {
        enabled: { type: "boolean" },
      },
      required: ["enabled"],
    });
    expect(handlersSchema.properties.update).toEqual({
      type: "object",
      properties: {
        enabled: { type: "boolean" },
      },
      required: ["enabled"],
    });
    expect(handlersSchema.properties.delete).toEqual({
      type: "object",
      properties: {
        enabled: { type: "boolean" },
      },
      required: ["enabled"],
    });
  });

  it("should handle nested Record types", async () => {
    const { type, checker, typeNode } = await getTypeFromCode(
      `interface Config {
        nested: Record<"outer", Record<"inner", string>>;
      }`,
      "Config",
    );
    const schema = transformer(type, checker, typeNode);

    const nestedSchema = schema.properties!.nested as any;
    expect(nestedSchema.type).toBe("object");
    expect(nestedSchema.properties.outer).toBeDefined();

    const outerSchema = nestedSchema.properties.outer;
    expect(outerSchema.type).toBe("object");
    expect(outerSchema.properties.inner).toEqual({ type: "string" });
  });

  it("should handle Partial<T> mapped type", async () => {
    const { type, checker, typeNode } = await getTypeFromCode(
      `type PartialConfig = Partial<{ name: string; age: number }>;`,
      "PartialConfig",
    );
    const schema = transformer(type, checker, typeNode);

    expect(schema.type).toBe("object");
    expect(schema.properties).toBeDefined();

    // Properties should have correct types, not 'true'
    expect(schema.properties!.name).toEqual({ type: "string" });
    expect(schema.properties!.age).toEqual({ type: "number" });

    // Partial makes everything optional
    expect(schema.required).toBeUndefined();
  });

  it("should handle Pick<T, K> mapped type", async () => {
    const { type, checker, typeNode } = await getTypeFromCode(
      `interface User { id: string; name: string; email: string; }
       type PickedUser = Pick<User, "id" | "name">;`,
      "PickedUser",
    );
    const schema = transformer(type, checker, typeNode);

    expect(schema.type).toBe("object");
    expect(schema.properties).toBeDefined();

    // Only picked properties should exist
    expect(schema.properties!.id).toEqual({ type: "string" });
    expect(schema.properties!.name).toEqual({ type: "string" });
    expect(schema.properties!.email).toBeUndefined();

    // Picked properties are required (unless original was optional)
    expect(schema.required).toEqual(["id", "name"]);
  });

  it("should handle Required<T> mapped type", async () => {
    const { type, checker, typeNode } = await getTypeFromCode(
      `type RequiredConfig = Required<{ name?: string; age?: number }>;`,
      "RequiredConfig",
    );
    const schema = transformer(type, checker, typeNode);

    expect(schema.type).toBe("object");

    // Properties should have correct types
    expect(schema.properties!.name).toEqual({ type: "string" });
    expect(schema.properties!.age).toEqual({ type: "number" });

    // Required makes everything required
    expect(schema.required).toEqual(["name", "age"]);
  });
});
