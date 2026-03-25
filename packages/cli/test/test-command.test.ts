import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join } from "@std/path";
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

  it("keeps notebook pattern tests stable under concurrent ct test runs", async () => {
    const notebookTestPath = join(
      import.meta.dirname!,
      "..",
      "..",
      "patterns",
      "notes",
      "notebook.test.tsx",
    );
    const patternsRoot = join(
      import.meta.dirname!,
      "..",
      "..",
      "patterns",
    );

    const command =
      `test --timeout 180000 --root ${patternsRoot} ${notebookTestPath}`;

    for (let round = 0; round < 2; round++) {
      const results = await Promise.all([
        ct(command),
        ct(command),
        ct(command),
        ct(command),
      ]);

      for (const result of results) {
        checkStderr(result.stderr);
        expect(result.code).toBe(0);
        expect(
          result.stdout.some((line) => line.includes("28 passed, 0 failed")),
        ).toBe(true);
      }
    }
  });
});
