import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { emitRuntimeCode } from "./verify-runtime-bytes.ts";

describe("verify-runtime-bytes", () => {
  it("rejects invalid syntax before producing comparison evidence", () => {
    expect(() => emitRuntimeCode("export const broken = ;", "broken.ts"))
      .toThrow("Expression expected");
  });

  it("ignores comments and types while retaining runtime changes", () => {
    const before = emitRuntimeCode("export const value: number = 3;", "a.ts");
    const comments = emitRuntimeCode(
      "/** A value. */\nexport const value = 3;",
      "b.ts",
    );
    const changed = emitRuntimeCode("export const value = 4;", "c.ts");
    expect(comments).toBe(before);
    expect(changed).not.toBe(before);
  });
});
