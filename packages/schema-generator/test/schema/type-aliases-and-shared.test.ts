import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createSchemaTransformerV2 } from "../../src/plugin.ts";
import { getTypeFromCode } from "../utils.ts";

describe("Schema: Type aliases and shared types", () => {
  it("handles basic Cell/Stream/Default aliases", async () => {
    const code = `
      interface Cell<T> { get(): T; set(v: T): void; }
      interface Stream<T> { subscribe(cb: (v:T) => void): void; }
      interface Default<T, V> {}
      type MyCell<T> = Cell<T>;
      type StringCell = Cell<string>;
      type MyStream<T> = Stream<T>;
      type WithDefault<T, V> = Default<T, V>;
      type CellArray<T> = Cell<T[]>;
      type StreamOfCells<T> = Stream<Cell<T>>;

      interface TypeAliasTest {
        genericCell: MyCell<string>;
        specificCell: StringCell;
        genericStream: MyStream<number>;
        withDefault: WithDefault<string, "hello">;
        cellOfArray: CellArray<number>;
        streamOfCells: StreamOfCells<string>;
        nestedAlias: MyCell<MyCell<string>[]>[];
      }
    `;
    const { type, checker } = await getTypeFromCode(code, "TypeAliasTest");
    const s = createSchemaTransformerV2()(type, checker);
    expect(s.properties?.genericCell?.type).toBe("string");
    expect(s.properties?.genericCell?.asCell).toBe(true);
    expect(s.properties?.specificCell?.type).toBe("string");
    expect(s.properties?.specificCell?.asCell).toBe(true);
    expect(s.properties?.genericStream?.type).toBe("number");
    expect(s.properties?.genericStream?.asStream).toBe(true);
    expect(s.properties?.withDefault?.type).toBe("string");
    expect(s.properties?.withDefault?.default).toBe("hello");
    const coa = s.properties?.cellOfArray as any;
    expect(coa.type).toBe("array");
    expect(coa.items?.type).toBe("number");
    expect(coa.asCell).toBe(true);
    const soc = s.properties?.streamOfCells as any;
    expect(soc.type).toBe("string");
    expect(soc.asStream).toBe(true);
    expect(soc.asCell).toBeUndefined();
    const na = s.properties?.nestedAlias as any;
    expect(na.type).toBe("array");
    expect(na.items?.type).toBe("array");
    expect(na.items?.items?.type).toBe("string");
  });

  it("duplicates shared object type structure where referenced twice", async () => {
    const code = `
      interface B { value: string; }
      interface A { b1: B; b2: B; }
    `;
    const { type, checker } = await getTypeFromCode(code, "A");
    const s = createSchemaTransformerV2()(type, checker);
    const b1 = s.properties?.b1 as any;
    const b2 = s.properties?.b2 as any;
    for (const bx of [b1, b2]) {
      expect(bx.type).toBe("object");
      expect(bx.properties?.value?.type).toBe("string");
      expect(bx.required).toContain("value");
    }
  });
});
