import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { checkStderr, ct } from "./utils.ts";

describe("cli test", () => {
  it("runs a test pattern with an explicit memory version", async () => {
    const { code, stdout, stderr } = await ct(
      "test fixtures/test-memory-version.test.tsx --memory-version v1 --verbose",
    );
    checkStderr(stderr);
    expect(stdout).toContain("Found 1 test file(s)");
    expect(
      stdout.some((line) => line.includes("Storage backend: v1")),
    ).toBe(true);
    expect(stdout.some((line) => line.includes("1 passed, 0 failed"))).toBe(
      true,
    );
    expect(code).toBe(0);
  });
});
