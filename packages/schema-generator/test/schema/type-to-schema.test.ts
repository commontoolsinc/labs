import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createSchemaTransformerV2 } from "../../src/plugin.ts";
import { getTypeFromCode } from "../utils.ts";

describe("Schema: type-to-schema parity", () => {
  it("generates schemas for inputs/outputs structures", () => {
    const code = `
      interface Cell<T> { get(): T; set(v: T): void; }
      interface Stream<T> { subscribe(cb: (v:T)=>void): void }

      interface UpdaterInput { newValues: string[]; }
      interface RecipeInput { values: Cell<string[]>; }
      interface RecipeOutput { values: string[]; updater: Stream<UpdaterInput>; }
    `;
    const { type: uType, checker: uChecker, typeNode: uNode } = getTypeFromCode(code, "UpdaterInput");
    const { type: iType, checker: iChecker, typeNode: iNode } = getTypeFromCode(code, "RecipeInput");
    const { type: oType, checker: oChecker, typeNode: oNode } = getTypeFromCode(code, "RecipeOutput");
    const gen = createSchemaTransformerV2();
    const u = gen(uType, uChecker, uNode);
    const i = gen(iType, iChecker, iNode);
    const o = gen(oType, oChecker, oNode);
    // UpdaterInput
    expect(u.type).toBe("object");
    expect(u.properties?.newValues?.type).toBe("array");
    expect(u.properties?.newValues?.items?.type).toBe("string");
    // RecipeInput
    expect(i.properties?.values?.asCell).toBe(true);
    expect(i.properties?.values?.type).toBe("array");
    expect(i.properties?.values?.items?.type).toBe("string");
    // RecipeOutput
    expect(o.properties?.values?.type).toBe("array");
    expect(o.properties?.values?.items?.type).toBe("string");
    expect(o.properties?.updater?.type).toBe("object");
    expect(o.properties?.updater?.asStream).toBe(true);
  });
});
