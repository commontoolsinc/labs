import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { ContextualFlowControl } from "../src/cfc.ts";
import type { JSONSchema } from "../src/builder/types.ts";

describe("ContextualFlowControl.schemaAtPath array index validation", () => {
  it("rejects leading-zero array index like '01'", () => {
    const cfc = new ContextualFlowControl();

    const schema: JSONSchema = {
      type: "array",
      items: { type: "string" },
    };

    // "01" is not a valid array index (leading zero), should return false
    const result01 = cfc.schemaAtPath(schema, ["01"]);
    // "1" is a valid array index, should return the items schema
    const result1 = cfc.schemaAtPath(schema, ["1"]);

    expect(result01).toBe(false);
    expect(result1).toEqual({ type: "string" });
  });
});
