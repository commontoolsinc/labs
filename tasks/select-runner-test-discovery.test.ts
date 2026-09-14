import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { dirname, join } from "@std/path";
import {
  listRunnerTests,
  selectRunnerTestFiles,
} from "./select-runner-test-files.ts";

describe("runner test discovery", () => {
  it("assigns every TypeScript and TSX package test across directory depths", async () => {
    const root = await Deno.makeTempDir({ prefix: "runner-test-discovery-" });
    const expected = [
      "nested/deep/child.test.tsx",
      "nested/first.test.ts",
      "nested/second.test.tsx",
      "root.test.ts",
      "view.test.tsx",
    ];
    const ignored = [
      "helper.ts",
      "nested/other_test.ts",
      "nested/other.test.js",
      "nested/other.bench.ts",
      "test.ts",
    ];
    try {
      for (const name of [...expected, ...ignored]) {
        const file = join(root, name);
        await Deno.mkdir(dirname(file), { recursive: true });
        await Deno.writeTextFile(file, "");
      }
      const files = await listRunnerTests(root);
      expect(files.map(({ name }) => name)).toEqual(expected);

      const selected = [1, 2, 3].flatMap((index) =>
        selectRunnerTestFiles(files, { index, total: 3 }, {})
      );
      expect(selected.sort()).toEqual(expected);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });
});
