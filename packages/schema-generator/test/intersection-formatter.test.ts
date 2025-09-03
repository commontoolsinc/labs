import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createSchemaTransformerV2 } from "../src/plugin.ts";
import { getTypeFromCode } from "./utils.ts";

describe("IntersectionFormatter", () => {
  const transformer = createSchemaTransformerV2();

  describe("successful intersections", () => {
    it("should merge simple object intersection", () => {
      const code = `
        interface ItemBase {
          text: string;
        }
        
        interface WithIndex {
          index: number;
        }
        
        type ItemWithIndex = ItemBase & WithIndex;
      `;
      const { type, checker } = getTypeFromCode(code, "ItemWithIndex");
      const schema = transformer(type, checker);

      expect(schema.type).toBe("object");
      expect(schema.properties?.text).toEqual({ type: "string" });
      expect(schema.properties?.index).toEqual({ type: "number" });
      expect(schema.required).toEqual(["text", "index"]);
    });

    it("should merge complex nested intersection", () => {
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
      const { type, checker } = getTypeFromCode(code, "ListStateWithIndex");
      const schema = transformer(type, checker);

      expect(schema.type).toBe("object");
      expect(schema.properties?.items?.type).toBe("array");
      expect(schema.properties?.index).toEqual({ type: "number" });
      expect(schema.required).toEqual(["items", "index"]);
    });

    it("should handle optional properties in intersection", () => {
      const code = `
        interface Required {
          name: string;
        }
        
        interface Optional {
          description?: string;
        }
        
        type Combined = Required & Optional;
      `;
      const { type, checker } = getTypeFromCode(code, "Combined");
      const schema = transformer(type, checker);

      expect(schema.type).toBe("object");
      expect(schema.properties?.name).toEqual({ type: "string" });
      expect(schema.properties?.description).toEqual({ type: "string" });
      expect(schema.required).toEqual(["name"]); // Only required properties
    });
  });

  describe("unsupported intersections", () => {
    it("should reject intersection with index signature", () => {
      const code = `
        interface Base {
          name: string;
        }
        
        interface WithIndex {
          [key: string]: unknown;
        }
        
        type BadIntersection = Base & WithIndex;
      `;
      const { type, checker } = getTypeFromCode(code, "BadIntersection");
      const schema = transformer(type, checker);

      expect(schema.type).toBe("object");
      expect(schema.additionalProperties).toBe(true);
      expect(schema.$comment).toContain("index signature on constituent");
    });

    it("should reject intersection with call signature", () => {
      const code = `
        interface Base {
          name: string;
        }
        
        interface WithCallSig {
          (): void;
          prop: number;
        }
        
        type BadIntersection = Base & WithCallSig;
      `;
      const { type, checker } = getTypeFromCode(code, "BadIntersection");
      const schema = transformer(type, checker);

      expect(schema.type).toBe("object");
      expect(schema.additionalProperties).toBe(true);
      expect(schema.$comment).toContain("call/construct signatures on constituent");
    });

    it("should reject intersection with non-object types", () => {
      const code = `
        interface Base {
          name: string;
        }
        
        type BadIntersection = Base & string;
      `;
      const { type, checker } = getTypeFromCode(code, "BadIntersection");
      const schema = transformer(type, checker);

      expect(schema.type).toBe("object");
      expect(schema.additionalProperties).toBe(true);
      expect(schema.$comment).toContain("non-object constituent");
    });
  });

  describe("edge cases", () => {
    it("should handle multiple interfaces with overlapping properties", () => {
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
      const { type, checker } = getTypeFromCode(code, "Combined");
      const schema = transformer(type, checker);

      expect(schema.type).toBe("object");
      expect(schema.properties?.shared).toEqual({ type: "string" });
      expect(schema.properties?.a).toEqual({ type: "number" });
      expect(schema.properties?.b).toEqual({ type: "boolean" });
      expect(schema.required).toEqual(["shared", "a", "b"]);
    });

    it("should handle three-way intersection", () => {
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
      const { type, checker } = getTypeFromCode(code, "Triple");
      const schema = transformer(type, checker);

      expect(schema.type).toBe("object");
      expect(schema.properties?.a).toEqual({ type: "string" });
      expect(schema.properties?.b).toEqual({ type: "number" });
      expect(schema.properties?.c).toEqual({ type: "boolean" });
      expect(schema.required).toEqual(["a", "b", "c"]);
    });
  });
});