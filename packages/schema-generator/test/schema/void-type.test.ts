import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createSchemaTransformerV2 } from "../../src/plugin.ts";
import { asObjectSchema, getTypeFromCode } from "../utils.ts";

describe("Schema: void types", () => {
  it("formats a resolved void type as opaque", async () => {
    const code = `
      type X = void;
    `;
    const { type, checker, typeNode } = await getTypeFromCode(code, "X");
    const gen = createSchemaTransformerV2();
    const result = asObjectSchema(gen.generateSchema(type, checker, typeNode));
    expect(result).toEqual({ asCell: ["opaque"] });
  });

  it("formats Stream<void> as an opaque stream", async () => {
    const code = `
      interface X {
        trigger: Stream<void>;
      }
    `;
    const { type, checker } = await getTypeFromCode(code, "X");
    const gen = createSchemaTransformerV2();
    const result = asObjectSchema(gen.generateSchema(type, checker));
    const trigger = result.properties?.trigger as Record<string, unknown>;
    expect(trigger).toEqual({
      asCell: ["stream", "opaque"],
      // The value-less verb's declared-result schema (C3): the empty-object
      // receipt, NOT the void sentinel — `{ asCell: ["opaque"] }` would be a
      // wrapper claim about a result that does not exist.
      result: { type: "object", properties: {} },
    });
  });

  it("formats void interface properties as opaque", async () => {
    const code = `
      interface X {
        input: void;
      }
    `;
    const { type, checker } = await getTypeFromCode(code, "X");
    const gen = createSchemaTransformerV2();
    const result = asObjectSchema(gen.generateSchema(type, checker));
    const input = result.properties?.input as Record<string, unknown>;
    expect(input).toEqual({ asCell: ["opaque"] });
  });
});
