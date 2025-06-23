import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { checkWouldTransform, transformSource } from "./test-utils.ts";
import { cache } from "@commontools/static";

const commonToolsTypes = await cache.getText("types/commontools.d.ts");

describe("OpaqueRef Transformer", () => {
  const types = { "commontools.d.ts": commonToolsTypes };

  describe("Ternary Transformations", () => {
    it("transforms ternary with OpaqueRef condition", () => {
      const source = `
import { OpaqueRef, ifElse, cell } from "commontools";
const isActive = cell<boolean>(false);
const result = isActive ? "active" : "inactive";
`;
      const transformed = transformSource(source, { types });
      expect(transformed).toContain(
        'commontools_1.ifElse(isActive, "active", "inactive")',
      );
      expect(transformed).not.toContain('isActive ? "active" : "inactive"');
    });

    it("does not transform ternary with non-OpaqueRef condition", () => {
      const source = `
const isActive: boolean = true;
const result = isActive ? "active" : "inactive";
`;
      const transformed = transformSource(source, { types });
      expect(transformed).toContain('isActive ? "active" : "inactive"');
    });

    it("adds ifElse import when not present", () => {
      const source = `
import { OpaqueRef } from "commontools";
const isActive: OpaqueRef<boolean> = {} as any;
const result = isActive ? "active" : "inactive";
`;
      const transformed = transformSource(source, { types });
      expect(transformed).toContain(
        'import { OpaqueRef, ifElse } from "commontools"',
      );
    });
  });

  describe("Binary Expression Transformations", () => {
    it("transforms binary expressions with OpaqueRef", () => {
      const source = `
import { OpaqueRef, derive } from "commontools";
const count: OpaqueRef<number> = {} as any;
const result = count + 1;
`;
      const transformed = transformSource(source, { types });
      expect(transformed).toContain(
        "commontools_1.derive(count, _v1 => _v1 + 1)",
      );
      expect(transformed).not.toContain("count + 1");
    });

    it("transforms various binary operators", () => {
      const source = `
import { OpaqueRef, derive } from "commontools";
const num: OpaqueRef<number> = {} as any;
const a = num + 1;
const b = num - 1;
const c = num * 2;
const d = num / 2;
const e = num % 3;
`;
      const transformed = transformSource(source, { types });
      expect(transformed).toContain(
        "commontools_1.derive(num, _v1 => _v1 + 1)",
      );
      expect(transformed).toContain(
        "commontools_1.derive(num, _v1 => _v1 - 1)",
      );
      expect(transformed).toContain(
        "commontools_1.derive(num, _v1 => _v1 * 2)",
      );
      expect(transformed).toContain(
        "commontools_1.derive(num, _v1 => _v1 / 2)",
      );
      expect(transformed).toContain(
        "commontools_1.derive(num, _v1 => _v1 % 3)",
      );
    });

    it("does not transform binary expressions without OpaqueRef", () => {
      const source = `
const num: number = 5;
const result = num + 1;
`;
      const transformed = transformSource(source, { types });
      expect(transformed).toContain("num + 1");
      expect(transformed).not.toContain("derive");
    });
  });

  describe("JSX Expression Transformations", () => {
    it("transforms JSX expressions with OpaqueRef operations", () => {
      const source = `
import { OpaqueRef, derive, h } from "commontools";
const count: OpaqueRef<number> = {} as any;
const element = <div>{count + 1}</div>;
`;
      const transformed = transformSource(source, { types });
      expect(transformed).toContain(
        "{commontools_1.derive(count, _v1 => _v1 + 1)}",
      );
    });

    it("does not transform simple OpaqueRef references in JSX", () => {
      const source = `
import { OpaqueRef, h } from "commontools";
const count: OpaqueRef<number> = {} as any;
const element = <div>{count}</div>;
`;
      const transformed = transformSource(source, { types });
      expect(transformed).toContain("{count}");
      expect(transformed).not.toContain("derive");
    });

    it("transforms complex JSX expressions", () => {
      const source = `
import { OpaqueRef, derive, h } from "commontools";
const price: OpaqueRef<number> = {} as any;
const element = (
  <div>
    <p>Price: {price}</p>
    <p>With tax: {price * 1.1}</p>
    <p>Discount: {price - 10}</p>
  </div>
);
`;
      const transformed = transformSource(source, { types });
      expect(transformed).toContain("{price}");
      expect(transformed).toContain(
        "{commontools_1.derive(price, _v1 => _v1 * 1.1)}",
      );
      expect(transformed).toContain(
        "{commontools_1.derive(price, _v1 => _v1 - 10)}",
      );
    });
  });

  describe("Import Management", () => {
    it("adds derive import when needed", () => {
      const source = `
import { OpaqueRef } from "commontools";
const count: OpaqueRef<number> = {} as any;
const result = count + 1;
`;
      const transformed = transformSource(source, { types });
      expect(transformed).toContain(
        'import { OpaqueRef, derive } from "commontools"',
      );
    });

    it("does not duplicate existing imports", () => {
      const source = `
import { OpaqueRef, derive, ifElse } from "commontools";
const count: OpaqueRef<number> = {} as any;
const isActive: OpaqueRef<boolean> = {} as any;
const a = count + 1;
const b = isActive ? 1 : 0;
`;
      const transformed = transformSource(source, { types });
      // Should still have single import statement
      const importMatches = transformed.match(/import.*from "commontools"/g);
      expect(importMatches).toHaveLength(1);
      expect(transformed).toContain(
        'import { OpaqueRef, derive, ifElse } from "commontools"',
      );
    });
  });

  describe("Error Mode", () => {
    it("reports errors instead of transforming", () => {
      const source = `
import { OpaqueRef } from "commontools";
const count: OpaqueRef<number> = {} as any;
const result = count + 1;
`;

      expect(() => {
        transformSource(source, { mode: "error", types });
      }).toThrow(/Binary expression with OpaqueRef should use derive/);
    });

    it("reports multiple errors", () => {
      const source = `
import { OpaqueRef } from "commontools";
const count: OpaqueRef<number> = {} as any;
const isActive: OpaqueRef<boolean> = {} as any;
const a = count + 1;
const b = isActive ? 1 : 0;
`;

      expect(() => {
        transformSource(source, { mode: "error", types });
      }).toThrow(/OpaqueRef transformation errors/);
    });
  });

  describe("Debug Mode", () => {
    it("logs transformation details", () => {
      const logs: string[] = [];
      const source = `
import { OpaqueRef, derive } from "commontools";
const count: OpaqueRef<number> = {} as any;
const result = count + 1;
`;

      transformSource(source, {
        debug: true,
        types,
        logger: (msg) => logs.push(msg),
      });

      expect(logs.some((log) => log.includes("Found binary transformation")))
        .toBe(true);
      expect(logs.some((log) => log.includes("TRANSFORMED SOURCE"))).toBe(true);
    });
  });

  describe("checkWouldTransform utility", () => {
    it("returns true when transformation is needed", () => {
      const source = `
import { OpaqueRef } from "commontools";
const count: OpaqueRef<number> = {} as any;
const result = count + 1;
`;
      expect(checkWouldTransform(source, types)).toBe(true);
    });

    it("returns false when no transformation is needed", () => {
      const source = `
const count: number = 5;
const result = count + 1;
`;
      expect(checkWouldTransform(source, types)).toBe(false);
    });
  });

  describe("Edge Cases", () => {
    it("handles nested ternary expressions", () => {
      const source = `
import { OpaqueRef, ifElse } from "commontools";
const a: OpaqueRef<boolean> = {} as any;
const b: OpaqueRef<boolean> = {} as any;
const result = a ? (b ? 1 : 2) : 3;
`;
      const transformed = transformSource(source, { types });
      // The inner ternary is not transformed because it's not a direct child
      // It's inside the whenTrue parameter of the outer ifElse
      expect(transformed).toContain("commontools_1.ifElse(a, (b ? 1 : 2), 3)");
    });

    it("handles property access on OpaqueRef", () => {
      const source = `
import { OpaqueRef, derive } from "commontools";
interface User { age: number; }
const user: OpaqueRef<User> = {} as any;
const result = user.age + 1;
`;
      const transformed = transformSource(source, { types });
      // With our updated type definition, user.age is recognized as OpaqueRef<number>
      expect(transformed).toContain(
        "commontools_1.derive(user.age, _v1 => _v1 + 1)",
      );
    });

    it("handles string concatenation with OpaqueRef", () => {
      const source = `
import { OpaqueRef, derive } from "commontools";
const name: OpaqueRef<string> = {} as any;
const greeting = "Hello, " + name;
`;
      const transformed = transformSource(source, { types });
      expect(transformed).toContain(
        'commontools_1.derive(name, _v1 => "Hello, " + _v1)',
      );
    });

    it("handles multiple different OpaqueRefs in one expression", () => {
      const source = `
import { OpaqueRef, derive } from "commontools";
const count1: OpaqueRef<number> = {} as any;
const count2: OpaqueRef<number> = {} as any;
const sum = count1 + count2;
`;
      const transformed = transformSource(source, { types });
      // Should use object form: derive({count1, count2}, ({count1: _v1, count2: _v2}) => _v1 + _v2)
      expect(transformed).toContain(
        "commontools_1.derive({ count1, count2 }, ({ count1: _v1, count2: _v2 }) => _v1 + _v2)",
      );
    });

    it("handles multiple same OpaqueRefs in one expression", () => {
      const source = `
import { OpaqueRef, derive } from "commontools";
const count: OpaqueRef<number> = {} as any;
const double = count + count;
`;
      const transformed = transformSource(source, { types });
      // Should only pass count once: derive(count, _v1 => _v1 + _v1)
      expect(transformed).toContain(
        "commontools_1.derive(count, _v1 => _v1 + _v1)",
      );
    });

    it("handles complex expressions with multiple OpaqueRefs", () => {
      const source = `
import { OpaqueRef, derive } from "commontools";
const a: OpaqueRef<number> = {} as any;
const b: OpaqueRef<number> = {} as any;
const c: OpaqueRef<number> = {} as any;
const result = (a + b) * c;
`;
      const transformed = transformSource(source, { types });
      // Should handle all three refs
      expect(transformed).toContain(
        "commontools_1.derive({ a, b, c }, ({ a: _v1, b: _v2, c: _v3 }) => (_v1 + _v2) * _v3)",
      );
    });

    it("handles mixed OpaqueRef and regular values", () => {
      const source = `
import { OpaqueRef, derive } from "commontools";
const count: OpaqueRef<number> = {} as any;
const result = count + 10;
`;
      const transformed = transformSource(source, { types });
      expect(transformed).toContain(
        "commontools_1.derive(count, _v1 => _v1 + 10)",
      );
    });
  });
});
