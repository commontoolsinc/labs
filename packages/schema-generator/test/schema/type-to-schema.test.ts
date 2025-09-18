import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createSchemaTransformerV2 } from "../../src/plugin.ts";
import { getTypeFromCode } from "../utils.ts";

describe("Schema: type-to-schema parity", () => {
  it("generates schemas for inputs/outputs structures", async () => {
    const code = `
      interface Cell<T> { get(): T; set(v: T): void; }
      interface Stream<T> { subscribe(cb: (v:T)=>void): void }

      interface UpdaterInput { newValues: string[]; }
      interface RecipeInput { values: Cell<string[]>; }
      interface RecipeOutput { values: string[]; updater: Stream<UpdaterInput>; }
    `;
    const { type: uType, checker: uChecker, typeNode: uNode } =
      await getTypeFromCode(code, "UpdaterInput");
    const { type: iType, checker: iChecker, typeNode: iNode } =
      await getTypeFromCode(code, "RecipeInput");
    const { type: oType, checker: oChecker, typeNode: oNode } =
      await getTypeFromCode(code, "RecipeOutput");
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
    const upd = o.properties?.updater as any;
    expect(upd.asStream).toBe(true);
    expect(upd.$ref).toBe("#/definitions/UpdaterInput");
    const defU = (o as any).definitions?.UpdaterInput as any;
    expect(defU.type).toBe("object");
    expect(defU.properties?.newValues?.type).toBe("array");
    expect(defU.properties?.newValues?.items?.type).toBe("string");
  });

  it("handles nested objects with string and number unions", async () => {
    const code = `
      interface UserInfo {
        profile: {
          name: string;
          email?: string;
        };
        status: "active" | "inactive" | "pending";
        level: 1 | 2 | 3;
      }
    `;

    const { type, checker } = await getTypeFromCode(code, "UserInfo");
    const schema = createSchemaTransformerV2()(type, checker);

    expect(schema.type).toBe("object");
    const profile = schema.properties?.profile as Record<string, any>;
    expect(profile?.type).toBe("object");
    const profileProps = profile?.properties as Record<string, any>;
    expect(profileProps?.name?.type).toBe("string");
    expect(profile.required).toContain("name");
    expect(profile.required).not.toContain("email");

    const status = schema.properties?.status as Record<string, unknown>;
    expect(status?.enum).toEqual(["active", "inactive", "pending"]);

    const level = schema.properties?.level as Record<string, unknown>;
    expect(level?.enum).toEqual([1, 2, 3]);
  });
});
