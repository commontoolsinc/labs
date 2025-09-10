import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createSchemaTransformerV2 } from "../../src/plugin.ts";
import { getTypeFromCode } from "../utils.ts";

describe("Schema: Cell types", () => {
  it("handles Cell<string>", async () => {
    const code = `
      interface Cell<T> { get(): T; set(value: T): void; }
      interface X { name: Cell<string>; }
    `;
    const { type, checker } = await getTypeFromCode(code, "X");
    const gen = createSchemaTransformerV2();
    const result = gen(type, checker);
    const name = result.properties?.name as Record<string, unknown>;
    expect(name).toBeDefined();
    expect(name.type).toBe("string");
    expect(name.asCell).toBe(true);
    expect(result.required).toContain("name");
  });

  it("handles Cell<Array<{id:string}>>", async () => {
    const code = `
      interface Cell<T> { get(): T; set(value: T): void; }
      interface X { users: Cell<Array<{ id: string }>>; }
    `;
    const { type, checker } = await getTypeFromCode(code, "X");
    const gen = createSchemaTransformerV2();
    const result = gen(type, checker);
    const users = result.properties?.users as Record<string, any>;
    expect(users).toBeDefined();
    expect(users.type).toBe("array");
    expect(users.items?.type).toBe("object");
    expect(users.items?.properties?.id?.type).toBe("string");
    expect(users.asCell).toBe(true);
  });

  it("handles Stream<Cell<number>>", async () => {
    const code = `
      interface Cell<T> { get(): T; set(value: T): void; }
      interface Stream<T> { subscribe(cb: (v: T) => void): void; }
      interface X { value: Stream<Cell<number>>; }
    `;
    const { type, checker } = await getTypeFromCode(code, "X");
    const gen = createSchemaTransformerV2();
    const result = gen(type, checker);
    const prop = result.properties?.value as Record<string, unknown>;
    expect(prop).toBeDefined();
    expect(prop.type).toBe("number");
    expect(prop.asStream).toBe(true);
    // No asCell marker for inner Cell when wrapped in Stream
    expect((prop as any).asCell).toBeUndefined();
  });

  it("disallows Cell<Stream<T>> and suggests boxing", async () => {
    const code = `
      interface Cell<T> { get(): T; set(value: T): void; }
      interface Stream<T> { subscribe(cb: (v: T) => void): void; }
      interface X { invalid: Cell<Stream<number>>; }
    `;
    const { type, checker } = await getTypeFromCode(code, "X");
    const gen = createSchemaTransformerV2();
    expect(() => gen(type, checker)).toThrow(
      "Cell<Stream<T>> is unsupported. Wrap the stream: Cell<{ stream: Stream<T> }>",
    );
  });
});
