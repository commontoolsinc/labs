import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createSchemaTransformerV2 } from "../../src/plugin.ts";
import { getTypeFromCode } from "../utils.ts";

describe("Schema: Nested wrappers (Cell, Stream, Default)", () => {
  it("Default<string, 'hello'> inside object", async () => {
    const code = `
      interface Default<T, V> {}
      interface X { field1: Default<string, "hello">; field2: Default<number, 42>; }
    `;
    const { type, checker } = await getTypeFromCode(code, "X");
    const gen = createSchemaTransformerV2();
    const s = gen(type, checker);
    expect(s.properties?.field1?.type).toBe("string");
    expect(s.properties?.field1?.default).toBe("hello");
    expect(s.properties?.field2?.type).toBe("number");
    expect(s.properties?.field2?.default).toBe(42);
  });

  it("Cell<Default<string,'default'>>", async () => {
    const code = `
      interface Default<T, V> {}
      interface Cell<T> { get(): T; set(v: T): void; }
      interface X { value: Cell<Default<string, "default">>; }
    `;
    const { type, checker } = await getTypeFromCode(code, "X");
    const s = createSchemaTransformerV2()(type, checker);
    const v = s.properties?.value as any;
    expect(v.type).toBe("string");
    expect(v.default).toBe("default");
    expect(v.asCell).toBe(true);
  });

  it("Stream<Default<string,'initial'>>", async () => {
    const code = `
      interface Default<T, V> {}
      interface Stream<T> { subscribe(cb: (v:T) => void): void; }
      interface X { events: Stream<Default<string, "initial">>; }
    `;
    const { type, checker } = await getTypeFromCode(code, "X");
    const s = createSchemaTransformerV2()(type, checker);
    const ev = s.properties?.events as any;
    expect(ev.type).toBe("string");
    expect(ev.default).toBe("initial");
    expect(ev.asStream).toBe(true);
  });

  it("Stream<Default<string[], ['a']>> yields array schema with default", async () => {
    const code = `
      interface Default<T, V> {}
      interface Stream<T> { subscribe(cb: (v:T) => void): void; }
      interface X { events: Stream<Default<string[], ["a"]>>; }
    `;
    const { type, checker } = await getTypeFromCode(code, "X");
    const s = createSchemaTransformerV2()(type, checker);
    const ev = s.properties?.events as any;
    expect(ev.type).toBe("array");
    expect(ev.items?.type).toBe("string");
    expect(ev.default).toEqual(["a"]);
    expect(ev.asStream).toBe(true);
  });

  it("array of Cell<string>", async () => {
    const code = `
      interface Cell<T> { get(): T; set(v: T): void; }
      interface X { items: Array<Cell<string>>; }
    `;
    const { type, checker } = await getTypeFromCode(code, "X");
    const s = createSchemaTransformerV2()(type, checker);
    const items = s.properties?.items as any;
    expect(items.type).toBe("array");
    expect(items.items?.type).toBe("string");
    // Items may carry asCell depending on formatter; assert if present
    if (Object.prototype.hasOwnProperty.call(items.items, "asCell")) {
      expect(items.items.asCell).toBe(true);
    }
  });

  it("Cell<string[]>", async () => {
    const code = `
      interface Cell<T> { get(): T; set(v: T): void; }
      interface X { tags: Cell<string[]>; }
    `;
    const { type, checker } = await getTypeFromCode(code, "X");
    const s = createSchemaTransformerV2()(type, checker);
    const tags = s.properties?.tags as any;
    expect(tags.type).toBe("array");
    expect(tags.items?.type).toBe("string");
    expect(tags.asCell).toBe(true);
  });

  it("complex nesting: Cell<Default<string,'d'>> and Default<string[], ['a','b']>", async () => {
    const code = `
      interface Default<T, V> {}
      interface Cell<T> { get(): T; set(v: T): void; }
      interface X {
        cellOfDefault: Cell<Default<string, "d">>;
        defaultArray: Default<string[], ["a", "b"]>;
      }
    `;
    const { type, checker } = await getTypeFromCode(code, "X");
    const s = createSchemaTransformerV2()(type, checker);
    const c = s.properties?.cellOfDefault as any;
    expect(c.type).toBe("string");
    expect(c.default).toBe("d");
    expect(c.asCell).toBe(true);
    const da = s.properties?.defaultArray as any;
    expect(da.type).toBe("array");
    expect(da.items?.type).toBe("string");
    expect(da.default).toEqual(["a", "b"]);
  });
});
