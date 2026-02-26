import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createSchemaTransformerV2 } from "../src/plugin.ts";
import { asObjectSchema, getTypeFromCode } from "./utils.ts";

describe("IntersectionFormatter", () => {
  const transformer = createSchemaTransformerV2();

  describe("successful intersections", () => {
    it("should merge simple object intersection", async () => {
      const code = `
        interface ItemBase {
          text: string;
        }
        
        interface WithIndex {
          index: number;
        }
        
        type ItemWithIndex = ItemBase & WithIndex;
      `;
      const { type, checker } = await getTypeFromCode(code, "ItemWithIndex");
      const schema = asObjectSchema(transformer.generateSchema(type, checker));

      expect(schema.type).toBe("object");
      expect(schema.properties?.text).toEqual({ type: "string" });
      expect(schema.properties?.index).toEqual({ type: "number" });
      expect(schema.required).toEqual(["text", "index"]);
    });

    it("should merge complex nested intersection", async () => {
      const code = `
        interface Item {
          text: string;
        }
        
        interface ListState {
          items: Item[];
        }
        
        type ListStateWithIndex = ListState & {
          index: number;
        };
      `;
      const { type, checker } = await getTypeFromCode(
        code,
        "ListStateWithIndex",
      );
      const schema = asObjectSchema(transformer.generateSchema(type, checker));

      expect(schema.type).toBe("object");
      const items = schema.properties?.items as any;
      expect(items?.type).toBe("array");
      expect(schema.properties?.index).toEqual({ type: "number" });
      expect(schema.required).toEqual(["items", "index"]);
    });

    it("should handle optional properties in intersection", async () => {
      const code = `
        interface RequiredFields {
          name: string;
        }
        
        interface OptionalFields {
          description?: string;
        }
        
        type Combined = RequiredFields & OptionalFields;
      `;
      const { type, checker } = await getTypeFromCode(code, "Combined");
      const schema = asObjectSchema(transformer.generateSchema(type, checker));

      expect(schema.type).toBe("object");
      expect(schema.properties?.name).toEqual({ type: "string" });
      expect(schema.properties?.description).toEqual({ type: "string" });
      expect(schema.required).toEqual(["name"]); // Only required properties
    });
  });

  describe("intersections with call/construct signatures", () => {
    it("should merge intersection with call signature", async () => {
      const code = `
        interface Base {
          name: string;
        }
        
        interface WithCallSig {
          (): void;
          prop: number;
        }
        
        type IntersectionWithCall = Base & WithCallSig;
      `;
      const { type, checker } = await getTypeFromCode(
        code,
        "IntersectionWithCall",
      );
      const schema = asObjectSchema(transformer.generateSchema(type, checker));

      expect(schema.type).toBe("object");
      expect(schema.properties?.name).toEqual({ type: "string" });
      expect(schema.properties?.prop).toEqual({ type: "number" });
      expect(schema.required).toEqual(["name", "prop"]);
      // Call signature is ignored (can't be represented in JSON Schema)
    });

    it("should merge intersection with construct signature", async () => {
      const code = `
        interface Base {
          name: string;
        }
        
        interface WithConstructSig {
          new (): string;
          prop: number;
        }
        
        type IntersectionWithConstruct = Base & WithConstructSig;
      `;
      const { type, checker } = await getTypeFromCode(
        code,
        "IntersectionWithConstruct",
      );
      const schema = asObjectSchema(transformer.generateSchema(type, checker));

      expect(schema.type).toBe("object");
      expect(schema.properties?.name).toEqual({ type: "string" });
      expect(schema.properties?.prop).toEqual({ type: "number" });
      expect(schema.required).toEqual(["name", "prop"]);
      // Construct signature is ignored (can't be represented in JSON Schema)
    });
  });

  describe("unsupported intersections", () => {
    it("should reject intersection with index signature", async () => {
      const code = `
        interface Base {
          name: string;
        }
        
        interface WithIndex {
          [key: string]: unknown;
        }
        
        type BadIntersection = Base & WithIndex;
      `;
      const { type, checker } = await getTypeFromCode(code, "BadIntersection");
      const schema = asObjectSchema(transformer.generateSchema(type, checker));

      expect(schema.type).toBe("object");
      expect(schema.additionalProperties).toBe(true);
      expect(schema.$comment).toContain("index signature on constituent");
    });

    it("should reject intersection with non-object types", async () => {
      const code = `
        interface Base {
          name: string;
        }
        
        type BadIntersection = Base & string;
      `;
      const { type, checker } = await getTypeFromCode(code, "BadIntersection");
      const schema = asObjectSchema(transformer.generateSchema(type, checker));

      expect(schema.type).toBe("object");
      expect(schema.additionalProperties).toBe(true);
      expect(schema.$comment).toContain("non-object constituent");
    });
  });

  describe("isBrandOnlyOrEmpty filtering", () => {
    it("should filter out empty object {} from intersection, yielding the remaining part", async () => {
      const code = `
        type Result = { name: string } & {};
      `;
      const { type, checker } = await getTypeFromCode(code, "Result");
      const schema = asObjectSchema(transformer.generateSchema(type, checker));

      expect(schema.type).toBe("object");
      expect(schema.properties?.name).toEqual({ type: "string" });
      expect(schema.required).toEqual(["name"]);
      // Not rejected as unsupported
      expect(schema.additionalProperties).toBeUndefined();
    });

    it("should filter out a brand-only (symbol-keyed) type from intersection", async () => {
      const code = `
        declare const MY_BRAND: unique symbol;
        type BrandOnly = { readonly [MY_BRAND]: true };
        type Result = { name: string } & BrandOnly;
      `;
      const { type, checker } = await getTypeFromCode(code, "Result");
      const schema = asObjectSchema(transformer.generateSchema(type, checker));

      expect(schema.type).toBe("object");
      expect(schema.properties?.name).toEqual({ type: "string" });
      expect(schema.required).toEqual(["name"]);
      expect(schema.additionalProperties).toBeUndefined();
    });

    it("should filter brand-only part from a multi-constituent intersection", async () => {
      const code = `
        declare const MY_BRAND: unique symbol;
        type Brand = { readonly [MY_BRAND]: string };
        type Result = { a: string } & { b: number } & Brand;
      `;
      const { type, checker } = await getTypeFromCode(code, "Result");
      const schema = asObjectSchema(transformer.generateSchema(type, checker));

      expect(schema.type).toBe("object");
      expect(schema.properties?.a).toEqual({ type: "string" });
      expect(schema.properties?.b).toEqual({ type: "number" });
      expect(schema.required).toContain("a");
      expect(schema.required).toContain("b");
      expect(schema.additionalProperties).toBeUndefined();
    });

    it("should filter empty {} but keep non-empty constituent in primitive-array intersection", async () => {
      const code = `
        type Result = number[] & {};
      `;
      const { type, checker } = await getTypeFromCode(code, "Result");
      const schema = asObjectSchema(transformer.generateSchema(type, checker));

      expect(schema.type).toBe("array");
      expect(schema.additionalProperties).toBeUndefined();
    });

    it("should NOT filter an object that has string-keyed properties alongside symbol keys", async () => {
      // An object with a regular string-keyed property is not brand-only, so it
      // participates in the intersection merge as a normal constituent.
      const code = `
        declare const MY_BRAND: unique symbol;
        type Mixed = { value: number; readonly [MY_BRAND]: boolean };
        type Result = { name: string } & Mixed;
      `;
      const { type, checker } = await getTypeFromCode(code, "Result");
      const schema = asObjectSchema(transformer.generateSchema(type, checker));

      expect(schema.type).toBe("object");
      expect(schema.properties?.name).toEqual({ type: "string" });
      expect(schema.properties?.value).toEqual({ type: "number" });
      expect(schema.required).toContain("name");
      expect(schema.required).toContain("value");
    });

    it("should NOT filter an object with a string index signature", async () => {
      // An object with an index signature is NOT brand-only; isBrandOnlyOrEmpty
      // returns false, so it reaches validateIntersectionParts which rejects it.
      const code = `
        interface Base { name: string }
        interface WithIndex { [key: string]: unknown }
        type Result = Base & WithIndex;
      `;
      const { type, checker } = await getTypeFromCode(code, "Result");
      const schema = asObjectSchema(transformer.generateSchema(type, checker));

      expect(schema.additionalProperties).toBe(true);
      expect(schema.$comment).toContain("index signature on constituent");
    });

    it("should fall back to full parts when all constituents are brand-only", async () => {
      // Defensive: if every part is brand-only, fall back to using all parts so
      // formatType does not throw on the empty-parts path.
      const code = `
        declare const B1: unique symbol;
        declare const B2: unique symbol;
        type AllBrands = { readonly [B1]: string } & { readonly [B2]: number };
      `;
      const { type, checker } = await getTypeFromCode(code, "AllBrands");
      // Should not throw
      const schema = transformer.generateSchema(type, checker);
      expect(schema).toBeDefined();
    });
  });

  describe("edge cases", () => {
    it("should handle multiple interfaces with overlapping properties", async () => {
      const code = `
        interface A {
          shared: string;
          a: number;
        }
        
        interface B {
          shared: string; // Same type, should not conflict
          b: boolean;
        }
        
        type Combined = A & B;
      `;
      const { type, checker } = await getTypeFromCode(code, "Combined");
      const schema = asObjectSchema(transformer.generateSchema(type, checker));

      expect(schema.type).toBe("object");
      expect(schema.properties?.shared).toEqual({ type: "string" });
      expect(schema.properties?.a).toEqual({ type: "number" });
      expect(schema.properties?.b).toEqual({ type: "boolean" });
      expect(schema.required).toEqual(["shared", "a", "b"]);
    });

    it("should handle three-way intersection", async () => {
      const code = `
        interface A {
          a: string;
        }
        
        interface B {
          b: number;
        }
        
        interface C {
          c: boolean;
        }
        
        type Triple = A & B & C;
      `;
      const { type, checker } = await getTypeFromCode(code, "Triple");
      const schema = asObjectSchema(transformer.generateSchema(type, checker));

      expect(schema.type).toBe("object");
      expect(schema.properties?.a).toEqual({ type: "string" });
      expect(schema.properties?.b).toEqual({ type: "number" });
      expect(schema.properties?.c).toEqual({ type: "boolean" });
      expect(schema.required).toEqual(["a", "b", "c"]);
    });
  });
});
